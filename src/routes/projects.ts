// src/routes/projects.ts
import express, { Request, Response } from 'express';
import { HOURLY_RATE, PLATFORM_FEE_PERCENT } from '../config/pricing';
import {
  createProject,
  GeneratedTask,
  getProject,
  Project,
  ProjectEstimation,
  publishProject,
  ColumnId,
  findTaskById,
  TaskCategory,
  TaskComplexity,
} from '../models/project';
import { connectMongo } from '../db/mongo';
import { Subscription } from '../models/Subscription';

const router = express.Router();

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
  { id: 'todo' as ColumnId, title: 'Por hacer', order: 1 },
  { id: 'doing' as ColumnId, title: 'Haciendo', order: 2 },
  { id: 'done' as ColumnId, title: 'Hecho', order: 3 },
];

const isValidColumnId = (columnId: string): columnId is ColumnId =>
  DEFAULT_COLUMNS.some((column) => column.id === columnId);

// --- reglas por categoría para estimar horas y complejidad ---
const categoryRules: Record<
  TaskCategory,
  { hours: number; complexity: TaskComplexity }
> = {
  ARCHITECTURE: { hours: 6, complexity: 'HIGH' },
  MODEL: { hours: 4, complexity: 'MEDIUM' },
  SERVICE: { hours: 3, complexity: 'MEDIUM' },
  VIEW: { hours: 2, complexity: 'SIMPLE' },
  INFRA: { hours: 3, complexity: 'MEDIUM' },
  QA: { hours: 1, complexity: 'SIMPLE' },
};

const fallbackRule: { hours: number; complexity: TaskComplexity } = {
  hours: 4,
  complexity: 'MEDIUM',
};

const getTaskEstimation = (category: TaskCategory) =>
  categoryRules[category] ?? fallbackRule;

/**
 * Construye un conjunto de tareas de ejemplo a partir del título y descripción.
 * Devuelve tasks SIN id → Omit<GeneratedTask, 'id'>[]
 */
const buildSampleTasks = (
  projectTitle: string,
  projectDescription: string
): Omit<GeneratedTask, 'id'>[] => {
  const templates: Array<Pick<GeneratedTask, 'title' | 'description' | 'category'>> = [
    {
      title: 'Definir arquitectura y stack tecnológico',
      description: `Arquitectura inicial para el proyecto: ${projectTitle}. ${projectDescription}`,
      category: 'ARCHITECTURE',
    },
    {
      title: 'Diseñar modelos de datos y esquema de base de datos',
      description: 'Modelado de entidades principales y relaciones.',
      category: 'MODEL',
    },
    {
      title: 'Implementar servicios y lógica de negocio',
      description: 'Endpoints y casos de uso principales del proyecto.',
      category: 'SERVICE',
    },
    {
      title: 'Desarrollar capa de vista / frontend',
      description: 'Pantallas iniciales y flujos de usuario clave.',
      category: 'VIEW',
    },
  ];

  return templates.map((template, index) => {
    const { hours, complexity } = getTaskEstimation(template.category);
    const taskPrice = Math.round(hours * HOURLY_RATE);

    return {
      title: template.title,
      description: template.description,
      category: template.category,
      complexity,
      priority: index + 1,
      estimatedHours: hours,
      hourlyRate: HOURLY_RATE,
      taskPrice,
      // alias legacy y campos extra que el modelo GeneratedTask ya contempla
      layer: template.category,
      price: taskPrice,
      columnId: 'todo' as ColumnId,
      // developerNetPrice se rellenará luego en función de la comisión de plataforma
      developerNetPrice: taskPrice,
    };
  });
};

/**
 * POST /projects/generate-tasks
 * Genera un proyecto con tareas troceadas, aplicando:
 * - check de suscripción (Subscription.status === 'active')
 * - horas por categoría
 * - comisión de plataforma 1%
 */
router.post(
  '/generate-tasks',
  async (
    req: Request<unknown, unknown, GenerateTasksRequestBody>,
    res: Response<
      | { project: ProjectEstimation & { id: string; published: boolean } }
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

      // 🔐 La suscripción mensual de 30 €/mes es obligatoria para usar el generador
      await connectMongo();
      const subscription = await Subscription.findOne({ email: ownerEmail });

      if (!subscription || subscription.status !== 'active') {
        return res.status(402).json({
          error: 'subscription_required',
          message:
            'Necesitas una suscripción activa de 30 €/mes para generar el troceado de tareas.',
        });
      }

      // 1) Generamos tareas base (sin ids)
      const tasksWithoutIds = buildSampleTasks(resolvedTitle, resolvedDescription);

      // 2) Cálculo de totales
      const totalHours = tasksWithoutIds.reduce(
        (sum, task) => sum + task.estimatedHours,
        0
      );
      const grossTotalTasksPrice = tasksWithoutIds.reduce(
        (sum, task) => sum + task.taskPrice,
        0
      );

      // 3) Comisión de plataforma (1% del presupuesto del proyecto)
      const platformFeeAmount = Math.round(
        grossTotalTasksPrice * (PLATFORM_FEE_PERCENT / 100)
      );

      // 4) Fee del generador → 0 €, se paga por suscripción (no por presupuesto)
      const generatorServiceFee = 0;

      // 5) Importe total que vería el cliente
      const grandTotalClientCost =
        grossTotalTasksPrice + platformFeeAmount + generatorServiceFee;

      // 6) Reparto de la comisión proporcional entre tareas
      const tasksWithDeveloperShare: Omit<GeneratedTask, 'id'>[] =
        tasksWithoutIds.map((task) => {
          const proportionalFee =
            grossTotalTasksPrice === 0
              ? 0
              : (task.taskPrice / grossTotalTasksPrice) * platformFeeAmount;

          const developerNetPrice = Math.max(
            0,
            Math.round(task.taskPrice - proportionalFee)
          );

          return {
            ...task,
            price: developerNetPrice,
            developerNetPrice,
            columnId: 'todo' as ColumnId,
          };
        });

      // 7) Creamos el Project en el modelo (añadirá id, etc.)
      const project = createProject({
        ownerEmail,
        projectTitle: resolvedTitle,
        projectDescription: resolvedDescription,
        title: resolvedTitle,
        description: resolvedDescription,
        tasks: tasksWithDeveloperShare,
        totalHours,
        totalTasksPrice: grossTotalTasksPrice,
        platformFeePercent: PLATFORM_FEE_PERCENT,
        platformFeeAmount,
        generatorServiceFee,
        generatorFee: generatorServiceFee, // alias legacy
        grandTotalClientCost,
        published: false,
      });

      // 8) Devolvemos el proyecto completo (incluye id y published)
      return res.status(200).json({
        project: project as ProjectEstimation & { id: string; published: boolean },
      });
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
  (req: Request<{ id: string }>, res: Response<Project | { error: string }>) => {
    try {
      const project = getProject(req.params.id);

      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      return res.status(200).json(project);
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
  (
    req: Request<{ id: string }>,
    res: Response<
      | {
          project: { id: string; title: string; published: boolean };
          columns: typeof DEFAULT_COLUMNS;
          tasks: Array<
            Pick<
              GeneratedTask,
              'id' | 'title' | 'description' | 'price' | 'priority' | 'columnId'
            > & { layer: TaskCategory }
          >;
        }
      | { error: string }
    >
  ) => {
    try {
      const project = getProject(req.params.id);

      if (!project) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      return res.status(200).json({
        project: {
          id: project.id,
          title: project.projectTitle ?? project.title ?? '',
          published: project.published,
        },
        columns: DEFAULT_COLUMNS,
        tasks: project.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          price: task.price ?? task.taskPrice,
          priority: task.priority,
          layer: task.layer ?? task.category,
          columnId: task.columnId,
        })),
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
  (
    req: Request<{ id: string }, unknown, { columnId?: ColumnId }>,
    res: Response<GeneratedTask | { error: string }>
  ) => {
    try {
      const { columnId } = req.body || {};

      if (!columnId || !isValidColumnId(columnId)) {
        return res.status(400).json({ error: 'Columna inválida' });
      }

      const result = findTaskById(req.params.id);

      if (!result) {
        return res.status(404).json({ error: 'No encontrado' });
      }

      result.task.columnId = columnId;
      result.project.tasks = result.project.tasks.map((task) =>
        task.id === result.task.id ? result.task : task
      );

      return res.status(200).json(result.task);
    } catch (error) {
      console.error('Error moviendo tarea de columna:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al mover la tarea' });
    }
  }
);

/**
 * POST /projects/:id/publish
 * Marca el proyecto como publicado.
 */
router.post(
  '/:id/publish',
  (
    req: Request<{ id: string }>,
    res: Response<Project | { error: string; explanation?: string }>
  ) => {
    try {
      const project = publishProject(req.params.id);

      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      return res.status(200).json(project);
    } catch (error) {
      console.error('Error publicando proyecto:', error);
      return res
        .status(500)
        .json({ error: 'Error interno al publicar el proyecto' });
    }
  }
);

export default router;
