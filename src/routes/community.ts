// src/routes/community.ts
import express, { Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { CommunityProject } from '../models/CommunityProject';
import { GeneratedTask, TaskCategory, ColumnId } from '../models/project';

const router = express.Router();

const DEFAULT_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: 'todo', title: 'Por hacer', order: 1 },
  { id: 'doing', title: 'Haciendo', order: 2 },
  { id: 'done', title: 'Hecho', order: 3 },
];

// POST /community/projects
// Guarda el proyecto generado en la colección communityprojects
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
        return res
          .status(400)
          .json({ error: 'ownerEmail, projectTitle, projectDescription y estimation son obligatorios' });
      }

      await connectMongo();

      const doc = await CommunityProject.create({
        ownerEmail,
        projectTitle,
        projectDescription,
        estimation,
        isPublished: true,
      });

      const publicUrl = `/community/${doc._id.toString()}`;
      return res.status(200).json({ id: doc._id.toString(), publicUrl });
    } catch (error) {
      console.error('[community] Error creando proyecto de comunidad:', error);
      return res.status(500).json({ error: 'Error interno creando proyecto de comunidad' });
    }
  }
);

// GET /community/projects/:id/board
// Devuelve datos para el tablero estilo Trello
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
          columns: typeof DEFAULT_COLUMNS;
          tasks: Array<
            Pick<GeneratedTask, 'id' | 'title' | 'description' | 'priority' | 'columnId'> & {
              layer: TaskCategory;
              price: number;
            }
          >;
        }
      | { error: string }
    >
  ) => {
    try {
      await connectMongo();
      const doc = await CommunityProject.findById(req.params.id).lean();

      if (!doc) {
        return res.status(404).json({ error: 'Proyecto de comunidad no encontrado' });
      }

      const estimation = doc.estimation as any;

      const tasks: Array<
        Pick<GeneratedTask, 'id' | 'title' | 'description' | 'priority' | 'columnId'> & {
          layer: TaskCategory;
          price: number;
        }
      > = (estimation?.tasks ?? []).map((task: any) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        priority: task.priority,
        layer: (task.layer ?? task.category) as TaskCategory,
        columnId: (task.columnId as ColumnId) ?? 'todo',
        price: task.taskPrice ?? task.price ?? 0,
      }));

      return res.status(200).json({
        project: {
          id: doc._id.toString(),
          title: doc.projectTitle,
          description: doc.projectDescription,
          ownerEmail: doc.ownerEmail,
          published: doc.isPublished,
        },
        columns: DEFAULT_COLUMNS,
        tasks,
      });
    } catch (error) {
      console.error('[community] Error obteniendo tablero de comunidad:', error);
      return res.status(500).json({ error: 'Error interno obteniendo tablero de comunidad' });
    }
  }
);

export default router;
