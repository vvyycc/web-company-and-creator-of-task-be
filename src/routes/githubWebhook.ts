import express, { Request, Response } from "express";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { emitBoardUpdate, mapTaskToBoard, ensureTaskDefaults } from "./community";
import { verifyGithubSignature } from "../services/github";

const router = express.Router();

function parseGithubPayload(event: string, payload: any) {
  try {
    if (event === "check_run") {
      const checkRun = payload?.check_run;
      return {
        status: checkRun?.status,
        conclusion: checkRun?.conclusion,
        repoFullName: checkRun?.repository?.full_name || payload?.repository?.full_name,
        htmlUrl: checkRun?.html_url,
      };
    }

    if (event === "check_suite") {
      const suite = payload?.check_suite;
      return {
        status: suite?.status,
        conclusion: suite?.conclusion,
        repoFullName: suite?.repository?.full_name || payload?.repository?.full_name,
        htmlUrl: suite?.url || suite?.html_url,
      };
    }

    if (event === "workflow_run") {
      const run = payload?.workflow_run;
      return {
        status: run?.status,
        conclusion: run?.conclusion,
        repoFullName: run?.repository?.full_name || payload?.repository?.full_name,
        htmlUrl: run?.html_url,
      };
    }
  } catch (error) {
    console.warn("[github:webhook] No se pudo parsear payload", error);
  }

  return null;
}

function pickTaskForRepo(tasks: any[], repoFullName: string) {
  const matching = tasks.filter((t) => t?.repo?.repoFullName === repoFullName);
  if (!matching.length) return null;

  const reviewTasks = matching.filter((t) => (t.columnId ?? "").toString() === "review");
  if (reviewTasks.length) return reviewTasks[reviewTasks.length - 1];

  return matching[matching.length - 1];
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

  console.log(`[github:webhook] event=${event} delivery=${delivery}`);

  const parsed = parseGithubPayload(event, payload);
  if (!parsed || !parsed.repoFullName) {
    return res.status(200).json({ ignored: true });
  }

  const { status, conclusion, repoFullName, htmlUrl } = parsed;
  if (status !== "completed") {
    return res.status(200).json({ ignored: true });
  }

  try {
    await connectMongo();
    const doc: any = await CommunityProject.findOne({
      "estimation.tasks.repo.repoFullName": repoFullName,
      isPublished: true,
    });

    if (!doc) return res.status(200).json({ ignored: true });

    const estimation: any = doc.estimation || {};
    const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];
    const task = pickTaskForRepo(tasks, repoFullName);

    if (!task) return res.status(200).json({ ignored: true });

    ensureTaskDefaults(task);
    task.repo = task.repo || { provider: "github", repoFullName };
    task.repo.checks = task.repo.checks || { status: "IDLE" };
    task.repo.checks.lastRunUrl = htmlUrl;
    task.repo.checks.lastRunConclusion = conclusion;

    if (conclusion === "success") {
      task.verificationStatus = "APPROVED";
      task.verification = task.verification || { status: "APPROVED" };
      task.verification.status = "APPROVED";
      task.status = "DONE";
      task.columnId = "done";
      task.repo.checks.status = "PASSED";
      task.verificationNotes = "Auto-approved by verifier";
    } else {
      task.repo.checks.status = "FAILED";
      task.verificationStatus = task.verificationStatus || "SUBMITTED";
      task.verification = task.verification || { status: task.verificationStatus };
      task.verification.notes = `Verificación automática falló (${conclusion || "unknown"}).`;
      task.verificationNotes = htmlUrl
        ? `Verificación fallida. Revisa el run: ${htmlUrl}`
        : "Verificación fallida";
      task.columnId = task.columnId || "review";
    }

    estimation.tasks = tasks;
    doc.estimation = estimation;
    doc.markModified("estimation");
    await doc.save();

    emitBoardUpdate(doc.id, tasks);
    return res.status(200).json({ ok: true, tasks: tasks.map((t) => mapTaskToBoard(t)) });
  } catch (error) {
    console.error("[github:webhook] Error procesando webhook:", error);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
