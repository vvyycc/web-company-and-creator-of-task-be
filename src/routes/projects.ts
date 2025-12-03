import { Router, Request, Response } from 'express';
import { HOURLY_RATE, PLATFORM_FEE_PERCENT, TASK_GENERATOR_FIXED_PRICE_EUR } from '../config/pricing';
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

interface GenerateTasksRequestBody {
  ownerEmail?: string;
  projectTitle?: string;
  projectDescription?: string;
  title?: string; // alias legacy para compatibilidad
  description?: string; // alias legacy para compatibilidad
}

const router = Router();

const categoryRules: Record<
  TaskCategory,
  {
    complexity: TaskComplexity;
    estimatedHours: number;
  }
> = {
  ARCHITECTURE: { complexity: 'HIGH', estimatedHours: 8 },
  MODEL: { complexity: 'MEDIUM', estimatedHours: 4 },
  SERVICE: { complexity: 'HIGH', estimatedHours: 7 },
  VIEW: { complexity: 'MEDIUM', estimatedHours: 4 },
  INFRA: { complexity: 'MEDIUM', estimatedHours: 3 },
  QA: { complexity: 'SIMPLE', estimatedHours: 2 },
};

const fallbackRule: { complexity: TaskComplexity; estimatedHours: number } = { complexity: 'MEDIUM', estimatedHours: 4 };

const getTaskEstimation = (category: TaskCategory) => categoryRules[category] ?? fallbackRule;

export const DEFAULT_COLUMNS: Array<{ id: ColumnId; title: string; order: number }> = [
  { id: 'todo', title: 'Por hacer', order: 1 },
  { id: 'doing', title: 'Haciendo', order: 2 },
  { id: 'done', title: 'Hecho', order: 3 },
];

const isValidColumnId = (columnId: string): columnId is ColumnId => DEFAULT_COLUMNS.some((column) => column.id === columnId);

const buildSampleTasks = (projectTitle: string, projectDescription: string): Omit<GeneratedTask, 'id'>[] => {
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
    const { complexity, estimatedHours } = getTaskEstimation(template.category);
    const taskPrice = Math.round(estimatedHours * HOURLY_RATE);
    return {
      ...template,
      complexity,
      estimatedHours,
      hourlyRate: HOURLY_RATE,
      taskPrice,
      priority: index + 1,
      // Mantenemos alias legacy para integraciones previas.
      layer: template.category,
      price: taskPrice,
      columnId: 'todo',
    } satisfies Omit<GeneratedTask, 'id'>;
  });
};

router.post(
  '/generate-tasks',
  async (
    req: Request<unknown, unknown, GenerateTasksRequestBody>,
    res: Response<{ project: ProjectEstimation & { id: string; published: boolean } } | { error: string }>
  ) => {
    try {
      const { ownerEmail, projectTitle, projectDescription, title, description } = req.body || {};

      const resolvedTitle = projectTitle ?? title;
      const resolvedDescription = projectDescription ?? description;

      if (!ownerEmail || !resolvedTitle || !resolvedDescription) {
        return res.status(400).json({ error: 'ownerEmail, projectTitle y projectDescription son obligatorios' });
      }

      // La suscripción mensual de 30 €/mes es obligatoria para usar el generador de tareas.
      await connectMongo();
      const subscription = await Subscription.findOne({ email: ownerEmail });
      // Sin suscripción activa, devolvemos 402 subscription_required para bloquear el generador.
      if (!subscription || subscription.status !== 'active') {
        return res.status(402).json({
          error: 'subscription_required',
          message: 'Necesitas una suscripción activa de 30 €/mes para generar el troceado de tareas.',
        });
      }

      const tasksWithoutIds = buildSampleTasks(resolvedTitle, resolvedDescription);
      const totalHours = tasksWithoutIds.reduce((sum, task) => sum + task.estimatedHours, 0);
      const grossTotalTasksPrice = tasksWithoutIds.reduce((sum, task) => sum + task.taskPrice, 0);
      // La plataforma actúa como intermediaria y retiene un 1% del presupuesto del proyecto.
      const platformFeeAmount = Math.round(grossTotalTasksPrice * (PLATFORM_FEE_PERCENT / 100));
      const generatorServiceFee = TASK_GENERATOR_FIXED_PRICE_EUR; // Fee fijo por uso del generador (30 €)
      const grandTotalClientCost = grossTotalTasksPrice + platformFeeAmount + generatorServiceFee;

      const tasksWithDeveloperShare = tasksWithoutIds.map((task) => {
        const proportionalFee = grossTotalTasksPrice === 0 ? 0 : (task.taskPrice / grossTotalTasksPrice) * platformFeeAmount;
        const developerNetPrice = Math.max(0, Math.round(task.taskPrice - proportionalFee));
        return { ...task, price: developerNetPrice, developerNetPrice, columnId: 'todo' };
      });

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
        generatorFee: generatorServiceFee,
        grandTotalClientCost,
        published: false,
      });

      return res.status(200).json({ project });
    } catch (error) {
      console.error('Error generando tareas:', error);
      return res.status(500).json({ error: 'Error interno al generar tareas' });
    }
  }
);

router.get('/:id', (req: Request<{ id: string }>, res: Response<Project | { error: string }>) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    return res.status(200).json(project);
  } catch (error) {
    console.error('Error obteniendo proyecto:', error);
    return res.status(500).json({ error: 'Error interno al obtener el proyecto' });
  }
});

router.get(
  '/:id/board',
  (
    req: Request<{ id: string }>,
    res: Response<
      | {
          project: { id: string; title: string; published: boolean };
          columns: typeof DEFAULT_COLUMNS;
          tasks: Array<
            Pick<GeneratedTask, 'id' | 'title' | 'description' | 'price' | 'priority' | 'columnId'> & {
              layer: TaskCategory;
            }
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
        project: { id: project.id, title: project.projectTitle ?? project.title ?? '', published: project.published },
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
      return res.status(500).json({ error: 'Error interno al obtener el tablero del proyecto' });
    }
  }
);

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
      result.project.tasks = result.project.tasks.map((task) => (task.id === result.task.id ? result.task : task));

      return res.status(200).json(result.task);
    } catch (error) {
      console.error('Error moviendo tarea de columna:', error);
      return res.status(500).json({ error: 'Error interno al mover la tarea' });
    }
  }
);

router.post('/:id/publish', (req: Request<{ id: string }>, res: Response<Project | { error: string; explanation?: string }>) => {
  try {
    const project = publishProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado' });
    }

    const platformFeeAmount = project.totalTasksPrice * (project.platformFeePercent / 100);

    return res.status(200).json({
      ...project,
      explanation: `La plataforma cobrará ${project.platformFeePercent}% del total de tareas (€${platformFeeAmount.toFixed(
        2
      )}) cuando el proyecto sea ejecutado.`,
    });
  } catch (error) {
    console.error('Error publicando proyecto:', error);
    return res.status(500).json({ error: 'Error interno al publicar el proyecto' });
  }
});

export default router;
