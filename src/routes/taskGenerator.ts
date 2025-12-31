import express from "express";
import { handleGenerateTasks } from "../controllers/taskGenerationController";

const router = express.Router();

router.post("/generate-tasks", handleGenerateTasks);

export default router;
