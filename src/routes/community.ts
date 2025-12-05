// src/routes/community.ts
import express, { Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { ProjectModel } from '../models/Project';
import { TaskDocument } from '../models/Task';

const router = express.Router();

type ColumnId = TaskDocument['columnId'];
type TaskLayer = TaskDocument['layer'];

// Columnas del tablero tipo Trello
const BOARD_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: 'todo', title: 'Por hacer', order: 1 },
  { id: 'doing', title: 'Haciendo', order: 2 },
  { id: 'done', title: 'Hecho', order: 3 },
];

// ----------------- Rutas -----------------

// POST /community/projects/:id/publish
// Marca un proyecto como publicado en la comunidad
router.post(
  '/projects/:id/publish',
  async (
    req: Request<{ id: string }>,
    res: Response<
      | {
          project: any;
          message: string;
        }
      | { error: string }
    >
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

      return res.status(200).json({
        project: {
          ...project.toObject(),
          id: project._id.toString(),
        },
        message: 'Proyecto publicado en la comunidad correctamente',
      });
    } catch (error) {
      console.error('[community] Error publicando proyecto:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al publicar proyecto en comunidad' });
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
            published: boolean;
          };
          columns: typeof BOARD_COLUMNS;
          tasks: Array<
            Pick<
              TaskDocument,
              'title' | 'description' | 'priority' | 'columnId' | 'price'
            > & {
              id: string;
              layer: TaskLayer;
            }
          >;
        }
      | { error: string }
    >
  ) => {
    try {
      await connectMongo();
      const project = await ProjectModel.findById(req.params.id);

      if (!project || !project.published) {
        return res.status(404).json({ error: 'Proyecto de comunidad no encontrado' });
      }

      return res.status(200).json({
        project: {
          id: project._id.toString(),
          title: project.title,
          published: project.published,
        },
        columns: BOARD_COLUMNS,
        tasks: project.tasks.map((task) => ({
          id: task._id.toString(),
          title: task.title,
          description: task.description,
          price: task.price,
          priority: task.priority,
          layer: task.layer,
          columnId: task.columnId,
        })),
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
router.get('/projects/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    await connectMongo();
    const project = await ProjectModel.findById(req.params.id);

    if (!project || !project.published) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    return res.status(200).json({
      project: {
        id: project._id.toString(),
        ownerEmail: project.ownerEmail,
        title: project.title,
        description: project.description,
        tasks: project.tasks,
        totalTasksPrice: project.totalTasksPrice,
        generatorFee: project.generatorFee,
        platformFeePercent: project.platformFeePercent,
        published: project.published,
        publishedAt: project.publishedAt,
      },
    });
  } catch (error) {
    console.error('[community] Error obteniendo proyecto de comunidad:', error);
    return res
      .status(500)
      .json({ error: 'Error interno obteniendo proyecto de comunidad' });
  }
});

// GET /community/projects
// Lista todos los proyectos publicados (para un explorador de la comunidad)
router.get('/projects', async (_req: Request, res: Response) => {
  try {
    await connectMongo();
    const projects = await ProjectModel.find({ published: true })
      .sort({ publishedAt: -1 })
      .lean();

    const list = projects.map((project) => ({
      id: project._id.toString(),
      title: project.title,
      description: project.description,
      totalTasksPrice: project.totalTasksPrice,
      platformFeePercent: project.platformFeePercent,
      publishedAt: project.publishedAt,
      tasksCount: project.tasks?.length ?? 0,
    }));

    return res.status(200).json(list);
  } catch (error) {
    console.error('[community] Error listando proyectos de comunidad:', error);
    return res
      .status(500)
      .json({ error: 'Error interno listando proyectos de comunidad' });
  }
});

export default router;
