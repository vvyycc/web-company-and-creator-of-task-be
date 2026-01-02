import { Request, Response } from "express";
import { connectMongo } from "../db/mongo";
import { Subscription } from "../models/Subscription";
import { ProjectModel } from "../models/Project";
import { generateProjectEstimationFromDescription } from "../services/generateTasks";
import { generateProjectPlanWithOpenAI } from "../services/openai/generateProjectPlan";

interface GenerateTasksRequestBody {
  ownerEmail: string;
  projectTitle?: string;
  projectDescription?: string;
  title?: string;
  description?: string;
}

export async function generateTasksController(
  req: Request<unknown, unknown, GenerateTasksRequestBody>,
  res: Response
) {
  try {
    const { ownerEmail, projectTitle, projectDescription, title, description } = req.body || {};

    const resolvedTitle = projectTitle ?? title;
    const resolvedDescription = projectDescription ?? description;

    if (!ownerEmail || !resolvedTitle || !resolvedDescription) {
      return res.status(400).json({
        error: "ownerEmail, projectTitle y projectDescription (o title/description) son obligatorios",
      });
    }

    await connectMongo();
    const subscription = await Subscription.findOne({ email: ownerEmail });

    if (!subscription || subscription.status !== "active") {
      return res.status(402).json({
        error: "subscription_required",
        message: "Necesitas una suscripción activa de 30 €/mes para generar el troceado de tareas.",
      });
    }

    const estimation = await (async () => {
      try {
        return await generateProjectPlanWithOpenAI({
          ownerEmail,
          projectTitle: resolvedTitle,
          projectDescription: resolvedDescription,
        });
      } catch (error) {
        console.warn("Fallo OpenAI, usando heurística:", error);
        return generateProjectEstimationFromDescription({
          ownerEmail,
          projectTitle: resolvedTitle,
          projectDescription: resolvedDescription,
        });
      }
    })();

    const project = await ProjectModel.create({
      ownerEmail,
      title: resolvedTitle,
      description: resolvedDescription,

      tasks: estimation.tasks,
      totalTasksPrice: estimation.totalTasksPrice,

      generatorFee: 0,
      platformFeePercent: estimation.platformFeePercent,
      platformFeeAmount: estimation.platformFeeAmount,
      grandTotalClientCost: estimation.grandTotalClientCost,
      stack: estimation.stackRecommended || estimation.stack,

      published: false,
    });

    const formattedProject = (() => {
      const raw = project.toObject();
      return { ...raw, id: project._id.toString() };
    })();

    return res.status(200).json({
      ...estimation,
      projectId: project._id.toString(),
      project: formattedProject,
    });
  } catch (error) {
    console.error("Error generando tareas:", error);
    return res.status(500).json({ error: "Error interno al generar tareas" });
  }
}
