// src/routes/projects.ts
import express, { Request, Response } from 'express';
import { HOURLY_RATE, PLATFORM_FEE_PERCENT, TASK_GENERATOR_FIXED_PRICE_EUR } from '../config/pricing';
import { connectMongo } from '../db/mongo';
import { ProjectModel, ProjectDocument } from '../models/Project';
import { Subscription } from '../models/Subscription';
import { TaskDocument } from '../models/Task';
import { emitTaskEvent } from '../services/taskEvents';

const router = express.Router();

type ColumnId = TaskDocument['columnId'];
type TaskLayer = TaskDocument['layer'];

/**
 * Body esperado en /projects/generate-tasks
 * (compatibilidad con versiones previas: projectTitle/title, projectDescription/description)
 */
interface GenerateTasksRequestBody {
  ownerEmail: string;
  projectTitle?: string;
  projectDescription?: string;
  title?: string;
  description?: string;
}

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

// --- reglas por categoría para estimar horas ---
const categoryRules: Record<
  TaskLayer,
  { hours: number }
> = {
  ARCHITECTURE: { hours: 6 },
  MODEL: { hours: 4 },
  SERVICE: { hours: 3 },
  VIEW: { hours: 2 },
};

const buildSampleTasks = (
  projectTitle: string,
  projectDescription: string
): Array<Omit<TaskDocument, '_id'>> => {
  const templates: Array<Pick<TaskDocument, 'title' | 'description' | 'layer'>> = [
    {
      title: 'Definir arquitectura y stack tecnológico',
      description: `Arquitectura inicial para el proyecto: ${projectTitle}. ${projectDescription}`,
      layer: 'ARCHITECTURE',
    },
    {
      title: 'Diseñar modelos de datos y esquema de base de datos',
      description: 'Modelado de entidades principales y relaciones.',
      layer: 'MODEL',
    },
    {
      title: 'Implementar servicios y lógica de negocio',
      description: 'Endpoints y casos de uso principales del proyecto.',
      layer: 'SERVICE',
    },
    {
      title: 'Desarrollar capa de vista / frontend',
      description: 'Pantallas iniciales y flujos de usuario clave.',
      layer: 'VIEW',
    },
  ];

  return templates.map((template, index) => {
    const hours = categoryRules[template.layer].hours;
    const price = Math.round(hours * HOURLY_RATE);

    return {
      title: template.title,
      description: template.description,
      priority: index + 1,
      price,
      layer: template.layer,
      columnId: 'todo' as ColumnId,
      status: 'TODO',
      assignedToEmail: null,
      assignedAt: null,
    };
  });
};

const formatProject = (project: ProjectDocument) => {
  const data = project.toObject();
  return {
    ...data,
    id: project._id.toString(),
  };
};

/**
 * POST /projects/generate-tasks
 * Genera un proyecto con tareas troceadas y lo guarda en MongoDB
 */
router.post(
  '/generate-tasks',
  async (
    req: Request<unknown, unknown, GenerateTasksRequestBody>,
    res: Response<
      | { project: ReturnType<typeof formatProject> }
      | { error: string; message?: string }
    >
  ) => {
    try {
      const {
        ownerEmail,
        projectTitle,
        projectDescription,
        title,
        description,
      } = req.body || {};

      const resolvedTitle = projectTitle ?? title;
      const resolvedDescription = projectDescription ?? description;

      if (!ownerEmail || !resolvedTitle || !resolvedDescription) {
        return res.status(400).json({
          error:
            'ownerEmail, projectTitle y projectDescription (o title/description) son obligatorios',
        });
      }

      await connectMongo();
      const subscription = await Subscription.findOne({ email: ownerEmail });

      if (!subscription || subscription.status !== 'active') {
        return res.status(402).json({
          error: 'subscription_required',
          message:
            'Necesitas una suscripción activa de 30 €/mes para generar el troceado de tareas.',
        });
      }

      const tasks = buildSampleTasks(resolvedTitle, resolvedDescription);
      const totalTasksPrice = tasks.reduce((sum, task) => sum + task.price, 0);

      const project = await ProjectModel.create({
        ownerEmail,
        title: resolvedTitle,
        description: resolvedDescription,
        tasks,
        totalTasksPrice,
        generatorFee: TASK_GENERATOR_FIXED_PRICE_EUR,
        platformFeePercent: PLATFORM_FEE_PERCENT,
        published: false,
      });

      return res.status(200).json({ project: formatProject(project) });
    } catch (error) {
      console.error('Error generando tareas:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al generar tareas' });
    }
  }
);

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
