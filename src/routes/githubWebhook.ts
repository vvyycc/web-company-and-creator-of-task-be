import express, { Request, Response } from "express";
import mongoose from "mongoose";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { ChecklistStatus, emitBoardUpdate, ensureTaskDefaults, mapTaskToBoard } from "./community";
import { verifyGithubSignature } from "../services/github";

const router = express.Router();

type ChecklistResult = { key: string; status: ChecklistStatus; details?: string };

type ParsedSummary = {
  projectId?: string;
  taskId?: string;
  items: ChecklistResult[];
};

const STATUS_SUCCESS = new Set(["success"]);
const STATUS_FAILURE = new Set(["failure", "timed_out", "cancelled", "action_required"]);

function parseChecklistSummary(summary?: string): ParsedSummary {
  const parsed: ParsedSummary = { items: [] };
  if (!summary) return parsed;

  const projectMatch = summary.match(/PROJECT_ID=([\w-]+)/);
  const taskMatch = summary.match(/TASK_ID=([\w-]+)/);
  if (projectMatch) parsed.projectId = projectMatch[1];
  if (taskMatch) parsed.taskId = taskMatch[1];

  summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^[-*]\s*(✅|✔️|❌)\s*([^|\s]+)\s*(?:\|\s*(.+))?/);
      if (match) {
        parsed.items.push({
          key: match[2].trim(),
          status: match[1].includes("❌") ? "FAILED" : "PASSED",
          details: match[3]?.trim(),
        });
      }
    });

  return parsed;
}

function parseChecklistKeysInput(value: any): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

router.post("/", async (req: Request, res: Response) => {
  if (!verifyGithubSignature(req)) {
    return res.status(401).json({ error: "signature_mismatch" });
  }

  const event = req.header("x-github-event") || "";
  const delivery = req.header("x-github-delivery");

  let payload: any = req.body;
  if (Buffer.isBuffer(req.body)) {
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch (error) {
      console.error("[github:webhook] Body inválido", error);
      return res.status(400).json({ error: "payload_invalid" });
    }
  }

  const checkRun = event === "check_run" ? payload?.check_run : null;
  const workflowRun = event === "workflow_run" ? payload?.workflow_run : null;

  const status = checkRun?.status || workflowRun?.status;
  const conclusion = checkRun?.conclusion || workflowRun?.conclusion;
  const repoFullName =
    checkRun?.repository?.full_name || workflowRun?.repository?.full_name || payload?.repository?.full_name;
  const htmlUrl = checkRun?.html_url || workflowRun?.html_url;
  const inputs: any = workflowRun?.inputs || {};
  const branch =
    inputs?.branch || checkRun?.check_suite?.head_branch || checkRun?.head_branch || workflowRun?.head_branch || null;
  const summaryText = String(checkRun?.output?.summary || "");

  console.log(`[github:webhook] event=${event} delivery=${delivery} repo=${repoFullName}`);

  if (status !== "completed") {
    return res.status(200).json({ ignored: true });
  }

  const parsedSummary = parseChecklistSummary(summaryText);
  const keysFromInput = parseChecklistKeysInput(inputs?.checklistKeys);
  const checklistKeys = (keysFromInput.length ? keysFromInput : parsedSummary.items.map((i) => i.key)).filter(Boolean);

  let projectId = parsedSummary.projectId || inputs?.projectId;
  let taskId = parsedSummary.taskId || inputs?.taskId;

  if (!taskId && branch) {
    const match = String(branch).match(/task-([a-f0-9]{24})-/i);
    if (match) taskId = match[1];
  }

  try {
    await connectMongo();

    let doc: any = null;
    if (projectId && mongoose.Types.ObjectId.isValid(projectId)) {
      doc = await CommunityProject.findById(projectId);
    }
    if (!doc && taskId) {
      doc = await CommunityProject.findOne({ "estimation.tasks.id": String(taskId), isPublished: true });
    }

    if (!doc || !doc.isPublished) {
      return res.status(200).json({ ignored: true });
    }

    const estimation: any = doc.estimation || {};
    const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];
    const task = tasks.find((t) => String(t.id) === String(taskId));

    if (!task) return res.status(200).json({ ignored: true });

    ensureTaskDefaults(task);

    if (!task.repo) {
      task.repo = { provider: "github", repoFullName, branch: branch || undefined, checks: { status: "IDLE" } };
    }
    task.repo.repoFullName = task.repo.repoFullName || repoFullName;
    if (branch && !task.repo.branch) {
      task.repo.branch = branch;
    }
    task.repo.checks = task.repo.checks || { status: "IDLE" };
    task.repo.checks.lastRunUrl = htmlUrl;
    task.repo.checks.lastRunConclusion = conclusion;

    if (STATUS_SUCCESS.has(conclusion)) {
      task.repo.checks.status = "PASSED";
    } else if (STATUS_FAILURE.has(conclusion)) {
      task.repo.checks.status = "FAILED";
    } else {
      task.repo.checks.status = task.repo.checks.status || "PENDING";
    }

    if (!Array.isArray(task.checklist)) {
      task.checklist = [];
    }

    const applyResult = (result: ChecklistResult) => {
      const existing = task.checklist?.find((c: any) => String(c.key) === String(result.key));
      if (existing) {
        existing.status = result.status;
        if (result.details) existing.details = result.details;
      } else {
        task.checklist.push({
          key: result.key,
          text: result.key,
          status: result.status,
          ...(result.details ? { details: result.details } : {}),
        });
      }
    };

    if (parsedSummary.items.length) {
      parsedSummary.items.forEach(applyResult);
    } else if (STATUS_SUCCESS.has(conclusion) || STATUS_FAILURE.has(conclusion)) {
      const statusForAll: ChecklistStatus = STATUS_SUCCESS.has(conclusion) ? "PASSED" : "FAILED";
      const keys = checklistKeys.length ? checklistKeys : task.checklist.map((c: any) => c.key);
      if (!task.checklist.length && keys.length) {
        keys.forEach((key: string) => task.checklist.push({ key, text: key, status: "PENDING" }));
      }
      task.checklist.forEach((item: any) => {
        if (!keys.length || keys.includes(item.key)) {
          item.status = statusForAll;
        }
      });
    }

    const allPassed = Array.isArray(task.checklist) && task.checklist.length > 0 && task.checklist.every((c: any) => c.status === "PASSED");

    if (allPassed) {
      task.columnId = "done";
      task.status = "DONE";
      task.verificationStatus = "APPROVED";
      task.verification = task.verification || { status: "APPROVED" };
      task.verification.status = "APPROVED";
      task.verificationNotes = task.verificationNotes || "Auto-approved by verifier";
      console.log(
        `[community:auto-done] task moved project=${doc.id} task=${task.id} repo=${task.repo?.repoFullName}`
      );
    } else {
      task.verificationStatus = task.verificationStatus || "SUBMITTED";
      task.verification = task.verification || { status: task.verificationStatus };
      task.verification.status = task.verification.status || "SUBMITTED";
    }

    estimation.tasks = tasks;
    doc.estimation = estimation;
    doc.markModified("estimation");
    await doc.save();

    emitBoardUpdate(doc.id, tasks);

    console.log(
      `[github:webhook] updated checklist project=${doc.id} task=${task.id} conclusion=${conclusion} status=${task.repo?.checks?.status}`
    );

    return res.status(200).json({ ok: true, tasks: tasks.map((t) => mapTaskToBoard(t)) });
  } catch (error) {
    console.error("[github:webhook] Error procesando webhook:", error);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
