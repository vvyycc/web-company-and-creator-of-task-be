import { Router, Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { CommunityProject } from '../models/CommunityProject';

const router = Router();

router.post('/projects', async (req: Request, res: Response) => {
  const { ownerEmail, projectTitle, projectDescription, estimation } = req.body || {};

  if (!ownerEmail || !projectTitle || !projectDescription || !estimation) {
    return res.status(400).json({ error: 'ownerEmail, projectTitle, projectDescription y estimation son obligatorios' });
  }

  try {
    await connectMongo();
    const project = await CommunityProject.create({
      ownerEmail,
      projectTitle,
      projectDescription,
      estimation,
      isPublished: true,
    });

    return res.status(201).json(project);
  } catch (error) {
    console.error('Error publicando proyecto en la comunidad:', error);
    return res.status(500).json({ error: 'No se pudo publicar el proyecto en la comunidad' });
  }
});

router.get('/projects', async (_req: Request, res: Response) => {
  try {
    await connectMongo();
    const projects = await CommunityProject.find({ isPublished: true }).sort({ createdAt: -1 }).lean();
    return res.status(200).json(projects);
  } catch (error) {
    console.error('Error listando proyectos de la comunidad:', error);
    return res.status(500).json({ error: 'No se pudieron obtener los proyectos de la comunidad' });
  }
});

export default router;

