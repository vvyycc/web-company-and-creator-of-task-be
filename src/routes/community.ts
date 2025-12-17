// src/routes/community.ts
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { GithubAccount } from "../models/GithubAccount";
import { RepoMembership } from "../models/RepoMembership";
import { getIO } from "../socket";
import { checkCollaborator, createProjectRepo } from "../services/github";

export type ColumnId = "todo" | "doing" | "review" | "done";

export type TaskCategory =
  | "ARCHITECTURE"
  | "MODEL"
  | "SERVICE"
  | "VIEW"
  | "INFRA"
  | "QA";

export type TaskStatus =
  | "TODO"
  | "IN_PROGRESS"
  | "IN_REVIEW"
  | "DONE"
  | "REJECTED";
export type VerificationStatus =
  | "NOT_SUBMITTED"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED";

export type RepoCheckStatus = "IDLE" | "PENDING" | "PASSED" | "FAILED";

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
}

const router = express.Router();

const BOARD_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: "todo", title: "Por hacer", order: 1 },
  { id: "doing", title: "Haciendo", order: 2 },
  { id: "review", title: "Revisión", order: 3 },
  { id: "done", title: "Hecho", order: 4 },
];

const MAX_DOING_PER_USER = 2;

async function updateMembership(
  projectId: string,
  userEmail: string,
  githubLogin: string,
  status: "INVITED" | "ACCEPTED",
  timestamps: Partial<{ invitedAt: Date; acceptedAt: Date; lastCheckedAt: Date }>
) {
  return RepoMembership.findOneAndUpdate(
    { projectId, userEmail },
    {
      projectId,
      userEmail,
      githubLogin,
      status,
      ...timestamps,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function isRepoAccepted(doc: any, userEmail: string) {
  if (doc?.ownerEmail === userEmail) return true;

  const repoFullName = doc?.projectRepo?.fullName;
  if (!repoFullName) return false;

  const userAccount = await GithubAccount.findOne({ userEmail });
  const ownerAccount = await GithubAccount.findOne({ userEmail: doc.ownerEmail });

  if (!userAccount || !ownerAccount) return false;

  try {
    const accepted = await checkCollaborator(
      repoFullName,
      userAccount.githubLogin,
      ownerAccount.accessToken
    );

    await RepoMembership.findOneAndUpdate(
      { projectId: doc._id, userEmail },
      {
        projectId: doc._id,
        userEmail,
        githubLogin: userAccount.githubLogin,
        status: accepted ? "ACCEPTED" : "INVITED",
        acceptedAt: accepted ? new Date() : undefined,
        lastCheckedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return accepted;
  } catch (error) {
    console.error("[repo] Error comprobando colaborador:", error);
    return false;
  }
}

function isValidObjectIdString(v: unknown) {
  return typeof v === "string" && mongoose.Types.ObjectId.isValid(v);
}

/**
 * ✅ MIGRACIÓN EN CALIENTE:
 * Si hay tareas legacy con id tipo "task-0", vacío o duplicado,
 * les asignamos un ObjectId REAL y lo guardamos en Mongo.
 * Además, inicializamos los campos nuevos de verificación/repositorio
 * para no romper el front.
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
  };
};

export const emitBoardUpdate = (projectId: string, tasks: any[]) => {
  const io = getIO();
  io.to(`community:${projectId}`).emit("community:boardUpdated", {
    projectId,
    tasks: tasks.map((t) => mapTaskToBoard(t)),
  });
};

/* ─────────────────────────────────────────────────────────
   ✅ REALTIME PARA LISTADO (/community)
   Necesitas que socket.ts tenga join/leave al room "community:list"
   (community:list:join / community:list:leave)
   ───────────────────────────────────────────────────────── */

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
    res: Response<
      | { id: string; publicUrl: string; repo?: { fullName: string; htmlUrl: string } }
      | { error: string }
    >
  ) => {
    try {
      const { ownerEmail, projectTitle, projectDescription, estimation } =
        req.body || {};

      if (!ownerEmail || !projectTitle || !projectDescription || !estimation) {
        return res.status(400).json({
          error:
            "ownerEmail, projectTitle, projectDescription y estimation son obligatorios",
        });
      }

      await connectMongo();

      const ownerAccount = await GithubAccount.findOne({ userEmail: ownerEmail });
      if (!ownerAccount) {
        return res.status(400).json({ error: "github_not_connected_owner" });
      }

      const hasRepoScope = (ownerAccount.scopes || []).includes("repo");
      if (!hasRepoScope) {
        return res.status(403).json({ error: "missing_repo_scope" });
      }

      const tasks: any[] = Array.isArray(estimation?.tasks)
        ? estimation.tasks
        : [];

      // ✅ normalizamos tasks al publicar (ids válidos y persistidos)
      const used = new Set<string>();
      estimation.tasks = tasks.map((t: any) => {
        let id = String(t?.id ?? t?._id ?? "");
        if (!mongoose.Types.ObjectId.isValid(id) || used.has(id)) {
          id = new mongoose.Types.ObjectId().toString();
        }
        used.add(id);

        const columnId = ((t.columnId as ColumnId) ?? "todo") as ColumnId;

        return {
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
          acceptanceCriteria: t.acceptanceCriteria ?? t.acceptance ?? undefined,
          verificationNotes: t.verificationNotes ?? "",
        };
      });

      const doc: any = await CommunityProject.create({
        ownerEmail,
        projectTitle,
        projectDescription,
        estimation,
        isPublished: true,
      });

      try {
        const repo = await createProjectRepo(
          ownerEmail,
          doc._id.toString(),
          projectTitle,
          projectDescription
        );

        doc.projectRepo = repo;
        doc.repoSlug = repo.repoName;
        await doc.save();
      } catch (error) {
        console.error("[community] Error creando repositorio:", error);
        await doc.deleteOne();
        return res.status(500).json({ error: "github_create_repo_failed" });
      }

      const id = doc._id.toString();
      const publicUrl = `/community/${id}`;

      // ✅ realtime: avisar a todos los que están en /community
      const tasksRaw: any[] = Array.isArray(estimation?.tasks)
        ? estimation.tasks
        : [];

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
      });

      return res
        .status(200)
        .json({ id, publicUrl, repo: { fullName: doc.projectRepo.fullName, htmlUrl: doc.projectRepo.htmlUrl } });
    } catch (error) {
      console.error("[community] Error creando proyecto de comunidad:", error);
      return res
        .status(500)
        .json({ error: "Error interno creando proyecto de comunidad" });
    }
  }
);

// ----------------- GET board -----------------
router.get(
  "/projects/:id/board",
  async (req: Request<{ id: string }>, res: Response<any>) => {
    try {
      await connectMongo();
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ error: "Identificador de proyecto no válido" });
      }

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) {
        return res
          .status(404)
          .json({ error: "Proyecto de comunidad no encontrado" });
      }

      // ✅ MIGRA ids legacy AQUÍ (arregla /assign 404 en proyectos antiguos)
      await normalizeAndPersistTaskIds(doc);

      const estimation = doc.estimation as any;
      const rawTasks: any[] = Array.isArray(estimation?.tasks)
        ? estimation.tasks
        : [];

      return res.status(200).json({
        project: {
          id: String(doc._id),
          title: doc.projectTitle,
          description: doc.projectDescription,
          ownerEmail: doc.ownerEmail,
          published: doc.isPublished,
        },
        columns: BOARD_COLUMNS,
        tasks: rawTasks.map((t) => mapTaskToBoard(t)),
      });
    } catch (error) {
      console.error("[community] Error obteniendo tablero de comunidad:", error);
      return res
        .status(500)
        .json({ error: "Error interno obteniendo tablero de comunidad" });
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
      const tasksRaw: any[] = Array.isArray(estimation?.tasks)
        ? estimation.tasks
        : [];

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
    return res
      .status(500)
      .json({ error: "Error interno listando proyectos de comunidad" });
  }
});

// ----------------- DELETE community project (✅ usar /community/projects/:id) -----------------
router.delete(
  "/projects/:id",
  async (
    req: Request<{ id: string }>,
    res: Response<{ message: string } | { error: string }>
  ) => {
    try {
      await connectMongo();
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res
          .status(400)
          .json({ error: "Identificador de proyecto no válido" });
      }

      const userEmail = String(req.headers["x-user-email"] || "").trim();
      if (!userEmail) {
        return res
          .status(401)
          .json({ error: "Debes iniciar sesión para borrar proyectos." });
      }

      const doc: any = await CommunityProject.findById(id);
      if (!doc) return res.status(404).json({ error: "Proyecto no encontrado" });

      if (String(doc.ownerEmail).toLowerCase() !== userEmail.toLowerCase()) {
        return res.status(403).json({
          error: "No autorizado: solo el owner puede borrar este proyecto.",
        });
      }

      await doc.deleteOne();

      // ✅ realtime: avisar a todos los que están en /community
      emitCommunityProjectDeleted({ id });

      return res
        .status(200)
        .json({ message: "Proyecto eliminado correctamente" });
    } catch (error) {
      console.error("[community] Error eliminando proyecto:", error);
      return res
        .status(500)
        .json({ error: "Error interno al eliminar el proyecto" });
    }
  }
);

// ----------------- INVITE TO REPO (owner) -----------------
router.post(
  "/projects/:projectId/repo/invite",
  async (
    req: Request<{ projectId: string }, unknown, { ownerEmail?: string; userEmailToInvite?: string }>,
    res: Response
  ) => {
    try {
      const { projectId } = req.params;
      const { ownerEmail, userEmailToInvite } = req.body || {};

      if (!ownerEmail || !userEmailToInvite) {
        return res.status(400).json({ error: "ownerEmail y userEmailToInvite son obligatorios" });
      }

      await connectMongo();
      const doc: any = await CommunityProject.findById(projectId);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      if (String(doc.ownerEmail).toLowerCase() !== String(ownerEmail).toLowerCase()) {
        return res.status(403).json({ error: "No autorizado" });
      }

      if (!doc.projectRepo?.fullName) {
        return res.status(404).json({ error: "Repositorio no disponible" });
      }

      const ownerAccount = await GithubAccount.findOne({ userEmail: ownerEmail });
      if (!ownerAccount) return res.status(400).json({ error: "github_not_connected_owner" });
      if (!(ownerAccount.scopes || []).includes("repo")) {
        return res.status(403).json({ error: "missing_repo_scope" });
      }

      const invitedAccount = await GithubAccount.findOne({ userEmail: userEmailToInvite });
      if (!invitedAccount)
        return res.status(400).json({ error: "github_not_connected_user" });

      const [owner, repo] = doc.projectRepo.fullName.split("/");
      const inviteRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/collaborators/${invitedAccount.githubLogin}`,
        {
          method: "PUT",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${ownerAccount.accessToken}`,
            "User-Agent": "community-verifier/1.0",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ permission: "push" }),
        }
      );

      if (![201, 202, 204].includes(inviteRes.status)) {
        const text = await inviteRes.text();
        if (inviteRes.status === 404 || inviteRes.status === 403 || inviteRes.status === 422) {
          return res.status(inviteRes.status).json({ error: text || "github_invite_failed" });
        }
        console.error("[community] Invite failed", inviteRes.status, text);
        return res.status(500).json({ error: "github_invite_failed" });
      }

      await updateMembership(
        projectId,
        userEmailToInvite,
        invitedAccount.githubLogin,
        "INVITED",
        { invitedAt: new Date(), lastCheckedAt: new Date() }
      );

      const io = getIO();
      io.to(userEmailToInvite).emit("community:userInvitedToRepo", {
        projectId,
        repoUrl: doc.projectRepo.htmlUrl,
      });

      return res
        .status(200)
        .json({ ok: true, status: "INVITED", repoUrl: doc.projectRepo.htmlUrl });
    } catch (error) {
      console.error("[community] Error invitando al repo:", error);
      return res.status(500).json({ error: "github_invite_failed" });
    }
  }
);

// ----------------- REPO STATUS -----------------
router.get(
  "/projects/:projectId/repo/status",
  async (
    req: Request<{ projectId: string }, unknown, unknown, { userEmail?: string }>,
    res: Response
  ) => {
    try {
      const { projectId } = req.params;
      const userEmail = String(req.query.userEmail || "").trim();

      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();
      const doc: any = await CommunityProject.findById(projectId);
      if (!doc || !doc.isPublished)
        return res.status(404).json({ error: "Proyecto no encontrado" });

      if (!doc.projectRepo?.fullName) {
        return res.status(200).json({ joined: false, status: "NOT_READY" });
      }

      const userAccount = await GithubAccount.findOne({ userEmail });
      if (!userAccount) {
        return res.status(200).json({ joined: false, status: "NOT_CONNECTED" });
      }

      const ownerAccount = await GithubAccount.findOne({ userEmail: doc.ownerEmail });
      if (!ownerAccount) {
        return res.status(200).json({ joined: false, status: "NOT_CONNECTED" });
      }

      const joined = await checkCollaborator(
        doc.projectRepo.fullName,
        userAccount.githubLogin,
        ownerAccount.accessToken
      );

      if (joined) {
        await updateMembership(
          projectId,
          userEmail,
          userAccount.githubLogin,
          "ACCEPTED",
          { acceptedAt: new Date(), lastCheckedAt: new Date() }
        );
        return res.status(200).json({
          joined: true,
          status: "ACCEPTED",
          repoUrl: doc.projectRepo.htmlUrl,
        });
      }

      await updateMembership(
        projectId,
        userEmail,
        userAccount.githubLogin,
        "INVITED",
        { lastCheckedAt: new Date() }
      );

      return res.status(200).json({
        joined: false,
        status: "INVITED_OR_NOT",
        repoUrl: doc.projectRepo.htmlUrl,
      });
    } catch (error) {
      console.error("[community] Error consultando estado de repo:", error);
      return res.status(500).json({ error: "repo_status_failed" });
    }
  }
);

// ----------------- REPO JOIN -----------------
router.post(
  "/projects/:projectId/repo/join",
  async (
    req: Request<{ projectId: string }, unknown, { userEmail?: string }>,
    res: Response
  ) => {
    try {
      const { projectId } = req.params;
      const { userEmail } = req.body || {};

      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();
      const doc: any = await CommunityProject.findById(projectId);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      if (!doc.projectRepo?.fullName) {
        return res.status(404).json({ error: "Repositorio no disponible" });
      }

      const userAccount = await GithubAccount.findOne({ userEmail });
      if (!userAccount)
        return res.status(400).json({ error: "github_not_connected_user" });

      const ownerAccount = await GithubAccount.findOne({ userEmail: doc.ownerEmail });
      if (!ownerAccount)
        return res.status(400).json({ error: "github_not_connected_owner" });

      const alreadyMember = await checkCollaborator(
        doc.projectRepo.fullName,
        userAccount.githubLogin,
        ownerAccount.accessToken
      );

      if (alreadyMember) {
        await updateMembership(
          projectId,
          userEmail,
          userAccount.githubLogin,
          "ACCEPTED",
          { acceptedAt: new Date(), lastCheckedAt: new Date() }
        );

        return res.status(200).json({
          ok: true,
          joined: true,
          status: "ACCEPTED",
          repoUrl: doc.projectRepo.htmlUrl,
        });
      }

      const existing = await RepoMembership.findOne({ projectId, userEmail });
      if (existing?.status === "INVITED") {
        return res.status(200).json({
          ok: true,
          joined: false,
          action: "ACCEPT_INVITE",
          repoUrl: doc.projectRepo.htmlUrl,
        });
      }

      return res.status(403).json({ error: "not_invited_yet" });
    } catch (error) {
      console.error("[community] Error join repo:", error);
      return res.status(500).json({ error: "join_repo_failed" });
    }
  }
);

// ----------------- ASSIGN (todo -> doing) -----------------
router.post(
  "/projects/:id/tasks/:taskId/assign",
  async (
    req: Request<
      { id: string; taskId: string },
      unknown,
      { userEmail?: string; userAvatar?: string }
    >,
    res: Response<{ tasks: BoardTask[] } | { error: string }>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail, userAvatar } = req.body || {};
      if (!userEmail)
        return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();

      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished)
        return res.status(404).json({ error: "Proyecto no encontrado" });

      // ✅ asegura ids válidos en proyectos antiguos antes de buscar
      await normalizeAndPersistTaskIds(doc);

      if (doc.ownerEmail === userEmail) {
        return res
          .status(403)
          .json({ error: "El creador del proyecto no puede tomar tareas" });
      }

      const joined = await isRepoAccepted(doc, userEmail);
      if (!joined) {
        console.warn(
          `[community] Movimiento bloqueado repo_not_joined project=${id} user=${userEmail}`
        );
        return res.status(403).json({ error: "repo_not_joined" });
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
        return res
          .status(400)
          .json({ error: 'Solo se pueden asignar tareas en "Por hacer"' });
      }

      if (task.assigneeEmail && task.assigneeEmail !== userEmail) {
        return res.status(409).json({ error: "task_already_assigned" });
      }

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
        return res.status(403).json({ error: "No eres el asignado a esta tarea" });
      }

      if (doc.ownerEmail !== userEmail) {
        const joined = await isRepoAccepted(doc, userEmail);
        if (!joined) {
          console.warn(
            `[community] Movimiento bloqueado repo_not_joined project=${id} user=${userEmail}`
          );
          return res.status(403).json({ error: "repo_not_joined" });
        }
      }

      if ((task.columnId ?? "todo") !== "doing") {
        return res.status(400).json({ error: 'Solo se pueden desasignar tareas en "Haciendo"' });
      }

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

      if (doc.ownerEmail !== userEmail) {
        const joined = await isRepoAccepted(doc, userEmail);
        if (!joined) {
          console.warn(
            `[community] Movimiento bloqueado repo_not_joined project=${id} user=${userEmail}`
          );
          return res.status(403).json({ error: "repo_not_joined" });
        }
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

export default router;
