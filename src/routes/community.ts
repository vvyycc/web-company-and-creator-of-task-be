// src/routes/community.ts
import express, { Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { CommunityProject } from '../models/CommunityProject';

// 🔹 Tipos locales para no depender de ../models/project
export type ColumnId = 'todo' | 'doing' | 'done';

export type TaskCategory =
  | 'ARCHITECTURE'
  | 'MODEL'
  | 'SERVICE'
  | 'VIEW'
  | 'INFRA'
  | 'QA';

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

// Columnas del tablero tipo Trello
const BOARD_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: 'todo', title: 'Por hacer', order: 1 },
  { id: 'doing', title: 'Haciendo', order: 2 },
  { id: 'done', title: 'Hecho', order: 3 },
];

// ----------------- Helpers -----------------

// Mapea una tarea guardada en estimation.tasks a lo que usa el frontend
const mapTaskToBoard = (task: any): BoardTask => ({
  id: String(task.id),
  title: task.title,
  description: task.description,
  price: task.taskPrice ?? task.price ?? 0,
  priority: task.priority ?? 0,
  layer: (task.layer ?? task.category ?? 'SERVICE') as TaskCategory,
  columnId: (task.columnId as ColumnId) ?? 'todo',
  assigneeEmail: task.assigneeEmail ?? null,
  assigneeAvatar: task.assigneeAvatar ?? null,
});

// ----------------- Rutas -----------------

// POST /community/projects
// Guarda el proyecto generado en la colección communityprojects y lo marca como publicado
router.post(
  '/projects',
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
          error: 'ownerEmail, projectTitle, projectDescription y estimation son obligatorios',
        });
      }

      await connectMongo();

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
      console.error('[community] Error creando proyecto de comunidad:', error);
      return res.status(500).json({ error: 'Error interno creando proyecto de comunidad' });
    }
  }
);

// GET /community/projects/:id/board
// Devuelve datos para el tablero estilo Trello (usado en /community/[id])
router.get(
  '/projects/:id/board',
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
      const doc = await CommunityProject.findById(req.params.id).lean();

      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: 'Proyecto de comunidad no encontrado' });
      }

      const estimation = doc.estimation as any;
      const rawTasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];

      const tasks = rawTasks.map((task) => mapTaskToBoard(task));

      return res.status(200).json({
        project: {
          id: doc._id.toString(),
          title: doc.projectTitle,
          description: doc.projectDescription,
          ownerEmail: doc.ownerEmail,
          published: doc.isPublished,
        },
        columns: BOARD_COLUMNS,
        tasks,
      });
    } catch (error) {
      console.error('[community] Error obteniendo tablero de comunidad:', error);
      return res.status(500).json({ error: 'Error interno obteniendo tablero de comunidad' });
    }
  }
);

// GET /community/projects/:id
// Detalle del proyecto de comunidad
router.get('/projects/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    await connectMongo();
    const doc = await CommunityProject.findById(req.params.id).lean();

    if (!doc || !doc.isPublished) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const estimation = doc.estimation as any;
    const rawTasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];

    const tasks = rawTasks.map((task) => ({
      ...mapTaskToBoard(task),
    }));

    return res.status(200).json({
      project: {
        id: doc._id.toString(),
        title: doc.projectTitle,
        description: doc.projectDescription,
        ownerEmail: doc.ownerEmail,
        totalTasksPrice: estimation?.totalTasksPrice ?? 0,
        generatorFee: estimation?.generatorServiceFee ?? estimation?.generatorFee ?? 0,
        platformFeePercent: estimation?.platformFeePercent ?? 1,
        published: doc.isPublished,
        publishedAt: doc.createdAt ?? doc.updatedAt,
        tasks,
      },
    });
  } catch (error) {
    console.error('[community] Error obteniendo proyecto de comunidad:', error);
    return res.status(500).json({ error: 'Error interno obteniendo proyecto de comunidad' });
  }
});

// GET /community/projects
// Lista todos los proyectos publicados
router.get('/projects', async (_req: Request, res: Response) => {
  try {
    await connectMongo();
    const docs = await CommunityProject.find({ isPublished: true }).lean();

    const list = docs.map((doc) => {
      const estimation = doc.estimation as any;
      const tasks: any[] = Array.isArray(estimation?.tasks) ? estimation.tasks : [];
      const totalTasksPrice =
        estimation?.totalTasksPrice ??
        tasks.reduce((sum, t) => sum + (t.taskPrice ?? t.price ?? 0), 0);

      return {
        id: doc._id.toString(),
        title: doc.projectTitle,
        description: doc.projectDescription,
        ownerEmail: doc.ownerEmail,
        totalTasksPrice,
        platformFeePercent: estimation?.platformFeePercent ?? 1,
        tasksCount: tasks.length,
        publishedAt: doc.createdAt ?? doc.updatedAt,
      };
    });

    return res.status(200).json(list);
  } catch (error) {
    console.error('[community] Error listando proyectos de comunidad:', error);
    return res.status(500).json({ error: 'Error interno listando proyectos de comunidad' });
  }
});

// 🔥 Asignar tarea a un usuario (persistente)
router.post(
  '/projects/:id/tasks/:taskId/assign',
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string; userAvatar?: string }>,
    res: Response<{ tasks: BoardTask[] } | { error: string }>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail, userAvatar } = req.body || {};

      if (!userEmail) {
        return res.status(400).json({ error: 'userEmail es obligatorio' });
      }

      await connectMongo();
      const doc = await CommunityProject.findById(id);

      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      if (doc.ownerEmail === userEmail) {
        return res.status(403).json({ error: 'El creador del proyecto no puede tomar tareas' });
      }

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      // ¿este usuario ya tiene una tarea activa (no done)?
      const hasActive = tasks.some(
        (t) => t.assigneeEmail === userEmail && t.columnId !== 'done'
      );
      if (hasActive) {
        return res.status(400).json({
          error: 'user_already_has_task',
        });
      }

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) {
        return res.status(404).json({ error: 'Tarea no encontrada' });
      }

      // si ya está asignada a otra persona y no está done
      if (task.assigneeEmail && task.assigneeEmail !== userEmail && task.columnId !== 'done') {
        return res.status(409).json({ error: 'task_already_assigned' });
      }

      task.assigneeEmail = userEmail;
      task.assigneeAvatar = userAvatar ?? null;
      task.columnId = 'doing';

      estimation.tasks = tasks;
      doc.estimation = estimation;
      await doc.save();

      const mapped = tasks.map((t) => mapTaskToBoard(t));
      return res.status(200).json({ tasks: mapped });
    } catch (error) {
      console.error('[community] Error asignando tarea:', error);
      return res.status(500).json({ error: 'Error interno asignando tarea' });
    }
  }
);

// 🔥 Desasignar tarea (persistente)
router.post(
  '/projects/:id/tasks/:taskId/unassign',
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string }>,
    res: Response<{ tasks: BoardTask[] } | { error: string }>
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};

      if (!userEmail) {
        return res.status(400).json({ error: 'userEmail es obligatorio' });
      }

      await connectMongo();
      const doc = await CommunityProject.findById(id);

      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];

      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) {
        return res.status(404).json({ error: 'Tarea no encontrada' });
      }

      if (task.assigneeEmail && task.assigneeEmail !== userEmail) {
        return res.status(403).json({ error: 'No eres el asignado a esta tarea' });
      }

      task.assigneeEmail = null;
      task.assigneeAvatar = null;
      task.columnId = 'todo';

      estimation.tasks = tasks;
      doc.estimation = estimation;
      await doc.save();

      const mapped = tasks.map((t) => mapTaskToBoard(t));
      return res.status(200).json({ tasks: mapped });
    } catch (error) {
      console.error('[community] Error desasignando tarea:', error);
      return res.status(500).json({ error: 'Error interno desasignando tarea' });
    }
  }
);

export default router;
