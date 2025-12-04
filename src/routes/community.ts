import { Router, Request, Response } from 'express';
import {
  GeneratedTask,
  Project,
  getProject,
  listPublishedProjects,
  publishProject,
} from '../models/project';

const router = Router();

const BOARD_COLUMNS = [
  { id: 'todo', title: 'Por hacer', order: 1 },
  { id: 'doing', title: 'Haciendo', order: 2 },
  { id: 'done', title: 'Hecho', order: 3 },
];

const mapTaskToBoard = (task: GeneratedTask) => ({
  id: task.id,
  title: task.title,
  description: task.description,
  price: task.price ?? task.taskPrice ?? 0,
  priority: task.priority,
  layer: task.layer ?? task.category,
  columnId: task.columnId,
});

const getProjectTitle = (project: Project): string => project.projectTitle ?? project.title ?? '';

const getProjectDescription = (project: Project): string =>
  project.projectDescription ?? project.description ?? '';

router.post('/projects/:id/publish', (req: Request, res: Response) => {
  const { id } = req.params;

  const project = publishProject(id);

  if (!project) {
    return res.status(404).json({ error: 'Proyecto no encontrado' });
  }

  // TODO: verificar suscripción activa del owner antes de publicar

  return res.json({
    project,
    message: 'Proyecto publicado en la comunidad correctamente',
  });
});

router.get('/projects', (_req: Request, res: Response) => {
  const publishedProjects = listPublishedProjects();

  const response = publishedProjects.map((project) => ({
    id: project.id,
    title: getProjectTitle(project),
    description: getProjectDescription(project),
    totalTasksPrice: project.totalTasksPrice,
    platformFeePercent: project.platformFeePercent,
    publishedAt: project.publishedAt,
    tasksCount: project.tasks.length,
  }));

  return res.json(response);
});

router.get('/projects/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const project = getProject(id);

  if (!project || !project.published) {
    return res.status(404).json({ error: 'Proyecto no encontrado' });
  }

  return res.json({
    project: {
      id: project.id,
      title: getProjectTitle(project),
      description: getProjectDescription(project),
      totalTasksPrice: project.totalTasksPrice,
      generatorFee: project.generatorFee ?? project.generatorServiceFee,
      platformFeePercent: project.platformFeePercent,
      published: true,
      publishedAt: project.publishedAt,
      tasks: project.tasks.map((task) => ({
        ...task,
        price: task.price ?? task.taskPrice ?? 0,
        layer: task.layer ?? task.category,
      })),
    },
  });
});

router.get('/projects/:id/board', (req: Request, res: Response) => {
  const { id } = req.params;
  const project = getProject(id);

  if (!project || !project.published) {
    return res.status(404).json({ error: 'Proyecto no encontrado' });
  }

  return res.json({
    project: {
      id: project.id,
      title: getProjectTitle(project),
      published: true,
    },
    columns: BOARD_COLUMNS,
    tasks: project.tasks.map(mapTaskToBoard),
  });
});

export default router;

