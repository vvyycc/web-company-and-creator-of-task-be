import express, { Request, Response } from "express";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { GithubAccount } from "../models/GithubAccount";
import {
  exchangeCodeForToken,
  getOctokitForEmail,
  createGithubClient,
} from "../services/github";
import {
  mapTaskToBoard,
  normalizeAndPersistTaskIds,
  emitBoardUpdate,
  ensureTaskDefaults,
} from "./community";

const router = express.Router();

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

router.get("/login", async (req: Request, res: Response) => {
  const userEmail = (req.query.userEmail as string) || "";
  if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

  const clientId = process.env.GITHUB_CLIENT_ID;
  const callbackUrl = process.env.GITHUB_CALLBACK_URL;

  if (!clientId || !callbackUrl) {
    return res.status(500).json({ error: "Faltan variables OAuth de GitHub" });
  }

  const state = Buffer.from(
    JSON.stringify({ userEmail, ts: Date.now() }),
    "utf8"
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: "repo read:user workflow",
    state,
  });

  return res.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
});

router.get("/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) return res.status(400).json({ error: "code es obligatorio" });

    let userEmail = "";
    if (state) {
      try {
        const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
        userEmail = parsed.userEmail;
      } catch (error) {
        console.warn("[github:callback] state inválido", error);
      }
    }

    const resolvedUserEmail = userEmail || (req.query.userEmail as string);
    if (!resolvedUserEmail) {
      return res.status(400).json({ error: "userEmail no encontrado en state" });
    }

    const token = await exchangeCodeForToken(
      code,
      process.env.GITHUB_CALLBACK_URL
    );

    const client = createGithubClient(token);
    const user = await client.getAuthenticatedUser();

    await connectMongo();
    const account = await GithubAccount.findOneAndUpdate(
      { userEmail: resolvedUserEmail },
      {
        userEmail: resolvedUserEmail,
        githubUserId: user.id,
        githubLogin: user.login,
        accessToken: token,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({
      ok: true,
      githubLogin: account.githubLogin,
      githubUserId: account.githubUserId,
    });
  } catch (error) {
    console.error("[github:callback] Error intercambiando token:", error);
    return res.status(500).json({ error: "No se pudo conectar con GitHub" });
  }
});

router.post(
  "/community/projects/:id/tasks/:taskId/link-repo",
  async (
    req: Request<
      { id: string; taskId: string },
      unknown,
      { userEmail?: string; repoFullName?: string }
    >,
    res: Response
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail, repoFullName } = req.body || {};

      if (!userEmail || !repoFullName) {
        return res
          .status(400)
          .json({ error: "userEmail y repoFullName son obligatorios" });
      }

      const [owner, repo] = repoFullName.split("/");
      if (!owner || !repo) {
        return res.status(400).json({ error: "repoFullName debe ser owner/repo" });
      }

      await connectMongo();
      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished)
        return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];
      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      if (task.assigneeEmail !== userEmail && doc.ownerEmail !== userEmail) {
        return res
          .status(403)
          .json({ error: "Solo el asignado o dueño puede vincular un repo" });
      }

      const { client } = await getOctokitForEmail(userEmail);
      await client.getRepo(owner, repo);

      ensureTaskDefaults(task);
      task.repo = {
        provider: "github",
        repoFullName,
        checks: task.repo?.checks || { status: "IDLE" },
      };

      if ((task.columnId as string) === "review") {
        task.verificationStatus = "SUBMITTED";
        task.verification = task.verification || { status: "SUBMITTED" };
        task.verification.status = "SUBMITTED";
      }

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");
      await doc.save();

      emitBoardUpdate(id, tasks);
      return res.status(200).json({ tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error: any) {
      console.error("[github:link-repo] Error:", error);
      const message = error?.message || "Error vinculando repo";
      return res.status(500).json({ error: message });
    }
  }
);

router.post(
  "/community/projects/:id/tasks/:taskId/run-verify",
  async (
    req: Request<{ id: string; taskId: string }, unknown, { userEmail?: string }>,
    res: Response
  ) => {
    try {
      const { id, taskId } = req.params;
      const { userEmail } = req.body || {};

      if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

      await connectMongo();
      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished)
        return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];
      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      if ((task.columnId as string) !== "review") {
        return res.status(400).json({ error: "La tarea debe estar en revisión" });
      }

      if (!task.repo?.repoFullName) {
        return res.status(400).json({ error: "La tarea no tiene repo vinculado" });
      }

      const { client } = await getOctokitForEmail(userEmail);
      const [owner, repo] = task.repo.repoFullName.split("/");
      await client.getRepo(owner, repo);

      ensureTaskDefaults(task);
      task.repo = task.repo || { provider: "github" };
      task.repo.checks = { ...(task.repo.checks || {}), status: "PENDING" };
      task.verificationStatus = task.verificationStatus || "SUBMITTED";
      task.verification = task.verification || { status: "SUBMITTED" };
      task.verification.status = task.verification.status || "SUBMITTED";

      estimation.tasks = tasks;
      doc.estimation = estimation;
      doc.markModified("estimation");
      await doc.save();

      // Opcional: dispara workflow verify.yml si existe
      try {
        const workflows = await client.listWorkflows(owner, repo);
        const workflow =
          workflows?.workflows?.find((w: any) =>
            String(w?.path || "").endsWith("verify.yml")
          ) || workflows?.workflows?.find((w: any) => w?.name === "verify");

        if (workflow?.id) {
          const repoInfo = await client.getRepo(owner, repo);
          const ref = repoInfo?.default_branch || "main";
          await client.dispatchWorkflow(owner, repo, workflow.id, ref);
          console.log(
            `[github:run-verify] Disparado workflow ${workflow.id} en ${owner}/${repo} ref ${ref}`
          );
        }
      } catch (err) {
        console.warn("[github:run-verify] No se pudo disparar workflow:", err);
      }

      emitBoardUpdate(id, tasks);
      return res.status(200).json({ ok: true, tasks: tasks.map((t) => mapTaskToBoard(t)) });
    } catch (error: any) {
      console.error("[github:run-verify] Error:", error);
      return res.status(500).json({ error: error?.message || "Error corriendo verificación" });
    }
  }
);

export default router;
