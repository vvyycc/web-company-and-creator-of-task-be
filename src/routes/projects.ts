// src/routes/projects.ts
import express, { Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { ProjectModel, ProjectDocument } from '../models/Project';
import { TaskDocument } from '../models/Task';
import { emitTaskEvent } from '../services/taskEvents';
import mongoose from 'mongoose';
import { handleGenerateTasks } from "../controllers/taskGenerationController";
import { GenerateTasksRequestBody } from "../types/generateTasks";


const router = express.Router();

type ColumnId = TaskDocument['columnId'];
type TaskLayer = TaskDocument['layer'];

// --- columnas del "board" tipo Trello ---
export const DEFAULT_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: 'todo', title: 'Por hacer', order: 1 },
  { id: 'doing', title: 'Haciendo', order: 2 },
  { id: 'done', title: 'Hecho', order: 3 },
];

const isValidColumnId = (columnId: string): columnId is ColumnId =>
  DEFAULT_COLUMNS.some((column) => column.id === columnId);

const statusFromColumn: Record<ColumnId, TaskDocument['status']> = {
  todo: 'TODO',
  doing: 'IN_PROGRESS',
  done: 'DONE',
};

const mapTaskResponse = (task: TaskDocument) => ({
  id: task._id.toString(),
  title: task.title,
  description: task.description,
  price: task.price,
  priority: task.priority,
  layer: task.layer,
  columnId: task.columnId,
  status: task.status,
  assignedToEmail: task.assignedToEmail ?? null,
  assignedAt: task.assignedAt ?? null,
});

const formatProject = (project: ProjectDocument) => {
  const data = project.toObject();
  return {
    ...data,
    id: project._id.toString(),
  };
};

/**
 * POST /projects/generate-tasks
 * Genera y devuelve tareas troceadas (OpenAI-first con fallback heurístico)
 */
// router.post(
//   "/generate-tasks",
//   (req: Request<unknown, unknown, GenerateTasksRequestBody>, res: Response) =>
//     handleGenerateTasks(req, res)
// );


/**
 * GET /projects/:id
 * Devuelve el proyecto completo (incluyendo tareas, precios, etc.)
 */
router.get(
  '/:id',
  async (
    req: Request<{ id: string }>,
    res: Response<ReturnType<typeof formatProject> | { error: string }>
  ) => {
    try {
      await connectMongo();
      const project = await ProjectModel.findById(req.params.id);

      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      return res.status(200).json(formatProject(project));
    } catch (error) {
      console.error('Error obteniendo proyecto:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al obtener el proyecto' });
    }
  }
);

/**
 * DELETE /projects/:id
 * headers: x-user-email
 * Reglas:
 * - Solo owner puede borrar (403)
 * - Si está publicado, no se puede borrar (409)
 */
router.delete(
  "/:id",
  async (
    req: Request<{ id: string }>,
    res: Response<{ message: string } | { error: string }>
  ) => {
    try {
      await connectMongo();

      const { id } = req.params;
      const userEmail = String(req.headers["x-user-email"] || "").trim();

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Identificador de proyecto no válido" });
      }

      if (!userEmail) {
        return res.status(401).json({ error: "Falta x-user-email" });
      }

      const project = await ProjectModel.findById(id);
      if (!project) {
        return res.status(404).json({ error: "Proyecto no encontrado" });
      }

      // ✅ solo owner
      const ownerEmail = String((project as any).ownerEmail || "").toLowerCase();
      if (ownerEmail && ownerEmail !== userEmail.toLowerCase()) {
        return res.status(403).json({ error: "forbidden_owner_only" });
      }

      // ✅ no borrar si publicado
      const isPublished = Boolean((project as any).isPublished || (project as any).published);
      if (isPublished) {
        return res.status(409).json({ error: "project_published_cannot_delete" });
      }

      await ProjectModel.findByIdAndDelete(id);

      return res.status(200).json({ message: "Proyecto eliminado correctamente" });
    } catch (error) {
      console.error("Error eliminando proyecto:", error);
      return res.status(500).json({ error: "Error interno al eliminar el proyecto" });
    }
  }
);

/**
 * GET /projects/:id/board
 * Devuelve datos adaptados al tablero (columns + tasks con columnId)
 */
router.get(
  '/:id/board',
  async (
    req: Request<{ id: string }>,
    res: Response<
      | {
          project: { id: string; title: string; published: boolean };
          columns: typeof DEFAULT_COLUMNS;
          tasks: Array<
            Pick<
              TaskDocument,
              'title' | 'description' | 'price' | 'priority' | 'columnId'
            > & { id: string; layer: TaskLayer }
          >;
        }
      | { error: string }
    >
  ) => {
    try {
      await connectMongo();
      const project = await ProjectModel.findById(req.params.id);

      if (!project) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      return res.status(200).json({
        project: {
          id: project._id.toString(),
          title: project.title,
          published: project.published,
        },
        columns: DEFAULT_COLUMNS,
        tasks: project.tasks.map(mapTaskResponse),
      });
    } catch (error) {
      console.error('Error obteniendo tablero de proyecto:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al obtener el tablero del proyecto' });
    }
  }
);

/**
 * PATCH /projects/tasks/:id/move
 * Mueve una tarea a otra columna (todo/doing/done)
 */
router.patch(
  '/tasks/:id/move',
  async (
    req: Request<{ id: string }, unknown, { columnId?: ColumnId }>,
    res: Response<ReturnType<typeof mapTaskResponse> | { error: string }>
  ) => {
    try {
      const { columnId } = req.body || {};

      if (!columnId || !isValidColumnId(columnId)) {
        return res.status(400).json({ error: 'Columna inválida' });
      }

      await connectMongo();
      const project = await ProjectModel.findOne({ 'tasks._id': req.params.id });

      if (!project) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      const task = project.tasks.find((task) => task._id.toString() === req.params.id);

      if (!task) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      task.columnId = columnId;
      task.status = statusFromColumn[columnId];

      if (columnId === 'todo') {
        task.assignedToEmail = null;
        task.assignedAt = null;
      }

      await project.save();

      emitTaskEvent(project._id.toString(), 'column_changed', task);

      return res.status(200).json(mapTaskResponse(task));
    } catch (error) {
      console.error('Error moviendo tarea de columna:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al mover la tarea' });
    }
  }
);

/**
 * POST /projects/tasks/:taskId/claim
 * Asigna una tarea disponible de forma atómica y la mueve a doing.
 */
router.post(
  '/tasks/:taskId/claim',
  async (
    req: Request<{ taskId: string }, unknown, { email?: string }>,
    res: Response<{ task: ReturnType<typeof mapTaskResponse> } | { error: string }>
  ) => {
    try {
      const { taskId } = req.params;
      const { email } = req.body || {};

      if (!email) {
        return res.status(400).json({ error: 'email es obligatorio' });
      }

      await connectMongo();

      const project = await ProjectModel.findOneAndUpdate(
        {
          published: true,
          'tasks._id': taskId,
          'tasks.assignedToEmail': null,
          'tasks.status': 'TODO',
        },
        {
          $set: {
            'tasks.$.assignedToEmail': email,
            'tasks.$.assignedAt': new Date(),
            'tasks.$.status': 'IN_PROGRESS',
            'tasks.$.columnId': 'doing',
          },
        },
        { new: true }
      );

      if (!project) {
        return res
          .status(409)
          .json({ error: 'La tarea ya fue asignada por otro usuario' });
      }

      const task = project.tasks.find((t) => t._id.toString() === taskId);

      if (!task) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      emitTaskEvent(project._id.toString(), 'assignment_changed', task);

      return res.status(200).json({ task: mapTaskResponse(task) });
    } catch (error) {
      console.error('Error reclamando tarea:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al reclamar la tarea' });
    }
  }
);

/**
 * POST /projects/:id/publish
 * Marca el proyecto como publicado.
 */
router.post(
  '/:id/publish',
  async (
    req: Request<{ id: string }>,
    res: Response<ReturnType<typeof formatProject> | { error: string; explanation?: string }>
  ) => {
    try {
      await connectMongo();
      const project = await ProjectModel.findById(req.params.id);

      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      project.published = true;
      project.publishedAt = new Date();
      await project.save();

      return res.status(200).json(formatProject(project));
    } catch (error) {
      console.error('Error publicando proyecto:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al publicar el proyecto' });
    }
  }
);

export default router;
