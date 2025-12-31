import { Request, Response } from "express";
import { generateTasksFromOpenAI } from "../services/openaiTaskGenerator";
import { GenerateTasksRequestBody } from "../types/generateTasks";

export const handleGenerateTasks = async (
  req: Request<unknown, unknown, GenerateTasksRequestBody>,
  res: Response
) => {
  try {
    const { title, description } = req.body || {};

    if (!title || !description) {
      return res.status(400).json({
        error: "title y description son obligatorios",
      });
    }

    const result = await generateTasksFromOpenAI({ title, description });

    return res.status(200).json(result);
  } catch (error) {
    console.error("Error generando tareas con OpenAI:", error);
    return res.status(500).json({ error: "No se pudieron generar las tareas" });
  }
};
