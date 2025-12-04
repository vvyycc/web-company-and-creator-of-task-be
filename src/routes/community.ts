// src/routes/community.ts
import express, { Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { CommunityProject } from '../models/CommunityProject';
import { GeneratedTask, TaskCategory, ColumnId } from '../models/project';
import { isValidObjectId } from 'mongoose';

const router = express.Router();

// Columnas del tablero tipo Trello
const BOARD_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: 'todo', title: 'Por hacer', order: 1 },
  { id: 'doing', title: 'Haciendo', order: 2 },
  { id: 'done', title: 'Hecho', order: 3 },
];

// ----------------- Helpers -----------------

// Mapea una tarea guardada en estimation.tasks a lo que usa el frontend
const mapTaskToBoard = (
  task: any
): {
  id: string;
  title: string;
  description: string;
  price: number;
  priority: number;
  layer: TaskCategory;
  columnId: ColumnId;
} => ({
  id: String(task.id),
  title: task.title,
  description: task.description,
  price: task.taskPrice ?? task.price ?? 0,
  priority: task.priority ?? 0,
  layer: (task.layer ?? task.category ?? 'SERVICE') as TaskCategory,
  columnId: (task.columnId as ColumnId) ?? 'todo',
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
          error:
            'ownerEmail, projectTitle, projectDescription y estimation son obligatorios',
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
      return res
        .status(500)
        .json({ error: 'Error interno creando proyecto de comunidad' });
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
          tasks: Array<
            Pick<
              GeneratedTask,
              'id' | 'title' | 'description' | 'priority' | 'columnId'
            > & {
              layer: TaskCategory;
              price: number;
            }
          >;
        }
      | { error: string }
    >
  ) => {
    try {
      const { id } = req.params;

      // ⛔ Evitar CastError si el id no es un ObjectId (caso "explore")
      if (!isValidObjectId(id)) {
        return res.status(404).json({ error: 'Proyecto de comunidad no encontrado' });
      }

      await connectMongo();
      const doc = await CommunityProject.findById(id).lean();

      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: 'Proyecto de comunidad no encontrado' });
      }

      const estimation = doc.estimation as any;
      const rawTasks: any[] = Array.isArray(estimation?.tasks)
        ? estimation.tasks
        : [];

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
      return res
        .status(500)
        .json({ error: 'Error interno obteniendo tablero de comunidad' });
    }
  }
);

// GET /community/projects/:id
// Devuelve el detalle del proyecto de comunidad (para la página /community/[id] o similares)
router.get(
  '/projects/:id',
  async (req: Request<{ id: string }>, res: Response) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      await connectMongo();
      const doc = await CommunityProject.findById(id).lean();

      if (!doc || !doc.isPublished) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      const estimation = doc.estimation as any;
      const rawTasks: any[] = Array.isArray(estimation?.tasks)
        ? estimation.tasks
        : [];

      const tasks = rawTasks.map((task) => ({
        ...mapTaskToBoard(task),
      }));

      const totalTasksPrice =
        estimation?.totalTasksPrice ??
        tasks.reduce((sum, t) => sum + (t.price ?? 0), 0);

      return res.status(200).json({
        project: {
          id: doc._id.toString(),
          title: doc.projectTitle,
          description: doc.projectDescription,
          ownerEmail: doc.ownerEmail,
          totalTasksPrice,
          generatorFee:
            estimation?.generatorServiceFee ?? estimation?.generatorFee ?? 0,
          platformFeePercent: estimation?.platformFeePercent ?? 1,
          published: doc.isPublished,
          publishedAt: doc.createdAt ?? doc.updatedAt,
          tasks,
        },
      });
    } catch (error) {
      console.error('[community] Error obteniendo proyecto de comunidad:', error);
      return res
        .status(500)
        .json({ error: 'Error interno obteniendo proyecto de comunidad' });
    }
  }
);

// GET /community/projects
// Lista todos los proyectos publicados (para un explorador de la comunidad)
router.get('/projects', async (_req: Request, res: Response) => {
  try {
    await connectMongo();
    const docs = await CommunityProject.find({ isPublished: true }).lean();

    const list = docs.map((doc) => {
      const estimation = doc.estimation as any;
      const tasks: any[] = Array.isArray(estimation?.tasks)
        ? estimation.tasks
        : [];
      const totalTasksPrice =
        estimation?.totalTasksPrice ??
        tasks.reduce(
          (sum, t) => sum + (t.taskPrice ?? t.price ?? 0),
          0
        );

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
    return res
      .status(500)
      .json({ error: 'Error interno listando proyectos de comunidad' });
  }
});

export default router;
