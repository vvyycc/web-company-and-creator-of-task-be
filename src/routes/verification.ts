import express, { Request, Response } from 'express';
import { connectMongo } from '../db/mongo';
import { ProjectModel } from '../models/Project';
import { getIO } from '../socket';

const router = express.Router();

type SubmitRequestBody = {
  devEmail?: string;
  notes?: string;
};

type ReviewRequestBody = {
  reviewerEmail?: string;
  approved?: boolean;
  notes?: string;
};

router.post(
  '/tasks/:taskId/submit',
  async (
    req: Request<{ taskId: string }, unknown, SubmitRequestBody>,
    res: Response
  ) => {
    try {
      const { taskId } = req.params;
      const { devEmail, notes } = req.body || {};

      if (!devEmail) {
        return res.status(400).json({ error: 'devEmail is required' });
      }

      await connectMongo();
      const project = await ProjectModel.findOne({ 'tasks._id': taskId });

      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      const task = project.tasks.find((t) => t._id.toString() === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Tarea no encontrada' });
      }

      if (task.assignedToEmail !== devEmail) {
        return res.status(403).json({ error: 'No eres el asignado a esta tarea' });
      }

      if (!['IN_PROGRESS', 'REJECTED'].includes(task.status)) {
        return res
          .status(409)
          .json({ error: 'Solo se pueden enviar tareas en progreso o rechazadas' });
      }

      task.status = 'IN_REVIEW';
      task.verificationStatus = 'SUBMITTED';
      task.verificationNotes = notes ?? '';
      task.verifiedByEmail = null;
      task.verifiedAt = null;

      await project.save();

      const io = getIO();
      io.to(`project_${project._id}`).emit('task_updated', {
        type: 'TASK_UPDATED',
        projectId: project._id.toString(),
        task,
      });

      return res.status(200).json({ projectId: project._id, task });
    } catch (error) {
      console.error('Error en submit de verificación:', error);
      return res.status(500).json({ error: 'Error interno' });
    }
  }
);

router.post(
  '/tasks/:taskId/review',
  async (
    req: Request<{ taskId: string }, unknown, ReviewRequestBody>,
    res: Response
  ) => {
    try {
      const { taskId } = req.params;
      const { reviewerEmail, approved, notes } = req.body || {};

      if (!reviewerEmail) {
        return res.status(400).json({ error: 'reviewerEmail is required' });
      }

      if (typeof approved !== 'boolean') {
        return res.status(400).json({ error: 'approved flag is required' });
      }

      await connectMongo();
      const project = await ProjectModel.findOne({ 'tasks._id': taskId });

      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      const task = project.tasks.find((t) => t._id.toString() === taskId);
      if (!task) {
        return res.status(404).json({ error: 'Tarea no encontrada' });
      }

      if (task.verificationStatus !== 'SUBMITTED' || task.status !== 'IN_REVIEW') {
        return res.status(409).json({ error: 'La tarea no está pendiente de revisión' });
      }

      if (project.ownerEmail !== reviewerEmail) {
        return res.status(403).json({ error: 'Solo el owner puede revisar' });
      }

      if (approved) {
        task.verificationStatus = 'APPROVED';
        task.status = 'DONE';
        task.columnId = 'done';
      } else {
        task.verificationStatus = 'REJECTED';
        task.status = 'REJECTED';
        task.columnId = 'todo';
      }

      task.verificationNotes = notes ?? '';
      task.verifiedByEmail = reviewerEmail;
      task.verifiedAt = new Date();

      await project.save();

      const io = getIO();
      io.to(`project_${project._id}`).emit('task_updated', {
        type: 'TASK_UPDATED',
        projectId: project._id.toString(),
        task,
      });

      return res.status(200).json({ projectId: project._id, task });
    } catch (error) {
      console.error('Error en review de verificación:', error);
      return res.status(500).json({ error: 'Error interno' });
    }
  }
);

router.get(
  '/projects/:projectId/pending',
  async (req: Request<{ projectId: string }>, res: Response) => {
    try {
      const { projectId } = req.params;

      await connectMongo();
      const project = await ProjectModel.findById(projectId);

      if (!project) {
        return res.status(404).json({ error: 'Proyecto no encontrado' });
      }

      const pendingTasks = project.tasks.filter(
        (task) => task.verificationStatus === 'SUBMITTED' || task.status === 'IN_REVIEW'
      );

      return res.status(200).json({
        projectId: project._id.toString(),
        tasks: pendingTasks.map((task) => ({
          taskId: task._id.toString(),
          title: task.title,
          layer: task.layer,
          priority: task.priority,
          price: task.price,
          assignedToEmail: task.assignedToEmail ?? null,
          status: task.status,
          verificationStatus: task.verificationStatus,
          acceptanceCriteria: task.acceptanceCriteria,
          verificationNotes: task.verificationNotes,
        })),
      });
    } catch (error) {
      console.error('Error listando tareas pendientes:', error);
      return res.status(500).json({ error: 'Error interno' });
    }
  }
);

export default router;
