// src/routes/community.ts
import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { getIO } from "../socket";

export type ColumnId = "todo" | "doing" | "done";

export type TaskCategory =
  | "ARCHITECTURE"
  | "MODEL"
  | "SERVICE"
  | "VIEW"
  | "INFRA"
  | "QA";

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
}

const router = express.Router();

const BOARD_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: "todo", title: "Por hacer", order: 1 },
  { id: "doing", title: "Haciendo", order: 2 },
  { id: "done", title: "Hecho", order: 3 },
];

const MAX_DOING_PER_USER = 2;

const ensureTaskId = (task: any, fallbackIndex: number) => {
  if (task?.id) return String(task.id);
  return `task-${fallbackIndex}`;
};

const mapTaskToBoard = (task: any, index = 0): BoardTask => ({
  id: ensureTaskId(task, index),
  title: task.title,
  description: task.description,
  price: task.taskPrice ?? task.price ?? 0,
  priority: task.priority ?? 0,
  layer: (task.layer ?? task.category ?? "SERVICE") as TaskCategory,
  columnId: (task.columnId as ColumnId) ?? "todo",
  assigneeEmail: task.assigneeEmail ?? null,
  assigneeAvatar: task.assigneeAvatar ?? null,
});

const emitBoardUpdate = (projectId: string, tasks: any[]) => {
  const io = getIO();
  io.to(`community:${projectId}`).emit("community:boardUpdated", {
    projectId,
    tasks: tasks.map((t, idx) => mapTaskToBoard(t, idx)),
  });
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

      const tasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];
      estimation.tasks = tasks.map((t, idx) => ({
        ...t,
        id: ensureTaskId(t, idx),
        columnId: (t.columnId as ColumnId) ?? "todo",
        assigneeEmail: t.assigneeEmail ?? null,
        assigneeAvatar: t.assigneeAvatar ?? null,
      }));

      const doc = await CommunityProject.create({
        ownerEmail,
        projectTitle,
        projectDescription,
        estimation,
        isPublished: true,
      });

      const id = doc._id.toString();
      const publicUrl = `/community/${id}`;

      return res.status(200).json({ id, publicUrl });
    } catch (error) {
      console.error("[community] Error creando proyecto de comunidad:", error);
      return res.status(500).json({ error: "Error interno creando proyecto de comunidad" });
    }
  }
);

// ----------------- GET board -----------------
router.get(
  "/projects/:id/board",
  async (
    req: Request<{ id: string }>,
    res: Response<
      | {
          project: {
            id: string;
            title: string;
            description: string;
            ownerEmail: string;
            published: boolean;
          };
          columns: typeof BOARD_COLUMNS;
          tasks: BoardTask[];
        }
      | { error: string }
    >
  ) => {
    try {
      await connectMongo();
      const { id } = req.params;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Identificador de proyecto no válido" });
      }

      const doc = await CommunityProject.findById(id).lean();
      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: "Proyecto de comunidad no encontrado" });
      }

      const estimation = doc.estimation as any;
      const rawTasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];

      const tasks = rawTasks.map((t, idx) => mapTaskToBoard(t, idx));

      return res.status(200).json({
        project: {
          id: String(doc._id),
          title: doc.projectTitle,
          description: doc.projectDescription,
          ownerEmail: doc.ownerEmail,
          published: doc.isPublished,
        },
        columns: BOARD_COLUMNS,
        tasks,
      });
    } catch (error) {
      console.error("[community] Error obteniendo tablero de comunidad:", error);
      return res.status(500).json({ error: "Error interno obteniendo tablero de comunidad" });
    }
  }
);

// ----------------- GET list -----------------
router.get("/projects", async (_req: Request, res: Response) => {
  try {
    await connectMongo();
    const docs = await CommunityProject.find({ isPublished: true }).lean();

    const list = docs.map((doc) => {
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
        publishedAt: (doc as any).createdAt ?? (doc as any).updatedAt,
      };
    });

    return res.status(200).json(list);
  } catch (error) {
    console.error("[community] Error listando proyectos de comunidad:", error);
    return res.status(500).json({ error: "Error interno listando proyectos de comunidad" });
  }
});

// ----------------- DELETE community project -----------------
// ✅ DELETE /community/projects/:id  (owner-only)
router.delete(
  "/projects/:id",
  async (req: Request<{ id: string }>, res: Response<{ message: string } | { error: string }>) => {
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

      const doc = await CommunityProject.findById(id);
      if (!doc) return res.status(404).json({ error: "Proyecto no encontrado" });

      if (doc.ownerEmail.toLowerCase() !== userEmail.toLowerCase()) {
        return res.status(403).json({ error: "No autorizado: solo el owner puede borrar este proyecto." });
      }

      await doc.deleteOne();
      return res.status(200).json({ message: "Proyecto eliminado correctamente" });
    } catch (error) {
      console.error("[community] Error eliminando proyecto:", error);
      return res.status(500).json({ error: "Error interno al eliminar el proyecto" });
    }
  }
);

// ----------------- ASSIGN (todo -> doing) -----------------
router.post(
  "/projects/:id/tasks/:taskId/assign",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string; userAvatar?: string }>,
    res: Response<{ tasks: BoardTask[] } | { error: string }>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail, userAvatar } = req.body || {};
      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();
      const doc = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      if (doc.ownerEmail === userEmail) {
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

      task.assigneeEmail = userEmail;
      task.assigneeAvatar = userAvatar ?? task.assigneeAvatar ?? null;
      task.columnId = "doing";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");

      await doc.save();
      emitBoardUpdate(id, tasks);

      return res.status(200).json({ tasks: tasks.map((t, idx) => mapTaskToBoard(t, idx)) });
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
      const doc = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

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

      task.assigneeEmail = null;
      task.assigneeAvatar = null;
      task.columnId = "todo";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");

      await doc.save();
      emitBoardUpdate(id, tasks);

      return res.status(200).json({ tasks: tasks.map((t, idx) => mapTaskToBoard(t, idx)) });
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
      const doc = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

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

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");

      await doc.save();
      emitBoardUpdate(id, tasks);

      return res.status(200).json({ tasks: tasks.map((t, idx) => mapTaskToBoard(t, idx)) });
    } catch (error) {
      console.error("[community] Error completando tarea:", error);
      return res.status(500).json({ error: "Error interno completando tarea" });
    }
  }
);

export default router;
