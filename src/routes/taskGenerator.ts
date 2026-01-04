import express from "express";
import { handleGenerateTasks } from "../controllers/taskGenerationController";
import { GenerateTasksRequestBody } from "../types/generateTasks";

const router = express.Router();

router.post<unknown, unknown, GenerateTasksRequestBody>(
  "/generate-tasks",
  handleGenerateTasks
);

export default router;
