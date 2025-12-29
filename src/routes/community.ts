// src/routes/community.ts
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { getIO } from "../socket";
import {
  createProjectRepo,
  dispatchVerifyWorkflow,
  ensureRepoMember,
  inviteUserToRepo,
  isGithubIntegrationPermissionError,
  cleanupTaskBranchOnBackToTodo,
  safeDeleteBranchIfNoCommits 
} from "../services/communityRepo";

import { getOctokitForEmail } from "../services/github";
import {
  SPEC_PATH,
  buildChecklistFromSpec,
  buildTaskBranchName,
  commitFileToBranch,
  fetchVerificationSpec,
  generateVerificationSpec,
  buildCommunityVerifyRunner,
  buildCommunityVerifyWorkflow,
  pollOrFetchLatestRun,
  triggerWorkflow,
  detectRepoStack,
  translateSpecToTests,
  ensureWorkflowExists,
  RepoStack,
  ensureVerificationAssetsOnBranch,
} from "../services/verificationSpec";

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
type RepoAccessError = {
  error: "repo_access_required";
  state?: "NONE" | "INVITED" | "ACTIVE";
  repoUrl?: string;
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
const COMMUNITY_WORKFLOW_FILE = ".github/workflows/community-verify.yml";

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

async function ensurePullRequestForBranch(params: {
  ownerEmail: string;
  repoFullName: string;
  branchName: string;
  title?: string;
  body?: string;
}) {
  const [owner, repo] = String(params.repoFullName).split("/");
  if (!owner || !repo) throw new Error("invalid_repo_full_name");

  const { client } = await getOctokitForEmail(params.ownerEmail);
  const repoInfo = await client.getRepo(owner, repo);
  const baseBranch = repoInfo?.default_branch || "main";

  const head = `${owner}:${params.branchName}`;
  const prs = await client.listPullRequests(owner, repo, { state: "open", head, per_page: 5 });
  const existing = Array.isArray(prs) ? prs.find((pr: any) => pr.head?.ref === params.branchName) : null;

  if (existing) {
    return { number: existing.number, url: existing.html_url, baseBranch };
  }

  const created = await client.createPullRequest(
    owner,
    repo,
    params.branchName,
    baseBranch,
    params.title || `Task ${params.branchName} verification`,
    params.body || "Auto-generated community verification PR."
  );

  return { number: created?.number, url: created?.html_url, baseBranch };
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

      // ✅ normalizamos tasks al publicar (ids válidos y persistidos)
      const used = new Set<string>();
      estimation.tasks = tasks.map((t: any) => {
        let id = String(t?.id ?? t?._id ?? "");
        if (!mongoose.Types.ObjectId.isValid(id) || used.has(id)) {
          id = new mongoose.Types.ObjectId().toString();
        }
        used.add(id);

        const columnId = ((t.columnId as ColumnId) ?? "todo") as ColumnId;

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
        isPublished: true,
      });

      // ✅ Crear repo en GitHub al publicar (y guardar en doc.projectRepo)
      try {
        const repoInfo = await createProjectRepo(
          ownerEmail,
          newId.toString(),
          projectTitle,
          projectDescription
        );

        doc.projectRepo = repoInfo;
        await doc.save();

        const io = getIO();
        io.to(`community:${newId.toString()}`).emit("community:repoCreated", {
          projectId: newId.toString(),
          repoFullName: repoInfo.fullName,
          repoUrl: repoInfo.htmlUrl,
        });
      } catch (repoError: any) {
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

    const estimation = doc.estimation as any;
    const rawTasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];

    // ✅ NORMALIZACIÓN RESPUESTA: projectRepo dentro de project (como espera el frontend)
    const projectRepo =
      doc.projectRepo && doc.projectRepo.fullName && doc.projectRepo.htmlUrl
        ? { fullName: doc.projectRepo.fullName, htmlUrl: doc.projectRepo.htmlUrl }
        : null;

    return res.status(200).json({
      project: {
        id: String(doc._id),
        title: doc.projectTitle,
        description: doc.projectDescription,
        ownerEmail: doc.ownerEmail,
        published: doc.isPublished,
        projectRepo,
      },
      projectRepo, // compat opcional
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

    if (!doc.projectRepo || !doc.projectRepo.fullName || !doc.projectRepo.htmlUrl) {
      return res.status(400).json({ error: "project_repo_missing" });
    }


    const status = await ensureRepoMember(id, userEmail);

    if (String(doc.ownerEmail).toLowerCase() === userEmail.toLowerCase()) {
      return res.status(200).json({
        joined: !!status?.joined,
        state: status?.state,        // ✅ NUEVO
        repoUrl: status?.repoUrl,
        repoFullName: status?.repoFullName,
      });
    }

    return res.status(200).json({
      joined: !!status?.joined,
      state: status?.state,        // ✅ NUEVO
      repoUrl: status?.repoUrl,
      repoFullName: status?.repoFullName,
    });
  } catch (error: any) {
    if (mapRepoErrorToResponse(error, res)) return;

    console.error("[community] Error obteniendo estado de repo:", error);
    return res.status(500).json({ error: "Error interno obteniendo estado del repo" });
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

      if (!doc.projectRepo || !doc.projectRepo.fullName || !doc.projectRepo.htmlUrl) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      if (String(doc.ownerEmail).toLowerCase() === userEmail.toLowerCase()) {
        return res.status(200).json({
          joined: true,
          repoUrl: doc.projectRepo.htmlUrl,
          repoFullName: doc.projectRepo.fullName,
        });
      }

      const result = await inviteUserToRepo(id, userEmail);

      const io = getIO();
      io.to(`community:${id}`).emit("community:userInvitedToRepo", {
        projectId: id,
        userEmail,
        repoUrl: result.repoUrl,
      });

      return res.status(200).json({
        joined: !!result.joined,
        repoUrl: result.repoUrl ?? doc.projectRepo.htmlUrl,
        repoFullName: result.repoFullName ?? doc.projectRepo.fullName,
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

    const repoFullName =
      typeof doc.projectRepo === "string"
        ? doc.projectRepo
        : doc.projectRepo?.fullName || doc.projectRepo?.repoFullName || null;

    if (repoFullName) {
      try {
        const [owner, repo] = String(repoFullName).split("/");
        if (owner && repo) {
          const { client } = await getOctokitForEmail(doc.ownerEmail);
          await client.getRepo(owner, repo);
          await client.deleteRepo(owner, repo);

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
      repoFullName,
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

      const projectRepoFullName =
        typeof doc.projectRepo === "string"
          ? doc.projectRepo
          : doc.projectRepo?.fullName || doc.projectRepo?.repoFullName || null;

      if (!projectRepoFullName || !String(projectRepoFullName).includes("/")) {
        return res.status(400).json({ error: "project_repo_missing" });
      }

      // ✅ debe ser miembro/invitado antes de asignar
      try {
        const membership = await ensureRepoMember(id, userEmail);
        if (membership?.state !== "ACTIVE") {
          return res.status(403).json({
            error: "repo_access_required",
            state: membership?.state || "NONE",
            repoUrl: membership?.repoUrl,
          });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

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

      // ─────────────────────────────────────────────
      // ✅ TODO -> DOING: crear branch + spec + tests + workflow(s)
      // ─────────────────────────────────────────────
      ensureTaskDefaults(task);

      if (!task.repo) {
        task.repo = { provider: "github", repoFullName: projectRepoFullName, checks: { status: "IDLE" } };
      }
      if (!task.repo.repoFullName) task.repo.repoFullName = projectRepoFullName;
      if (!task.repo.checks) task.repo.checks = { status: "IDLE" };

      const proposedBranch =
        task.repo.branch ||
        buildTaskBranchName({ id: String(task.id), title: task.title || task.description || "task" });

      // 1) Crear rama si no existe (solo una vez)
      if (!task.repo.branch) {
        try {
          await createBranchFromDefault(doc.ownerEmail, projectRepoFullName, proposedBranch);
          task.repo.branch = proposedBranch;
        } catch (e: any) {
          const msg = String(e?.message || "");
          const status = e?.status;

          if (msg.includes("Reference already exists") || String(status) === "422") {
            task.repo.branch = proposedBranch;
          } else {
            console.error("[community:branch] create failed", {
              projectId: id,
              taskId,
              repo: projectRepoFullName,
              branch: proposedBranch,
              status,
              message: msg,
            });
            return res.status(500).json({ error: "branch_create_failed" });
          }
        }
      }

      const branch = String(task.repo.branch || proposedBranch);

      // 2) Crear en la rama: spec + runner + community-workflow + tests autogenerados
      //    ✅ Usamos helper único para evitar problemas de tipos y “Cannot find name…”
      let spec: any;
      try {
        const result = await ensureVerificationAssetsOnBranch({
          repoFullName: projectRepoFullName,
          branch,
          task: {
            id: String(task.id),
            title: task.title,
            description: task.description,
            acceptanceCriteria: task.acceptanceCriteria,
          },
          actorEmail: doc.ownerEmail,

          // Si tu generador de tareas ya define stack, pásalo aquí para influir en tests:
          // stack: (estimation?.stack as RepoStack) || undefined,
        });

        spec = result.spec;
      } catch (e: any) {
        console.error("[community:assign] verification assets commit failed", {
          projectId: id,
          taskId,
          repo: projectRepoFullName,
          branch,
          message: e?.message,
          status: e?.status,
        });
        return res.status(500).json({ error: "spec_commit_failed" });
      }

      // 3) checklist basado en spec (pending)
      task.checklist = buildChecklistFromSpec(spec, task.checklist, {
        forcePending: true,
        includeRuleDetails: true,
      });

      // ✅ asignación + estado
      task.assigneeEmail = userEmail;
      task.assigneeAvatar = userAvatar ?? task.assigneeAvatar ?? null;
      task.columnId = "doing";
      task.status = "IN_PROGRESS";
      task.verificationStatus = task.verificationStatus ?? "NOT_SUBMITTED";

      // ✅ checks quedan PENDING hasta que en Review se ejecute run-verify
      task.repo.checks = task.repo.checks || {};
      task.repo.checks.status = "PENDING";
      task.repo.checks.lastRunConclusion = null;
      task.repo.checks.lastRunUrl = undefined;

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
    res: Response<{ tasks: BoardTask[] } | { error: string }>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: "Proyecto no encontrado" });
      }

      await normalizeAndPersistTaskIds(doc);

      // 🔐 Permisos repo
      try {
        const membership = await ensureRepoMember(id, userEmail);
        if (!membership?.joined) {
          return res.status(403).json({ error: "repo_access_required" });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      // 👤 solo el asignado
      if (task.assigneeEmail !== userEmail) {
        return res.status(403).json({ error: "No eres el asignado a esta tarea" });
      }

      // 📌 solo desde doing
      if ((task.columnId ?? "todo") !== "doing") {
        return res.status(400).json({ error: 'Solo se pueden desasignar tareas en "Haciendo"' });
      }

      // ─────────────────────────────────────────────
      // ✅ AQUÍ VA EL BORRADO CONDICIONAL DE RAMA
      // ─────────────────────────────────────────────
      const repoFullName =
        task?.repo?.repoFullName ||
        (typeof doc.projectRepo === "string"
          ? doc.projectRepo
          : doc.projectRepo?.fullName || null);

      const branch = task?.repo?.branch;

      if (repoFullName && branch) {
        try {
          const result = await safeDeleteBranchIfNoCommits(
            doc.ownerEmail,     // owner del proyecto
            repoFullName,       // owner/repo
            branch              // nombre de la rama
          );

          console.log("[community:branch] unassign cleanup", {
            projectId: id,
            taskId,
            repoFullName,
            branch,
            result,
          });

          // si se borró → limpiamos la rama en la tarea
          if (result.deleted && task.repo) {
            task.repo.branch = undefined;
          }
        } catch (e: any) {
          // ⚠️ nunca romper el unassign por GitHub
          console.warn("[community:branch] cleanup skipped", {
            projectId: id,
            taskId,
            repoFullName,
            branch,
            error: e?.message,
          });
        }
      }

      // ─────────────────────────────────────────────
      // ✅ DESASIGNACIÓN NORMAL
      // ─────────────────────────────────────────────
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

      return res.status(200).json({
        tasks: tasks.map((t) => mapTaskToBoard(t)),
      });
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
    res: Response<{ tasks: BoardTask[] } | { error: string }>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);

      try {
        const membership = await ensureRepoMember(id, userEmail);
        if (!membership?.joined) {
          return res.status(403).json({ error: "repo_access_required" });
        }
      } catch (error: any) {
        if (mapRepoErrorToResponse(error, res)) return;
        throw error;
      }

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

      ensureTaskDefaults(task);

      const projectRepoFullName =
        typeof doc.projectRepo === "string"
          ? doc.projectRepo
          : doc.projectRepo?.fullName || doc.projectRepo?.repoFullName || null;

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
    res: Response<{ tasks: BoardTask[] } | { error: string }>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);

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

      ensureTaskDefaults(task);

      const projectRepoFullName =
        typeof doc.projectRepo === "string"
          ? doc.projectRepo
          : doc.projectRepo?.fullName || doc.projectRepo?.repoFullName || null;

      const taskRepoFullName = task?.repo?.repoFullName || (task as any)?.repoFullName || null;

      const repoFullName = String(taskRepoFullName || projectRepoFullName || "").trim();
      if (!repoFullName || !repoFullName.includes("/")) {
        return res.status(400).json({ error: "La tarea no tiene repo vinculado" });
      }

      // ✅ debe ser miembro ACTIVE
      try {
        const membership = await ensureRepoMember(id, userEmail);
        if (membership?.state !== "ACTIVE") {
          return res.status(403).json({
            error: "repo_access_required",
            state: membership?.state || "NONE",
            repoUrl: membership?.repoUrl,
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

      // Si no existe branch, intentamos crear (pero sin romper si ya existe)
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

      // ─────────────────────────────────────────────
      // ✅ 1) Asegurar SPEC en rama de tarea
      // ─────────────────────────────────────────────
      let spec = await fetchVerificationSpec(repoFullName, finalBranch, String(task.id), doc.ownerEmail);
      const generatedSpec = generateVerificationSpec({
        id: String(task.id),
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
      });
      if (!spec) spec = generatedSpec;

      try {
        await commitFileToBranch(
          repoFullName,
          finalBranch,
          `${SPEC_PATH}/task-${task.id}.json`,
          JSON.stringify(spec, null, 2),
          `chore: ensure verification spec for task ${task.id}`,
          doc.ownerEmail
        );
      } catch (error: any) {
        console.error("[community:run-verify] spec commit failed", {
          projectId: id,
          taskId,
          repo: repoFullName,
          branch: finalBranch,
          message: error?.message,
        });
        return res.status(500).json({ error: "spec_commit_failed" });
      }

      // Checklist (se queda en pending antes de correr)
      task.checklist = buildChecklistFromSpec(spec, task.checklist, {
        forcePending: true,
        includeRuleDetails: true,
      });

      // ─────────────────────────────────────────────
      // ✅ 2) Asegurar runner en rama de tarea
      // ─────────────────────────────────────────────
      try {
        await commitFileToBranch(
          repoFullName,
          finalBranch,
          ".community/runner/verify.mjs",
          buildCommunityVerifyRunner(),
          "chore: ensure community verify runner",
          doc.ownerEmail
        );
      } catch (error: any) {
        console.error("[community:run-verify] runner commit failed", {
          projectId: id,
          taskId,
          repo: repoFullName,
          branch: finalBranch,
          message: error?.message,
        });
        return res.status(500).json({ error: "verification_setup_failed" });
      }

      // ─────────────────────────────────────────────
      // ✅ 3) Asegurar workflow DISPATCH en default branch (main/master)
      //     (NO en la rama de la tarea)
      // ─────────────────────────────────────────────
      const DISPATCH_WORKFLOW_ID = "verify.yml";
      const DISPATCH_WORKFLOW_PATH = ".github/workflows/verify.yml";

      const buildVerifyDispatchWorkflow = () => `name: verify

on:
  workflow_dispatch:
    inputs:
      projectId:
        description: "Community project id"
        required: true
      taskId:
        description: "Task id"
        required: true
      branch:
        description: "Task branch to verify"
        required: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout task branch
        uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch }}
          fetch-depth: 0

      - name: Fetch base refs (origin/main or origin/master)
        run: |
          git remote -v
          git fetch origin main:refs/remotes/origin/main || true
          git fetch origin master:refs/remotes/origin/master || true

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run community verification
        run: node .community/runner/verify.mjs --task=\${{ inputs.taskId }}
`;

      const ensureWorkflowOnDefaultBranch = async () => {
        const content = buildVerifyDispatchWorkflow();

        // Probamos main -> master
        const candidates = ["main", "master"];
        let lastErr: any = null;

        for (const baseBranch of candidates) {
          try {
            await commitFileToBranch(
              repoFullName,
              baseBranch,
              DISPATCH_WORKFLOW_PATH,
              content,
              "chore: ensure verify workflow",
              doc.ownerEmail
            );
            return;
          } catch (e: any) {
            lastErr = e;
          }
        }

        console.error("[community:run-verify] cannot ensure dispatch workflow on default branch", {
          repo: repoFullName,
          message: lastErr?.message,
          status: lastErr?.status,
        });
        throw new Error("workflow_missing_in_default_branch");
      };

      try {
        await ensureWorkflowOnDefaultBranch();
      } catch (e: any) {
        return res.status(500).json({
          error:
            e?.message === "workflow_missing_in_default_branch"
              ? "workflow_missing_in_default_branch"
              : "verification_setup_failed",
        });
      }

      // Marcar estado submitted/pending
      task.repo.checks.status = "PENDING";
      task.repo.checks.lastRunConclusion = null;
      task.repo.checks.lastRunUrl = undefined;

      task.verificationStatus = "SUBMITTED";
      task.verification = task.verification || { status: "SUBMITTED" };
      task.verification.status = "SUBMITTED";

      // Guardar antes de dispatch
      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");
      await doc.save();

      // ─────────────────────────────────────────────
      // ✅ 4) DISPATCH del workflow correcto (verify.yml)
      // ─────────────────────────────────────────────
      try {
        await triggerWorkflow(
          repoFullName,
          finalBranch, // ref para dispatch (tu helper lo usa también en inputs)
          { projectId: id, taskId: String(task.id) },
          doc.ownerEmail,
          DISPATCH_WORKFLOW_ID
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

      // pequeña espera para permitir creación de run
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const runInfo = await pollOrFetchLatestRun(repoFullName, finalBranch, doc.ownerEmail, DISPATCH_WORKFLOW_ID);
      const conclusion = runInfo.conclusion;

      if (conclusion) {
        const allPassed = conclusion === "success";
        task.repo.checks.status = allPassed ? "PASSED" : "FAILED";
        task.repo.checks.lastRunConclusion = conclusion;
        task.repo.checks.lastRunUrl = runInfo.url;

        task.checklist = (task.checklist || []).map((item: ChecklistItem) => ({
          ...item,
          status: allPassed ? "PASSED" : "FAILED",
        }));

        if (allPassed) {
          task.columnId = "done";
          task.status = "DONE";
          task.verificationStatus = "APPROVED";
          task.verification = task.verification || { status: "APPROVED" };
          task.verification.status = "APPROVED";
          task.verificationNotes = runInfo.url ? `Verificación aprobada. Run: ${runInfo.url}` : "Verificación aprobada.";
        } else {
          task.columnId = "doing";
          task.status = "IN_PROGRESS";
          task.verificationStatus = "REJECTED";
          task.verification = task.verification || { status: "REJECTED" };
          task.verification.status = "REJECTED";
          task.verificationNotes = runInfo.url
            ? `Verificación fallida (${conclusion}). Revisa el run: ${runInfo.url}`
            : `Verificación fallida (${conclusion}).`;
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
