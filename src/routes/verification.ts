import express, { Request, Response } from "express";
import { connectMongo } from "../db/mongo";
import { ProjectModel } from "../models/Project";
import { TaskDocument } from "../models/Task";
import { getIO } from "../socket";

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

const emitTaskUpdated = (projectId: string, task: TaskDocument) => {
  const io = getIO();
  io.to(`project_${projectId}`).emit("task_updated", {
    type: "TASK_UPDATED",
    projectId,
    task,
  });
};

router.post(
  "/tasks/:taskId/submit",
  async (
    req: Request<{ taskId: string }, unknown, SubmitRequestBody>,
    res: Response<{ task: TaskDocument } | { error: string }>
  ) => {
    try {
      const { taskId } = req.params;
      const { devEmail, notes } = req.body || {};

      if (!devEmail) {
        return res.status(400).json({ error: "devEmail es obligatorio" });
      }

      await connectMongo();
      const project = await ProjectModel.findOne({ "tasks._id": taskId });

      if (!project) {
        return res.status(404).json({ error: "Tarea no encontrada" });
      }

      const task = project.tasks.find((t) => t._id.toString() === taskId);

      if (!task) {
        return res.status(404).json({ error: "Tarea no encontrada" });
      }

      if (task.assignedToEmail !== devEmail) {
        return res
          .status(403)
          .json({ error: "Solo el developer asignado puede enviar la tarea" });
      }

      if (!["IN_PROGRESS", "REJECTED"].includes(task.status)) {
        return res.status(409).json({ error: "La tarea no se puede enviar" });
      }

      task.verificationStatus = "SUBMITTED";
      task.status = "IN_REVIEW";
      task.columnId = "doing";
      task.verificationNotes = typeof notes === "string" ? notes : task.verificationNotes;
      task.verifiedByEmail = null;
      task.verifiedAt = null;

      await project.save();

      emitTaskUpdated(project._id.toString(), task);

      return res.status(200).json({ task });
    } catch (error) {
      console.error("Error enviando tarea a revisión:", error);
      return res
        .status(500)
        .json({ error: "Error interno al enviar la tarea a revisión" });
    }
  }
);

router.post(
  "/tasks/:taskId/review",
  async (
    req: Request<{ taskId: string }, unknown, ReviewRequestBody>,
    res: Response<
      | { task: TaskDocument; nextStep?: "payment_pending" | "developer_rework" }
      | { error: string }
    >
  ) => {
    try {
      const { taskId } = req.params;
      const { reviewerEmail, approved, notes } = req.body || {};

      if (!reviewerEmail || typeof approved !== "boolean") {
        return res.status(400).json({ error: "Parámetros incompletos" });
      }

      await connectMongo();
      const project = await ProjectModel.findOne({ "tasks._id": taskId });

      if (!project) {
        return res.status(404).json({ error: "Tarea no encontrada" });
      }

      const task = project.tasks.find((t) => t._id.toString() === taskId);

      if (!task) {
        return res.status(404).json({ error: "Tarea no encontrada" });
      }

      if (task.verificationStatus !== "SUBMITTED" || task.status !== "IN_REVIEW") {
        return res.status(409).json({ error: "La tarea no está lista para revisión" });
      }

      task.verificationNotes = typeof notes === "string" ? notes : task.verificationNotes;
      task.verifiedByEmail = reviewerEmail;
      task.verifiedAt = new Date();

      if (approved) {
        task.verificationStatus = "APPROVED";
        task.status = "DONE";
        task.columnId = "done";
      } else {
        task.verificationStatus = "REJECTED";
        task.status = "REJECTED";
        task.columnId = "todo";
      }

      await project.save();

      emitTaskUpdated(project._id.toString(), task);

      return res.status(200).json({
        task,
        nextStep: approved ? "payment_pending" : "developer_rework",
      });
    } catch (error) {
      console.error("Error revisando tarea:", error);
      return res.status(500).json({ error: "Error interno al revisar la tarea" });
    }
  }
);

router.get(
  "/projects/:projectId/pending",
  async (
    req: Request<{ projectId: string }>,
    res: Response<
      | Array<{
          taskId: string;
          title: string;
          layer: TaskDocument["layer"];
          assignedToEmail: string | null;
          status: TaskDocument["status"];
          verificationStatus: TaskDocument["verificationStatus"];
          acceptanceCriteria: string;
        }>
      | { error: string }
    >
  ) => {
    try {
      const { projectId } = req.params;
      await connectMongo();
      const project = await ProjectModel.findById(projectId);

      if (!project) {
        return res.status(404).json({ error: "Proyecto no encontrado" });
      }

      const tasks = project.tasks
        .filter(
          (task) =>
            task.verificationStatus === "SUBMITTED" || task.status === "IN_REVIEW"
        )
        .map((task) => ({
          taskId: task._id.toString(),
          title: task.title,
          layer: task.layer,
          assignedToEmail: task.assignedToEmail ?? null,
          status: task.status,
          verificationStatus: task.verificationStatus,
          acceptanceCriteria: task.acceptanceCriteria,
        }));

      return res.status(200).json(tasks);
    } catch (error) {
      console.error("Error obteniendo tareas pendientes de verificación:", error);
      return res
        .status(500)
        .json({ error: "Error interno al obtener tareas pendientes" });
    }
  }
);

export default router;
