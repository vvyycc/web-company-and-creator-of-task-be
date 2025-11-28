import { Router, Request, Response } from 'express';
import { HOURLY_RATE, PLATFORM_FEE_PERCENT, TASK_GENERATOR_FIXED_PRICE_EUR } from '../config/pricing';
import {
  createProject,
  GeneratedTask,
  getProject,
  Project,
  ProjectEstimation,
  publishProject,
  TaskCategory,
  TaskComplexity,
} from '../models/project';

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
        return { ...task, price: developerNetPrice, developerNetPrice };
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
