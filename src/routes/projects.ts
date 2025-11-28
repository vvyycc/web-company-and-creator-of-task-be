import { Router, Request, Response } from 'express';
import { PLATFORM_FEE_PERCENT, TASK_GENERATOR_FIXED_PRICE_EUR } from '../config/pricing';
import { createProject, getProject, publishProject, Project, Task } from '../models/project';

interface GenerateTasksRequestBody {
  ownerEmail?: string;
  title?: string;
  description?: string;
}

const router = Router();

const buildSampleTasks = (projectTitle: string, projectDescription: string): Omit<Task, 'id'>[] => [
  {
    projectId: '',
    title: 'Definir arquitectura y stack tecnológico',
    description: `Arquitectura inicial para el proyecto: ${projectTitle}. ${projectDescription}`,
    priority: 1,
    price: 200,
    layer: 'ARCHITECTURE',
  },
  {
    projectId: '',
    title: 'Diseñar modelos de datos y esquema de base de datos',
    description: 'Modelado de entidades principales y relaciones.',
    priority: 2,
    price: 150,
    layer: 'MODEL',
  },
  {
    projectId: '',
    title: 'Implementar servicios y lógica de negocio',
    description: 'Endpoints y casos de uso principales del proyecto.',
    priority: 3,
    price: 250,
    layer: 'SERVICE',
  },
  {
    projectId: '',
    title: 'Desarrollar capa de vista / frontend',
    description: 'Pantallas iniciales y flujos de usuario clave.',
    priority: 4,
    price: 180,
    layer: 'VIEW',
  },
];

router.post(
  '/generate-tasks',
  async (
    req: Request<unknown, unknown, GenerateTasksRequestBody>,
    res: Response<{ project: Project; pricing: { taskGeneratorFixedPriceEur: number; platformFeePercent: number } } | { error: string }>
  ) => {
    try {
      const { ownerEmail, title, description } = req.body || {};

      if (!ownerEmail || !title || !description) {
        return res.status(400).json({ error: 'ownerEmail, title y description son obligatorios' });
      }

      const tasksWithoutIds = buildSampleTasks(title, description);
      const totalTasksPrice = tasksWithoutIds.reduce((sum, task) => sum + task.price, 0);

      const project = createProject({
        ownerEmail,
        title,
        description,
        tasks: tasksWithoutIds,
        totalTasksPrice,
        generatorFee: TASK_GENERATOR_FIXED_PRICE_EUR,
        platformFeePercent: PLATFORM_FEE_PERCENT,
        published: false,
      });

      return res.status(200).json({
        project,
        pricing: {
          taskGeneratorFixedPriceEur: TASK_GENERATOR_FIXED_PRICE_EUR,
          platformFeePercent: PLATFORM_FEE_PERCENT,
        },
      });
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
