// src/routes/community.ts
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { getIO } from "../socket";
import {
  createProjectRepos,
  dispatchVerifyWorkflow,
  ensureRepoMemberForRepo,
  inviteUserToRepoForRepo,
  isGithubIntegrationPermissionError,
} from "../services/communityRepo";

import { getOctokitForEmail } from "../services/github";
import {
  buildChecklistFromSpec,
  buildTaskBranchName,
  generateVerificationSpec,
  fetchVerificationSpec,
  ensureVerificationFilesInBranch,
  pollOrFetchLatestRun,
  triggerWorkflow,
} from "../services/verificationSpec";
import { normalizeProjectStack, ProjectStack } from "../models/stack";

export type ColumnId = "todo" | "doing" | "review" | "done";

export type TaskCategory =
  | "ARCHITECTURE"
  | "MODEL"
  | "SERVICE"
  | "VIEW"
  | "INFRA"
  | "QA";

export type TaskStatus = "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "REJECTED";
export type VerificationStatus = "NOT_SUBMITTED" | "SUBMITTED" | "APPROVED" | "REJECTED";

export type RepoCheckStatus = "IDLE" | "PENDING" | "PASSED" | "FAILED";

export type ChecklistStatus = "PENDING" | "PASSED" | "FAILED";
export type ChecklistItem = {
  key: string;
  text: string;
  status: ChecklistStatus;
  details?: string;
};

export type TaskRepo = {
  provider?: "github";
  repoFullName?: string;
  prNumber?: number;
  branch?: string;
  checks?: {
    status?: RepoCheckStatus;
    lastRunUrl?: string;
    lastRunConclusion?: string | null;
  };
};
export type RepoType = "backend" | "frontend" | "contracts";
type RepoAccessError = {
  error: "repo_access_required";
  state?: "NONE" | "INVITED" | "ACTIVE";
  repoUrl?: string;
  repoType?: RepoType | "mono";
  repoFullName?: string;
};

type ApiError = { error: string };


export type TaskVerification = {
  status: VerificationStatus;
  notes?: string;
};

export interface BoardTask {
  id: string;
  title: string;
  description: string;
  price: number;
  priority: number;
  layer: TaskCategory;
  columnId: ColumnId;
  assigneeEmail?: string | null;
  assigneeAvatar?: string | null;

  status?: TaskStatus;
  verificationStatus?: VerificationStatus;
  verification?: TaskVerification;
  repo?: TaskRepo | null;
  repoType?: RepoType;
  acceptanceCriteria?: string;
  verificationNotes?: string;
  checklist?: ChecklistItem[];
}

const router = express.Router();

const BOARD_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: "todo", title: "Por hacer", order: 1 },
  { id: "doing", title: "Haciendo", order: 2 },
  { id: "review", title: "Revisión", order: 3 },
  { id: "done", title: "Hecho", order: 4 },
];

const MAX_DOING_PER_USER = 2;
const WEB3_KEYWORDS = ["web3", "solidity", "hardhat", "smart contract", "contract"];

type ProjectRepoEntry = {
  type: RepoType | "mono";
  fullName: string;
  htmlUrl?: string;
  name?: string;
};

const mapRepoErrorToResponse = (error: any, res: Response<any>) => {
  const code = error?.code || error?.message;

  if (code === "github_permissions_missing" || isGithubIntegrationPermissionError(error)) {
    res.status(500).json({ error: "github_permissions_missing" });
    return true;
  }

  if (code === "github_not_connected_owner") {
    res.status(400).json({ error: "github_not_connected_owner" });
    return true;
  }

  if (code === "github_account_not_found") {
    res.status(400).json({ error: "github_account_not_found" });
    return true;
  }

  if (code === "community_project_not_found") {
    res.status(404).json({ error: "Proyecto de comunidad no encontrado" });
    return true;
  }

  if (code === "project_repo_missing" || code === "invalid_project_repo") {
    res.status(400).json({ error: "project_repo_missing" });
    return true;
  }

  return false;
};

function slugifyBranchName(input: string) {
  const s = String(input || "")
    .trim()
    .toLowerCase()
    // quita acentos
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // caracteres raros -> guion
    .replace(/[^a-z0-9]+/g, "-")
    // limpia guiones extremos
    .replace(/^-+|-+$/g, "")
    // evita vacío
    .slice(0, 60);

  return s || "task";
}

function slugifyChecklistKey(text: string, index: number) {
  const base = slugifyBranchName(text).slice(0, 40) || "item";
  return `${base}-${index}`;
}

function extractChecklistCandidates(acceptanceCriteria?: string, description?: string) {
  const trimmedAcceptance = String(acceptanceCriteria || "").trim();
  if (trimmedAcceptance) {
    const lines = trimmedAcceptance
      .split(/\r?\n/) // bullet list lines
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-") || l.startsWith("*"))
      .map((l) => l.replace(/^[-*]\s*/, ""))
      .filter(Boolean);
    if (lines.length) return lines;
  }

  const text = String(description || "").trim();
  if (!text) return [];

  return text
    .split(/[.;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function buildChecklist(task: any): ChecklistItem[] {
  const candidates = extractChecklistCandidates(task?.acceptanceCriteria, task?.description);

  if (!candidates.length) {
    return [
      {
        key: slugifyChecklistKey(task?.title || "item", 0),
        text: task?.title || "Checklist",
        status: "PENDING",
      },
    ];
  }

  return candidates.slice(0, 6).map((text, index) => ({
    key: slugifyChecklistKey(text, index),
    text,
    status: "PENDING" as ChecklistStatus,
  }));
}

function normalizeChecklist(task: any): boolean {
  let changed = false;
  if (!Array.isArray(task?.checklist) || !task.checklist.length) {
    task.checklist = buildChecklist(task);
    changed = true;
  } else {
    task.checklist = task.checklist.map((item: any, idx: number) => {
      const key = item?.key || slugifyChecklistKey(item?.text || `item-${idx}`, idx);
      const status: ChecklistStatus = ["PENDING", "PASSED", "FAILED"].includes(item?.status)
        ? (item.status as ChecklistStatus)
        : "PENDING";

      if (!item?.key || !item?.status) changed = true;
      return {
        key,
        text: item?.text || key,
        status,
        ...(item?.details ? { details: item.details } : {}),
      } as ChecklistItem;
    });
  }

  return changed;
}
async function safeDeleteBranchIfNoCommits(
  ownerEmail: string,
  repoFullName: string,
  branchName: string
) {
  const [owner, repo] = String(repoFullName).split("/");
  if (!owner || !repo) throw new Error("invalid_repo_full_name");

  const { client } = await getOctokitForEmail(ownerEmail);

  // default branch (normalmente main)
  const repoInfo = await client.getRepo(owner, repo);
  const base = repoInfo?.default_branch || "main";

  // SHA de main
  const baseRef = await client.getRef(owner, repo, `heads/${base}`);
  const baseSha = baseRef?.object?.sha;

  // SHA de la branch
  let branchRef: any;
  try {
    branchRef = await client.getRef(owner, repo, `heads/${branchName}`);
  } catch (e: any) {
    // Si no existe ya, ok
    if (e?.status === 404) return { deleted: false, reason: "branch_not_found" };
    throw e;
  }

  const branchSha = branchRef?.object?.sha;

  if (!baseSha || !branchSha) {
    return { deleted: false, reason: "sha_missing" };
  }

  // ✅ solo borra si apunta al mismo commit que main
  if (String(branchSha) !== String(baseSha)) {
    return { deleted: false, reason: "has_commits" };
  }

  await client.deleteRef(owner, repo, `heads/${branchName}`);
  return { deleted: true, reason: "deleted_no_commits" };
}
async function createBranchFromDefault(
  userEmail: string,
  repoFullName: string,
  branchName: string
) {
  const [owner, repo] = String(repoFullName).split("/");
  if (!owner || !repo) throw new Error("invalid_repo_full_name");

  const { client } = await getOctokitForEmail(userEmail);

  const repoInfo = await client.getRepo(owner, repo);
  const base = repoInfo?.default_branch || "main";

  const ref = await client.getRef(owner, repo, `heads/${base}`);
  const sha = ref?.object?.sha;
  if (!sha) {
    const err: any = new Error("base_branch_sha_not_found");
    err.status = 500;
    throw err;
  }

  await client.createRef(owner, repo, `refs/heads/${branchName}`, sha);

  return { branchName, sha, baseBranch: base };
}



/**
 * ✅ MIGRACIÓN EN CALIENTE:
 * Inicializa defaults de verificación/repositorio
 */
export function ensureTaskDefaults(task: any): boolean {
  let changed = false;

  if (!task) return changed;

  if (!task.columnId) {
    task.columnId = "todo";
    changed = true;
  }

  if (!task.verificationStatus) {
    task.verificationStatus = "NOT_SUBMITTED";
    changed = true;
  }

  if (!task.verification) {
    task.verification = { status: task.verificationStatus };
    changed = true;
  } else if (!task.verification.status) {
    task.verification.status = task.verificationStatus;
    changed = true;
  }

  if (!task.repo) {
    task.repo = null;
  }

  if (task.repo) {
    if (!task.repo.checks) {
      task.repo.checks = { status: "IDLE" };
      changed = true;
    } else if (!task.repo.checks.status) {
      task.repo.checks.status = "IDLE";
      changed = true;
    }
  }

  if (normalizeChecklist(task)) {
    changed = true;
  }

  return changed;
}

const containsWeb3Keyword = (text?: string) => {
  const normalized = String(text || "").toLowerCase();
  return WEB3_KEYWORDS.some((kw) => normalized.includes(kw.toLowerCase()));
};

const shouldCreateContractsRepo = (stack?: ProjectStack, tasks?: any[]) => {
  const stackText = JSON.stringify(stack || "").toLowerCase();
  if (containsWeb3Keyword(stackText)) return true;

  const list = Array.isArray(tasks) ? tasks : [];
  return list.some((t) => containsWeb3Keyword(`${t?.title ?? ""} ${t?.description ?? ""}`));
};

const detectRepoTypeForTask = (task: any, hasContractsRepo: boolean): RepoType => {
  const mentionsContracts =
    hasContractsRepo && containsWeb3Keyword(`${task?.title ?? ""} ${task?.description ?? ""}`);
  if (mentionsContracts) return "contracts";
  const layer = String(task?.layer ?? task?.category ?? "").toUpperCase();
  if (layer === "VIEW") return "frontend";
  return "backend";
};

const normalizeProjectReposList = (doc: any): ProjectRepoEntry[] => {
  const reposRaw = Array.isArray(doc?.projectRepos) ? doc.projectRepos : [];
  const repos = reposRaw
    .map((r: any) => ({
      type: r?.type,
      fullName: r?.fullName,
      htmlUrl: r?.htmlUrl,
      name: r?.name,
    }))
    .filter((r: ProjectRepoEntry) => r.fullName);

  if (!repos.length && doc?.projectRepo?.fullName) {
    repos.push({
      type: "mono",
      fullName: doc.projectRepo.fullName,
      htmlUrl: doc.projectRepo.htmlUrl,
      name: doc.projectRepo.name,
    });
  }

  return repos;
};

const selectRepoForType = (projectRepos: ProjectRepoEntry[], repoType?: RepoType | null) => {
  if (!projectRepos?.length) return undefined;
  if (repoType) {
    const match = projectRepos.find((r) => r.type === repoType);
    if (match) return match;
  }
  const backend = projectRepos.find((r) => r.type === "backend");
  return backend || projectRepos[0];
};

const resolveRepoForTask = (doc: any, task: any) => {
  const projectRepos = normalizeProjectReposList(doc);
  const hasContractsRepo = projectRepos.some((r) => r.type === "contracts");
  const repoType = (task?.repoType as RepoType) || detectRepoTypeForTask(task, hasContractsRepo);
  const targetRepo = selectRepoForType(projectRepos, repoType);

  const fallbackFullName =
    typeof doc?.projectRepo === "string"
      ? doc.projectRepo
      : doc?.projectRepo?.fullName || doc?.projectRepo?.repoFullName || null;
  const fallbackUrl = doc?.projectRepo?.htmlUrl;

  const repoFullName =
    task?.repo?.repoFullName ||
    (task as any)?.repoFullName ||
    targetRepo?.fullName ||
    fallbackFullName ||
    null;
  const repoUrl = targetRepo?.htmlUrl || fallbackUrl || undefined;

  return { repoFullName: repoFullName ?? undefined, repoUrl, repoType: targetRepo?.type ?? repoType };
};

const ensureTaskRepoMetadata = async (doc: any) => {
  const projectRepos = normalizeProjectReposList(doc);
  if (!projectRepos.length) return;

  const estimation: any = doc.estimation || {};
  const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];
  let changed = false;
  const hasContractsRepo = projectRepos.some((r) => r.type === "contracts");

  for (const task of tasks) {
    const repoType = detectRepoTypeForTask(task, hasContractsRepo);
    if (task.repoType !== repoType) {
      task.repoType = repoType;
      changed = true;
    }

    const targetRepo = selectRepoForType(projectRepos, repoType);
    if (targetRepo) {
      if (!task.repo) {
        task.repo = { provider: "github", repoFullName: targetRepo.fullName, checks: { status: "IDLE" } };
        changed = true;
      } else if (!task.repo.repoFullName) {
        task.repo.repoFullName = targetRepo.fullName;
        changed = true;
      }
    }
  }

  if (changed) {
    estimation.tasks = tasks;
    doc.estimation = estimation;
    doc.markModified("estimation");
    await doc.save();
  }
};

const deleteCreatedRepos = async (ownerEmail: string, repos: ProjectRepoEntry[]) => {
  if (!repos?.length) return;
  try {
    const { client } = await getOctokitForEmail(ownerEmail);
    for (const repo of repos) {
      const [owner, repoName] = String(repo.fullName || "").split("/");
      if (!owner || !repoName) continue;
      try {
        await client.deleteRepo(owner, repoName);
        console.log(`[community:repo] cleanup deleted repo=${repo.fullName} owner=${ownerEmail}`);
      } catch (repoErr) {
        console.warn("[community:repo] cleanup failed", { repo: repo.fullName, error: repoErr });
      }
    }
  } catch (error) {
    console.warn("[community:repo] cleanup skip (octokit)", error);
  }
};

/**
 * ✅ MIGRACIÓN EN CALIENTE:
 * Normaliza ids y defaults de tareas y persiste si cambió algo.
 */
export async function normalizeAndPersistTaskIds(doc: any): Promise<void> {
  const estimation: any = doc.estimation || {};
  const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

  if (!tasks.length) return;

  const used = new Set<string>();
  let changed = false;

  for (const t of tasks) {
    const raw = t?.id ?? t?._id;
    const s = raw != null ? String(raw) : "";

    const needsNew = !s || !mongoose.Types.ObjectId.isValid(s) || used.has(s);

    if (needsNew) {
      const newId = new mongoose.Types.ObjectId().toString();
      t.id = newId;
      changed = true;
      used.add(newId);
    } else {
      t.id = s;
      used.add(s);
    }

    if (ensureTaskDefaults(t)) changed = true;
  }

  if (changed) {
    estimation.tasks = tasks;
    doc.estimation = estimation;
    doc.markModified("estimation");
    await doc.save();
  }
}

export const mapTaskToBoard = (task: any): BoardTask => {
  ensureTaskDefaults(task);

  const id = String(task.id);
  const columnId = ((task.columnId as ColumnId) ?? "todo") as ColumnId;

  return {
    id,
    title: task.title,
    description: task.description,
    price: task.taskPrice ?? task.price ?? 0,
    priority: task.priority ?? 0,
    layer: (task.layer ?? task.category ?? "SERVICE") as TaskCategory,
    columnId,
    assigneeEmail: task.assigneeEmail ?? null,
    assigneeAvatar: task.assigneeAvatar ?? null,

    status: task.status as TaskStatus | undefined,
    verificationStatus: task.verificationStatus as VerificationStatus | undefined,
    verification: task.verification,
    repo: task.repo ?? null,
    repoType: task.repoType as RepoType | undefined,
    acceptanceCriteria: task.acceptanceCriteria ?? task.acceptance ?? undefined,
    verificationNotes: task.verificationNotes ?? "",
    checklist: Array.isArray(task.checklist) ? task.checklist : buildChecklist(task),
  };
};

export const emitBoardUpdate = (projectId: string, tasks: any[]) => {
  const io = getIO();
  io.to(`community:${projectId}`).emit("community:boardUpdated", {
    projectId,
    tasks: tasks.map((t) => mapTaskToBoard(t)),
  });
};

type CommunityListItem = {
  id: string;
  title: string;
  description: string;
  ownerEmail: string;
  totalTasksPrice: number;
  platformFeePercent: number;
  tasksCount: number;
  publishedAt?: string;
};

const emitCommunityProjectCreated = (payload: CommunityListItem) => {
  const io = getIO();
  io.to("community:list").emit("community:projectCreated", payload);
};

const emitCommunityProjectDeleted = (payload: { id: string }) => {
  const io = getIO();
  io.to("community:list").emit("community:projectDeleted", payload);
};

// ----------------- POST publish -----------------
router.post(
  "/projects",
  async (
    req: Request<
      unknown,
      unknown,
      {
        ownerEmail?: string;
        projectTitle?: string;
        projectDescription?: string;
        estimation?: any;
      }
    >,
    res: Response<{ id: string; publicUrl: string } | { error: string }>
  ) => {
    try {
      const { ownerEmail, projectTitle, projectDescription, estimation } = req.body || {};

      if (!ownerEmail || !projectTitle || !projectDescription || !estimation) {
        return res.status(400).json({
          error: "ownerEmail, projectTitle, projectDescription y estimation son obligatorios",
        });
      }

      await connectMongo();

      // ✅ IMPORTANTÍSIMO: declara newId ANTES del map
      const newId = new mongoose.Types.ObjectId();

      const tasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];
      const normalizedStack = normalizeProjectStack(estimation.stack as any);
      estimation.stack = normalizedStack;
      const hasContractsRepo = shouldCreateContractsRepo(normalizedStack, tasks);

      // ✅ normalizamos tasks al publicar (ids válidos y persistidos)
      const used = new Set<string>();
      estimation.tasks = tasks.map((t: any) => {
        let id = String(t?.id ?? t?._id ?? "");
        if (!mongoose.Types.ObjectId.isValid(id) || used.has(id)) {
          id = new mongoose.Types.ObjectId().toString();
        }
        used.add(id);

        const columnId = ((t.columnId as ColumnId) ?? "todo") as ColumnId;
        const repoType = detectRepoTypeForTask(t, hasContractsRepo);

        const baseTask: any = {
          ...t,
          id,
          columnId,
          assigneeEmail: t.assigneeEmail ?? null,
          assigneeAvatar: t.assigneeAvatar ?? null,

          status:
            t.status ??
            (columnId === "doing"
              ? "IN_PROGRESS"
              : columnId === "review"
                ? "IN_REVIEW"
                : columnId === "done"
                  ? "DONE"
                  : "TODO"),
          verificationStatus: t.verificationStatus ?? "NOT_SUBMITTED",
          verification: t.verification ?? { status: t.verificationStatus ?? "NOT_SUBMITTED" },
          repo: t.repo ?? null,
          repoType,
          acceptanceCriteria: t.acceptanceCriteria ?? t.acceptance ?? undefined,
          verificationNotes: t.verificationNotes ?? "",
        };

        // ✅ checklist por tarea (tu lógica actual)
        if (!Array.isArray(baseTask.checklist) || !baseTask.checklist.length) {
          baseTask.checklist = buildChecklist(baseTask);
          console.log(
            `[community:checklist] created project=${newId.toString()} task=${id} items=${baseTask.checklist.length}`
          );
        } else {
          normalizeChecklist(baseTask);
        }

        return baseTask;
      });

      // ================================
      // ✅ NUEVO: TECHNICAL CHECKLIST (PROYECTO)
      // ================================
      const buildTechnicalChecklist = (tasksNormalized: any[]) => {
        const groups: Record<
          string,
          { id: string; title: string; layer: string; priority: number; acceptanceCriteria?: string }[]
        > = {
          "Arquitectura": [],
          "Modelo de datos": [],
          "Servicios / Backend": [],
          "Vistas / Frontend": [],
          "Infra / DevOps": [],
          "QA / Testing": [],
        };

        for (const t of tasksNormalized) {
          const layer = String(t.layer ?? t.category ?? "SERVICE");
          const item = {
            id: String(t.id ?? ""),
            title: String(t.title ?? "Tarea"),
            layer,
            priority: Number(t.priority ?? 0),
            acceptanceCriteria: t.acceptanceCriteria ?? undefined,
          };

          if (layer === "ARCHITECTURE") groups["Arquitectura"].push(item);
          else if (layer === "MODEL") groups["Modelo de datos"].push(item);
          else if (layer === "SERVICE") groups["Servicios / Backend"].push(item);
          else if (layer === "VIEW") groups["Vistas / Frontend"].push(item);
          else if (layer === "INFRA") groups["Infra / DevOps"].push(item);
          else if (layer === "QA") groups["QA / Testing"].push(item);
          else groups["Servicios / Backend"].push(item);
        }

        // ordenar por prioridad dentro de cada grupo
        for (const k of Object.keys(groups)) {
          groups[k].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
        }

        // quitar grupos vacíos
        return Object.entries(groups)
          .filter(([, items]) => items.length > 0)
          .map(([title, items]) => ({ title, items }));
      };

      // ✅ Genera y guarda en estimation (o en root, tu eliges)
      const technicalChecklist = buildTechnicalChecklist(estimation.tasks);

      // Si quieres guardarlo dentro de estimation:
      estimation.technicalChecklist = technicalChecklist;

      // (alternativa) si prefieres guardarlo en el root del doc:
      // const docData: any = { ..., technicalChecklist }

      // ✅ crear doc con el mismo newId
      const doc: any = await CommunityProject.create({
        _id: newId,
        ownerEmail,
        projectTitle,
        projectDescription,
        estimation,
        technicalChecklist, // ✅ recomendado: root para acceso fácil en listados
        stack: estimation.stack,
        isPublished: true,
      });

      // ✅ Crear repos en GitHub al publicar (y guardar en doc.projectRepos)
      let createdRepos: ProjectRepoEntry[] = [];
      try {
        createdRepos = await createProjectRepos(
          ownerEmail,
          newId.toString(),
          projectTitle,
          projectDescription,
          { contracts: hasContractsRepo }
        );

        const backendRepo = createdRepos.find((r) => r.type === "backend") || createdRepos[0];
        if (backendRepo) {
          doc.projectRepo = {
            name: backendRepo.name,
            fullName: backendRepo.fullName,
            htmlUrl: backendRepo.htmlUrl,
          };
        }
        doc.projectRepos = createdRepos.map((r) => ({
          type: r.type,
          fullName: r.fullName,
          htmlUrl: r.htmlUrl,
          name: r.name,
        }));

        const projectReposNormalized = normalizeProjectReposList(doc);
        const estimationTasks: any[] = Array.isArray(doc.estimation?.tasks) ? doc.estimation.tasks : [];
        const hasContracts = projectReposNormalized.some((r) => r.type === "contracts");
        let tasksChanged = false;
        for (const task of estimationTasks) {
          const repoType = detectRepoTypeForTask(task, hasContracts);
          if (task.repoType !== repoType) {
            task.repoType = repoType;
            tasksChanged = true;
          }
          const targetRepo = selectRepoForType(projectReposNormalized, repoType);
          if (targetRepo) {
            if (!task.repo) {
              task.repo = { provider: "github", repoFullName: targetRepo.fullName, checks: { status: "IDLE" } };
              tasksChanged = true;
            } else if (!task.repo.repoFullName) {
              task.repo.repoFullName = targetRepo.fullName;
              tasksChanged = true;
            }
          }
        }

        if (tasksChanged) {
          doc.estimation = { ...(doc.estimation as any), tasks: estimationTasks };
          doc.markModified("estimation");
        }

        await doc.save();

        const io = getIO();
        io.to(`community:${newId.toString()}`).emit("community:repoCreated", {
          projectId: newId.toString(),
          repoFullName: backendRepo?.fullName,
          repoUrl: backendRepo?.htmlUrl,
          projectRepos: createdRepos,
        });
      } catch (repoError: any) {
        const reposToCleanup: ProjectRepoEntry[] =
          (repoError as any)?.createdRepos || createdRepos;
        await deleteCreatedRepos(ownerEmail, reposToCleanup);
        await doc.deleteOne();
        if (mapRepoErrorToResponse(repoError, res)) return;

        console.error("[community] Error creando repo de proyecto:", repoError);
        return res.status(500).json({ error: "Error interno creando repo de comunidad" });
      }

      const id = doc._id.toString();
      const publicUrl = `/community/${id}`;

      const tasksRaw: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];
      const totalTasksPrice =
        estimation?.totalTasksPrice ??
        tasksRaw.reduce((sum, t) => sum + (t.taskPrice ?? t.price ?? 0), 0);

      emitCommunityProjectCreated({
        id,
        title: projectTitle,
        description: projectDescription,
        ownerEmail,
        totalTasksPrice,
        platformFeePercent: estimation?.platformFeePercent ?? 1,
        tasksCount: tasksRaw.length,
        publishedAt: doc.createdAt ?? doc.updatedAt,

        // ✅ opcional: si tu evento lo soporta
        // technicalChecklist,
      });

      return res.status(200).json({ id, publicUrl });
    } catch (error) {
      console.error("[community] Error creando proyecto de comunidad:", error);
      return res.status(500).json({ error: "Error interno creando proyecto de comunidad" });
    }
  }
);

// ----------------- JOIN REPO BY TYPE -----------------
router.post(
  "/projects/:id/repos/:type/join",
  async (
    req: Request<{ id: string; type: string }, unknown, { userEmail?: string }>,
    res: Response
  ) => {
    try {
      await connectMongo();

      const { id, type } = req.params;
      const userEmail = String(req.body?.userEmail || "").trim();
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Identificador de proyecto no válido" });
      }

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: "Proyecto de comunidad no encontrado" });
      }

      const repoType = String(type || "").toLowerCase() as RepoType;
      if (!["backend", "frontend", "contracts"].includes(repoType)) {
        return res.status(400).json({ error: "repoType_no_soportado" });
      }

      const projectRepos = normalizeProjectReposList(doc);
      const targetRepo = selectRepoForType(projectRepos, repoType);

      if (!targetRepo?.fullName) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      if (String(doc.ownerEmail).toLowerCase() === userEmail.toLowerCase()) {
        return res.status(200).json({
          joined: true,
          state: "ACTIVE",
          repoUrl: targetRepo.htmlUrl,
          repoFullName: targetRepo.fullName,
          repoType: targetRepo.type,
        });
      }

      const result = await inviteUserToRepoForRepo(id, targetRepo.fullName, userEmail);

      const io = getIO();
      io.to(`community:${id}`).emit("community:userInvitedToRepo", {
        projectId: id,
        userEmail,
        repoUrl: result.repoUrl,
        repoType: targetRepo.type,
      });

      return res.status(200).json({
        joined: !!result.joined,
        state: result.state,
        repoUrl: result.repoUrl ?? targetRepo.htmlUrl,
        repoFullName: result.repoFullName ?? targetRepo.fullName,
        repoType: targetRepo.type,
      });
    } catch (error: any) {
      if (mapRepoErrorToResponse(error, res)) return;

      console.error("[community] Error invitando usuario al repo:", error);
      return res.status(500).json({ error: "Error interno invitando al repo" });
    }
  }
);


// ----------------- GET board -----------------
router.get("/projects/:id/board", async (req: Request<{ id: string }>, res: Response<any>) => {
  try {
    await connectMongo();
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Identificador de proyecto no válido" });
    }

    const doc: any = await CommunityProject.findById(id);
    if (!doc || !doc.isPublished) {
      return res.status(404).json({ error: "Proyecto de comunidad no encontrado" });
    }

    await normalizeAndPersistTaskIds(doc);
    await ensureTaskRepoMetadata(doc);

    const estimation = doc.estimation as any;
    const rawTasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];

    // ✅ NORMALIZACIÓN RESPUESTA: projectRepo dentro de project (como espera el frontend)
    const projectRepo =
      doc.projectRepo && doc.projectRepo.fullName && doc.projectRepo.htmlUrl
        ? { fullName: doc.projectRepo.fullName, htmlUrl: doc.projectRepo.htmlUrl }
        : null;
    const projectRepos = normalizeProjectReposList(doc);

    return res.status(200).json({
      project: {
        id: String(doc._id),
        title: doc.projectTitle,
        description: doc.projectDescription,
        ownerEmail: doc.ownerEmail,
        published: doc.isPublished,
        projectRepo,
        projectRepos: projectRepos.map((r) => ({
          type: r.type,
          fullName: r.fullName,
          htmlUrl: r.htmlUrl,
        })),
      },
      projectRepo, // compat opcional
      projectRepos: projectRepos.map((r) => ({
        type: r.type,
        fullName: r.fullName,
        htmlUrl: r.htmlUrl,
      })),
      columns: BOARD_COLUMNS,
      tasks: rawTasks.map((t) => mapTaskToBoard(t)),
    });
  } catch (error) {
    console.error("[community] Error obteniendo tablero de comunidad:", error);
    return res.status(500).json({ error: "Error interno obteniendo tablero de comunidad" });
  }
});

// ----------------- REPO STATUS -----------------
router.get("/projects/:id/repo/status", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await connectMongo();

    const { id } = req.params;
    const userEmail = String(req.query.userEmail || "").trim();
    if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Identificador de proyecto no válido" });
    }

    const doc: any = await CommunityProject.findById(id).lean();
    if (!doc || !doc.isPublished) {
      return res.status(404).json({ error: "Proyecto de comunidad no encontrado" });
    }

    const projectRepos = normalizeProjectReposList(doc);
    const repoTarget =
      selectRepoForType(projectRepos, "backend") || projectRepos[0] || null;
    const fallbackFullName = doc?.projectRepo?.fullName || (doc as any)?.projectRepo?.repoFullName;
    const repoFullName = repoTarget?.fullName || fallbackFullName;
    const repoUrl = repoTarget?.htmlUrl || doc?.projectRepo?.htmlUrl;

    if (!repoFullName) {
      return res.status(400).json({ error: "project_repo_missing" });
    }

    const status = await ensureRepoMemberForRepo(id, repoFullName, userEmail);

    if (String(doc.ownerEmail).toLowerCase() === userEmail.toLowerCase()) {
      return res.status(200).json({
        joined: true,
        state: "ACTIVE" as const,
        repoUrl,
        repoFullName,
      });
    }

    return res.status(200).json({
      joined: !!status?.joined,
      state: status?.state,        // ✅ NUEVO
      repoUrl: status?.repoUrl || repoUrl,
      repoFullName: status?.repoFullName || repoFullName,
    });
  } catch (error: any) {
    if (mapRepoErrorToResponse(error, res)) return;

    console.error("[community] Error obteniendo estado de repo:", error);
    return res.status(500).json({ error: "Error interno obteniendo estado del repo" });
  }
});

// ----------------- REPOS STATUS (multi) -----------------
router.get("/projects/:id/repos/status", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await connectMongo();

    const { id } = req.params;
    const userEmail = String(req.query.userEmail || "").trim();
    if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Identificador de proyecto no válido" });
    }

    const doc: any = await CommunityProject.findById(id).lean();
    if (!doc || !doc.isPublished) {
      return res.status(404).json({ error: "Proyecto de comunidad no encontrado" });
    }

    const projectRepos = normalizeProjectReposList(doc);
    if (!projectRepos.length) {
      return res.status(400).json({ error: "project_repo_missing" });
    }

    const isOwner = String(doc.ownerEmail).toLowerCase() === userEmail.toLowerCase();

    const statuses = await Promise.all(
      projectRepos.map(async (repo) => {
        if (isOwner) {
          return {
            type: repo.type,
            repoFullName: repo.fullName,
            repoUrl: repo.htmlUrl,
            state: "ACTIVE" as const,
          };
        }

        const status = await ensureRepoMemberForRepo(id, repo.fullName, userEmail);
        return {
          type: repo.type,
          repoFullName: repo.fullName,
          repoUrl: repo.htmlUrl || status.repoUrl,
          state: status?.state,
        };
      })
    );

    return res.status(200).json({ repos: statuses });
  } catch (error: any) {
    if (mapRepoErrorToResponse(error, res)) return;
    console.error("[community] Error obteniendo estado de repos:", error);
    return res.status(500).json({ error: "Error interno obteniendo estado de los repos" });
  }
});

// ----------------- JOIN REPO -----------------
router.post(
  "/projects/:id/repo/join",
  async (req: Request<{ id: string }, unknown, { userEmail?: string }>, res: Response) => {
    try {
      await connectMongo();

      const { id } = req.params;
      const userEmail = String(req.body?.userEmail || "").trim();
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Identificador de proyecto no válido" });
      }

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: "Proyecto de comunidad no encontrado" });
      }

      const projectRepos = normalizeProjectReposList(doc);
      const targetRepo = selectRepoForType(projectRepos, "backend") || projectRepos[0];
      const fallbackFullName = doc?.projectRepo?.fullName || (doc as any)?.projectRepo?.repoFullName;
      const repoFullName = targetRepo?.fullName || fallbackFullName;
      const repoUrl = targetRepo?.htmlUrl || doc?.projectRepo?.htmlUrl;

      if (!repoFullName) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      if (String(doc.ownerEmail).toLowerCase() === userEmail.toLowerCase()) {
        return res.status(200).json({
          joined: true,
          repoUrl,
          repoFullName,
        });
      }

      const result = await inviteUserToRepoForRepo(id, repoFullName, userEmail);

      const io = getIO();
      io.to(`community:${id}`).emit("community:userInvitedToRepo", {
        projectId: id,
        userEmail,
        repoUrl: result.repoUrl,
      });

      return res.status(200).json({
        joined: !!result.joined,
        repoUrl: result.repoUrl ?? repoUrl,
        repoFullName: result.repoFullName ?? repoFullName,
      });
    } catch (error: any) {
      if (mapRepoErrorToResponse(error, res)) return;

      console.error("[community] Error invitando usuario al repo:", error);
      return res.status(500).json({ error: "Error interno invitando al repo" });
    }
  }
);

// ----------------- GET list -----------------
router.get("/projects", async (_req: Request, res: Response) => {
  try {
    await connectMongo();
    const docs = await CommunityProject.find({ isPublished: true }).lean();

    const list = docs.map((doc: any) => {
      const estimation = doc.estimation as any;
      const tasksRaw: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];

      const totalTasksPrice =
        estimation?.totalTasksPrice ??
        tasksRaw.reduce((sum, t) => sum + (t.taskPrice ?? t.price ?? 0), 0);

      return {
        id: String(doc._id),
        title: doc.projectTitle,
        description: doc.projectDescription,
        ownerEmail: doc.ownerEmail,
        totalTasksPrice,
        platformFeePercent: estimation?.platformFeePercent ?? 1,
        tasksCount: tasksRaw.length,
        publishedAt: doc.createdAt ?? doc.updatedAt,
      };
    });

    return res.status(200).json(list);
  } catch (error) {
    console.error("[community] Error listando proyectos de comunidad:", error);
    return res.status(500).json({ error: "Error interno listando proyectos de comunidad" });
  }
});

// ----------------- DELETE community project -----------------
router.delete("/projects/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await connectMongo();
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Identificador de proyecto no válido" });
    }

    const userEmail = String(req.headers["x-user-email"] || "").trim();
    if (!userEmail) {
      return res.status(401).json({ error: "Debes iniciar sesión para borrar proyectos." });
    }

    const doc: any = await CommunityProject.findById(id);
    if (!doc) return res.status(404).json({ error: "Proyecto no encontrado" });

    if (String(doc.ownerEmail).toLowerCase() !== userEmail.toLowerCase()) {
      return res.status(403).json({
        error: "No autorizado: solo el owner puede borrar este proyecto.",
      });
    }

    const projectRepos = normalizeProjectReposList(doc);
    const reposToDelete =
      projectRepos.length > 0
        ? projectRepos
        : (
            typeof doc.projectRepo === "string"
              ? [{ fullName: doc.projectRepo, type: "mono" }]
              : doc.projectRepo?.fullName
                ? [{ fullName: doc.projectRepo.fullName, type: doc.projectRepo.type ?? "mono" }]
                : []
          );

    for (const repo of reposToDelete) {
      const repoFullName = repo.fullName;
      try {
        const [owner, repoName] = String(repoFullName).split("/");
        if (owner && repoName) {
          const { client } = await getOctokitForEmail(doc.ownerEmail);
          await client.getRepo(owner, repoName);
          await client.deleteRepo(owner, repoName);

          console.log(
            `[community:repo] repo deleted project=${id} repo=${repoFullName} owner=${doc.ownerEmail}`
          );
        }
      } catch (e: any) {
        console.error("[community:repo] repo delete failed", {
          project: id,
          repo: repoFullName,
          owner: doc.ownerEmail,
          status: e?.status,
          message: e?.message,
        });

        return res.status(500).json({
          error: "repo_delete_failed",
          repoFullName,
          details: e?.message || "GitHub error",
        });
      }
    }

    await doc.deleteOne();
    emitCommunityProjectDeleted({ id });

    return res.status(200).json({
      message: "Proyecto eliminado correctamente",
      repoFullName: reposToDelete.map((r) => r.fullName),
    });
  } catch (error) {
    console.error("[community] Error eliminando proyecto:", error);
    return res.status(500).json({ error: "Error interno al eliminar el proyecto" });
  }
});

// ----------------- ASSIGN (todo -> doing) -----------------
router.post(
  "/projects/:id/tasks/:taskId/assign",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string; userAvatar?: string }>,
    res: Response<{ tasks: BoardTask[] } | RepoAccessError | ApiError>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail, userAvatar } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);
      await ensureTaskRepoMetadata(doc);
      const projectStack: ProjectStack = normalizeProjectStack((doc.estimation as any)?.stack);

      if (String(doc.ownerEmail).toLowerCase() === String(userEmail).toLowerCase()) {
        return res.status(403).json({ error: "El creador del proyecto no puede tomar tareas" });
      }

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      const doingCount = tasks.filter(
        (t) => t.assigneeEmail === userEmail && (t.columnId ?? "todo") === "doing"
      ).length;

      if (doingCount >= MAX_DOING_PER_USER) {
        return res.status(400).json({ error: "max_doing_reached" });
      }

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      const currentColumn = (task.columnId ?? "todo") as ColumnId;
      if (currentColumn !== "todo") {
        return res.status(400).json({ error: 'Solo se pueden asignar tareas en "Por hacer"' });
      }

      if (task.assigneeEmail && task.assigneeEmail !== userEmail) {
        return res.status(409).json({ error: "task_already_assigned" });
      }

      const repoInfo = resolveRepoForTask(doc, task);
      const projectRepoFullName = repoInfo.repoFullName;

      if (!projectRepoFullName || !String(projectRepoFullName).includes("/")) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      try {
        const membership = await ensureRepoMemberForRepo(id, projectRepoFullName, userEmail);

        if (membership?.state !== "ACTIVE") {
          return res.status(403).json({
            error: "repo_access_required",
            state: membership?.state || "NONE",
            repoUrl: repoInfo.repoUrl ?? membership?.repoUrl,
            repoType: repoInfo.repoType,
            repoFullName: projectRepoFullName,
          });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

      task.repoType = task.repoType || repoInfo.repoType;

      // ─────────────────────────────────────────────
      // ✅ NUEVO: crear branch y spec al pasar TODO -> DOING
      // ─────────────────────────────────────────────
      ensureTaskDefaults(task);

      if (!task.repo) {
        task.repo = { provider: "github", repoFullName: projectRepoFullName, checks: { status: "IDLE" } };
      }
      if (!task.repo.repoFullName) {
        task.repo.repoFullName = projectRepoFullName;
      }
      if (!task.repo.checks) {
        task.repo.checks = { status: "IDLE" };
      }

      const branchName =
        task.repo.branch ||
        buildTaskBranchName({ id: String(task.id), title: task.title || task.description || "task" });

      if (!task.repo.branch) {
        console.log("[community:assign] attempting branch create", {
          projectId: id,
          taskId,
          repo: projectRepoFullName,
          branchName,
          userEmail,
        });
        try {
          await createBranchFromDefault(doc.ownerEmail, projectRepoFullName, branchName);
          task.repo.branch = branchName;

          console.log(
            `[community:branch] created project=${id} task=${taskId} repo=${projectRepoFullName} branch=${branchName}`
          );
        } catch (e: any) {
          console.error("[community:branch] create failed", {
            projectId: id,
            taskId,
            repo: projectRepoFullName,
            branch: branchName,
            status: e?.status,
            message: e?.message,
            responseBody: e?.responseBody,
          });
          const msg = String(e?.message || "");
          const status = e?.status;

          if (msg.includes("Reference already exists") || String(status) === "422") {
            // ya existe => lo aceptamos y seguimos
            task.repo.branch = branchName;
            console.log(
              `[community:branch] already-exists project=${id} task=${taskId} repo=${projectRepoFullName} branch=${branchName}`
            );
          } else {
            // error real
            console.error("[community:branch] create failed", {
              projectId: id,
              taskId,
              repo: projectRepoFullName,
              branch: branchName,
              status,
              message: msg,
            });
            return res.status(500).json({ error: "branch_create_failed" });
          }
        }
      }

      // ✅ generar spec y commitear en la rama
      const spec = generateVerificationSpec({
        id: String(task.id),
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
      }, projectStack);

      try {
        await ensureVerificationFilesInBranch(projectRepoFullName, branchName, spec, doc.ownerEmail);
      } catch (e: any) {
        console.error("[community:assign] verification setup failed", {
          projectId: id,
          taskId,
          repo: projectRepoFullName,
          branch: branchName,
          message: e?.message,
          status: e?.status,
        });
        return res.status(500).json({ error: "verification_setup_failed" });
      }

      // checklist basado en spec
      task.checklist = buildChecklistFromSpec(spec, task.checklist).map((item) => ({
        ...item,
        status: "PENDING" as ChecklistStatus,
      }));

      // ✅ asignación
      task.assigneeEmail = userEmail;
      task.assigneeAvatar = userAvatar ?? task.assigneeAvatar ?? null;
      task.columnId = "doing";
      task.status = "IN_PROGRESS";
      task.verificationStatus = task.verificationStatus ?? "NOT_SUBMITTED";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");

      await doc.save();
      emitBoardUpdate(id, tasks);

      return res.status(200).json({ tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error) {
      console.error("[community] Error asignando tarea:", error);
      return res.status(500).json({ error: "Error interno asignando tarea" });
    }
  }
);

// ----------------- UNASSIGN (doing -> todo) -----------------
router.post(
  "/projects/:id/tasks/:taskId/unassign",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string }>,
    res: Response<{ tasks: BoardTask[] } | { error: string } | RepoAccessError>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);
      await ensureTaskRepoMetadata(doc);
      const projectStack: ProjectStack = normalizeProjectStack((doc.estimation as any)?.stack);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      if (task.assigneeEmail !== userEmail) {
        return res.status(403).json({ error: "No eres el asignado a esta tarea" });
      }

      if ((task.columnId ?? "todo") !== "doing") {
        return res.status(400).json({ error: 'Solo se pueden desasignar tareas en "Haciendo"' });
      }

      const repoInfo = resolveRepoForTask(doc, task);
      const repoFullName = repoInfo.repoFullName;

      if (!repoFullName) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      try {
        const membership = await ensureRepoMemberForRepo(id, repoFullName, userEmail);
        if (membership?.state !== "ACTIVE") {
          return res.status(403).json({
            error: "repo_access_required",
            state: membership?.state || "NONE",
            repoUrl: repoInfo.repoUrl ?? membership?.repoUrl,
            repoType: repoInfo.repoType,
            repoFullName,
          });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

      // ─────────────────────────────────────────────
      // ✅ OPCIÓN B: borrar rama SOLO si no hay commits
      // ─────────────────────────────────────────────
      const branch = task?.repo?.branch;

      if (repoFullName && branch) {
        try {
          const result = await safeDeleteBranchIfNoCommits(doc.ownerEmail, repoFullName, branch);

          console.log("[community:branch] safe delete attempt", {
            projectId: id,
            taskId,
            repoFullName,
            branch,
            ...result,
          });

          // si se borró, limpiamos branch en la tarea
          if (result.deleted && task.repo) {
            task.repo.branch = undefined;
          }
        } catch (e: any) {
          console.warn("[community:branch] safe delete failed (ignored)", {
            projectId: id,
            taskId,
            repoFullName,
            branch,
            status: e?.status,
            message: e?.message,
          });
          // ❗No rompemos el unassign
        }
      }

      // ✅ unassign normal
      task.assigneeEmail = null;
      task.assigneeAvatar = null;
      task.columnId = "todo";
      task.status = "TODO";
      task.verificationStatus = task.verificationStatus ?? "NOT_SUBMITTED";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");

      await doc.save();
      emitBoardUpdate(id, tasks);

      return res.status(200).json({ tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error) {
      console.error("[community] Error desasignando tarea:", error);
      return res.status(500).json({ error: "Error interno desasignando tarea" });
    }
  }
);


// ----------------- SUBMIT REVIEW (doing -> review) -----------------
router.post(
  "/projects/:id/tasks/:taskId/submit-review",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string }>,
    res: Response<{ tasks: BoardTask[] } | { error: string } | RepoAccessError>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);
      await ensureTaskRepoMetadata(doc);
      const projectStack: ProjectStack = normalizeProjectStack((doc.estimation as any)?.stack);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      if (task.assigneeEmail !== userEmail) {
        return res.status(403).json({ error: "Solo el asignado puede enviarla a revisión" });
      }

      if ((task.columnId ?? "todo") !== "doing") {
        return res.status(400).json({ error: 'Solo se pueden enviar tareas en "Haciendo"' });
      }

      const repoInfo = resolveRepoForTask(doc, task);
      const projectRepoFullName = repoInfo.repoFullName;

      if (!projectRepoFullName) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      try {
        const membership = await ensureRepoMemberForRepo(id, projectRepoFullName, userEmail);
        if (membership?.state !== "ACTIVE") {
          return res.status(403).json({
            error: "repo_access_required",
            state: membership?.state || "NONE",
            repoUrl: repoInfo.repoUrl ?? membership?.repoUrl,
            repoType: repoInfo.repoType,
            repoFullName: projectRepoFullName,
          });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

      ensureTaskDefaults(task);
      task.repoType = task.repoType || repoInfo.repoType;

      if (!task.repo) {
        task.repo = { provider: "github", repoFullName: projectRepoFullName ?? undefined, checks: { status: "IDLE" } };
      }

      if (!task.repo.repoFullName && projectRepoFullName) {
        task.repo.repoFullName = projectRepoFullName;
      }

      if (!task.repo.branch && task.repo.repoFullName) {
        const baseSlug = slugifyBranchName(task.title || "task");
        const branchName = `task-${task.id}-${baseSlug}`;
        try {
          await createBranchFromDefault(doc.ownerEmail, task.repo.repoFullName, branchName);
          task.repo.branch = branchName;
          console.log(
            `[community:branch] created project=${id} task=${taskId} repo=${task.repo.repoFullName} branch=${branchName}`
          );
        } catch (error) {
          console.error("[community:branch] create failed on submit-review", {
            projectId: id,
            taskId,
            repo: task.repo.repoFullName,
            branch: branchName,
          });
        }
      }

      const branchName = task.repo.branch || buildTaskBranchName({ id: String(task.id), title: task.title });
      if (!task.repo.branch) {
        task.repo.branch = branchName;
      }
      const spec = generateVerificationSpec(
        {
          id: String(task.id),
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
        },
        projectStack
      );

      try {
        await ensureVerificationFilesInBranch(task.repo.repoFullName!, branchName, spec, doc.ownerEmail);
      } catch (error: any) {
        console.error("[community:submit-review] ensure verification failed", {
          projectId: id,
          taskId,
          repo: task.repo.repoFullName,
          branch: branchName,
          message: error?.message,
        });
        return res.status(500).json({ error: "verification_setup_failed" });
      }

      task.checklist = buildChecklistFromSpec(spec, task.checklist).map((item) => ({
        ...item,
        status: "PENDING" as ChecklistStatus,
      }));

      task.repo.checks = task.repo.checks || { status: "IDLE" };
      task.repo.checks.status = "PENDING";
      task.repo.checks.lastRunConclusion = null;
      task.repo.checks.lastRunUrl = undefined;

      task.columnId = "review";
      task.status = "IN_REVIEW";
      task.verificationStatus = "SUBMITTED";
      task.verification = task.verification || { status: "SUBMITTED" };
      task.verification.status = task.verification.status || "SUBMITTED";
      task.verificationNotes = task.verificationNotes ?? "";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");

      await doc.save();
      emitBoardUpdate(id, tasks);

      const branch = task.repo?.branch;
      const checklistKeys = (Array.isArray(task.checklist) ? task.checklist : []).map((c: any) => c.key);

      if (branch && task.repo?.repoFullName) {
        await dispatchVerifyWorkflow(id, {
          taskId,
          branch,
          checklistKeys,
          repoFullName: task.repo.repoFullName,
        });
      }

      return res.status(200).json({ tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error) {
      console.error("[community] Error enviando tarea a revisión:", error);
      return res.status(500).json({ error: "Error interno enviando a revisión" });
    }
  }
);

// ----------------- COMPLETE (doing -> done) -----------------
router.post(
  "/projects/:id/tasks/:taskId/complete",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string }>,
    res: Response<{ tasks: BoardTask[] } | { error: string } | RepoAccessError>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);
      await ensureTaskRepoMetadata(doc);
      const projectStack: ProjectStack = normalizeProjectStack((doc.estimation as any)?.stack);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      if (task.assigneeEmail !== userEmail) {
        return res.status(403).json({ error: "Solo el asignado puede completarla" });
      }

      if ((task.columnId ?? "todo") !== "doing") {
        return res.status(400).json({ error: 'Solo se pueden completar tareas en "Haciendo"' });
      }

      const repoInfo = resolveRepoForTask(doc, task);
      const repoFullName = repoInfo.repoFullName;
      if (!repoFullName) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      try {
        const membership = await ensureRepoMemberForRepo(id, repoFullName, userEmail);
        if (membership?.state !== "ACTIVE") {
          return res.status(403).json({
            error: "repo_access_required",
            state: membership?.state || "NONE",
            repoUrl: repoInfo.repoUrl ?? membership?.repoUrl,
            repoType: repoInfo.repoType,
            repoFullName,
          });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

      task.repoType = task.repoType || repoInfo.repoType;

      task.columnId = "done";
      task.status = "DONE";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");

      await doc.save();
      emitBoardUpdate(id, tasks);

      return res.status(200).json({ tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error) {
      console.error("[community] Error completando tarea:", error);
      return res.status(500).json({ error: "Error interno completando tarea" });
    }
  }
);

// ----------------- LINK REPO (dev asignado / owner) -----------------
router.post(
  "/projects/:id/tasks/:taskId/link-repo",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string; repoFullName?: string }>,
    res: Response
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail, repoFullName } = req.body || {};

      if (!userEmail || !repoFullName) {
        return res.status(400).json({ error: "userEmail y repoFullName son obligatorios" });
      }

      const [owner, repo] = repoFullName.split("/");
      if (!owner || !repo) {
        return res.status(400).json({ error: "repoFullName debe ser owner/repo" });
      }

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);
      const projectStack: ProjectStack = normalizeProjectStack((doc.estimation as any)?.stack);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];
      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      if (task.assigneeEmail !== userEmail && doc.ownerEmail !== userEmail) {
        return res.status(403).json({ error: "Solo el asignado o dueño puede vincular un repo" });
      }

      const { client } = await getOctokitForEmail(userEmail);
      await client.getRepo(owner, repo);

      ensureTaskDefaults(task);
      task.repo = {
        provider: "github",
        repoFullName,
        branch: task.repo?.branch, // no pisa branch si ya existe
        checks: task.repo?.checks || { status: "IDLE" },
      };

      if ((task.columnId as string) === "review") {
        task.verificationStatus = "SUBMITTED";
        task.verification = task.verification || { status: "SUBMITTED" };
        task.verification.status = "SUBMITTED";
      }

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");
      await doc.save();

      emitBoardUpdate(id, tasks);
      return res.status(200).json({ tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error: any) {
      console.error("[community:link-repo] Error:", error);
      return res.status(500).json({ error: error?.message || "Error vinculando repo" });
    }
  }
);

// ----------------- RUN VERIFY (solo en review y con repo vinculado) -----------------
router.post(
  "/projects/:id/tasks/:taskId/run-verify",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string }>,
    res: Response<{ ok: true; tasks: BoardTask[] } | { error: string } | RepoAccessError>
  ) => {
    try {
      await connectMongo();

      const { id, taskId } = req.params;
      const userEmail = String(req.body?.userEmail || "").trim();

      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Identificador de proyecto no válido" });
      }

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: "Proyecto no encontrado" });
      }

      await normalizeAndPersistTaskIds(doc);
      await ensureTaskRepoMetadata(doc);
      const projectStack: ProjectStack = normalizeProjectStack((doc.estimation as any)?.stack);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      if (!task.assigneeEmail || String(task.assigneeEmail).toLowerCase() !== userEmail.toLowerCase()) {
        return res.status(403).json({ error: "Solo el asignado puede ejecutar verificación" });
      }
      if (String(doc.ownerEmail).toLowerCase() === userEmail.toLowerCase()) {
        return res.status(403).json({ error: "El owner no puede ejecutar verificación" });
      }

      if ((task.columnId as string) !== "review") {
        return res.status(400).json({ error: "La tarea debe estar en revisión" });
      }

      const repoInfo = resolveRepoForTask(doc, task);
      const repoFullName = String(repoInfo.repoFullName || "").trim();
      if (!repoFullName || !repoFullName.includes("/")) {
        return res.status(400).json({ error: "La tarea no tiene repo vinculado" });
      }

      ensureTaskDefaults(task);
      task.repoType = task.repoType || (repoInfo.repoType as RepoType);

      try {
        const membership = await ensureRepoMemberForRepo(id, repoFullName, userEmail);
        if (membership?.state !== "ACTIVE") {
          return res.status(403).json({
            error: "repo_access_required",
            state: membership?.state || "NONE",
            repoUrl: repoInfo.repoUrl ?? membership?.repoUrl,
            repoType: repoInfo.repoType,
            repoFullName,
          });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

      if (!task.repo) {
        task.repo = { provider: "github", repoFullName, checks: { status: "IDLE" } };
      }
      if (!task.repo.repoFullName) {
        task.repo.repoFullName = repoFullName;
      }
      if (!task.repo.checks) {
        task.repo.checks = { status: "IDLE" };
      }
      const branchName =
        task.repo.branch ||
        buildTaskBranchName({ id: String(task.id), title: task.title || task.description || "task" });

      if (!task.repo.branch && task.repo.repoFullName) {
        try {
          await createBranchFromDefault(doc.ownerEmail, task.repo.repoFullName, branchName);
          task.repo.branch = branchName;
        } catch (error) {
          console.error("[community:branch] create failed on run-verify", {
            projectId: id,
            taskId,
            repo: task.repo.repoFullName,
            branch: branchName,
          });
        }
      }

      const finalBranch = task.repo.branch || branchName;

      // asegurar spec en rama
      let spec = await fetchVerificationSpec(repoFullName, finalBranch, String(task.id), doc.ownerEmail);
      if (!spec) {
        spec = generateVerificationSpec(
          {
            id: String(task.id),
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
          },
          projectStack
        );
      }

      try {
        await ensureVerificationFilesInBranch(repoFullName, finalBranch, spec, doc.ownerEmail);
      } catch (error: any) {
        console.error("[community:run-verify] verification setup failed", {
          projectId: id,
          taskId,
          repo: repoFullName,
          branch: finalBranch,
          message: error?.message,
        });
        return res.status(500).json({ error: "verification_setup_failed" });
      }

      // sincroniza checklist
      task.checklist = buildChecklistFromSpec(spec, task.checklist).map((item) => ({
        ...item,
        status: "PENDING" as ChecklistStatus,
      }));

      task.repo.checks.status = "PENDING";
      task.repo.checks.lastRunConclusion = null;
      task.repo.checks.lastRunUrl = undefined;

      task.verificationStatus = "SUBMITTED";
      task.verification = task.verification || { status: "SUBMITTED" };
      task.verification.status = "SUBMITTED";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");
      await doc.save();

      try {
        await triggerWorkflow(
          repoFullName,
          finalBranch,
          { projectId: id, taskId: String(task.id) },
          doc.ownerEmail
        );
      } catch (error: any) {
        console.error("[community:run-verify] workflow dispatch failed", {
          projectId: id,
          taskId,
          repo: repoFullName,
          branch: finalBranch,
          message: error?.message,
        });
        return res.status(500).json({ error: "workflow_dispatch_failed" });
      }

      // pequeña espera ligera para permitir creación de run
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const runInfo = await pollOrFetchLatestRun(repoFullName, finalBranch, doc.ownerEmail);
      const conclusion = runInfo.conclusion;

      if (conclusion) {
        const allPassed = conclusion === "success";
        task.repo.checks.status = allPassed ? "PASSED" : "FAILED";
        task.repo.checks.lastRunConclusion = conclusion;
        task.repo.checks.lastRunUrl = runInfo.url;

        task.checklist = task.checklist.map((item: ChecklistItem) => ({
          ...item,
          status: allPassed ? "PASSED" : "FAILED",
        }));

        if (allPassed) {
          task.columnId = "done";
          task.status = "DONE";
          task.verificationStatus = "APPROVED";
          task.verification = task.verification || { status: "APPROVED" };
          task.verification.status = "APPROVED";
        } else {
          task.columnId = "doing";
          task.status = "IN_PROGRESS";
          task.verificationStatus = "REJECTED";
          task.verification = task.verification || { status: "REJECTED" };
          task.verification.status = "REJECTED";
        }
      } else {
        task.repo.checks.status = "PENDING";
      }

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");
      await doc.save();

      emitBoardUpdate(id, tasks);
      return res.status(200).json({ ok: true, tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error: any) {
      console.error("[community:run-verify] Error:", error);
      return res.status(500).json({ error: error?.message || "Error corriendo verificación" });
    }
  }
);

export default router;
