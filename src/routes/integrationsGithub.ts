import express, { Request, Response } from "express";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { GithubAccount } from "../models/GithubAccount";
import {
  exchangeCodeForToken,
  getOctokitForEmail,
} from "../services/github";
import {
  mapTaskToBoard,
  normalizeAndPersistTaskIds,
  emitBoardUpdate,
  ensureTaskDefaults,
} from "./community";

const router = express.Router();

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/**
 * ✅ RUTAS FINALES (si montas app.use("/integrations", router)):
 * - GET  /integrations/github/login?userEmail=...
 * - GET  /integrations/github/callback?code=...&state=...
 * - POST /integrations/community/projects/:id/tasks/:taskId/link-repo
 * - POST /integrations/community/projects/:id/tasks/:taskId/run-verify
 */

// -------------------------
// GET /github/login
// -------------------------
router.get("/login", async (req: Request, res: Response) => {
  const userEmail = (req.query.userEmail as string) || "";
  const returnTo = (req.query.returnTo as string) || "/community";

  if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

  const clientId = process.env.GITHUB_CLIENT_ID;
  const callbackUrl = process.env.GITHUB_CALLBACK_URL;

  if (!clientId || !callbackUrl) {
    return res.status(500).json({ error: "Faltan variables OAuth de GitHub" });
  }

  const state = Buffer.from(
    JSON.stringify({ userEmail, returnTo, ts: Date.now() }),
    "utf8"
  ).toString("base64url");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: "repo read:user workflow",
    prompt: "consent",
    state,
  });

  return res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// -------------------------
// GET /github/callback  ✅ ESTE ES EL QUE QUIERES
// -------------------------
router.get("/callback", async (req: Request, res: Response) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code) return res.status(400).json({ error: "code es obligatorio" });

    let userEmail = "";
    let returnTo = "/community";

    if (state) {
      try {
        const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
        userEmail = parsed.userEmail || "";
        returnTo = parsed.returnTo || "/community";
      } catch {}
    }

    if (!userEmail) return res.status(400).json({ error: "userEmail no encontrado en state" });

    const token = await exchangeCodeForToken(code, process.env.GITHUB_CALLBACK_URL);

    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "community-verifier/1.0",
      },
    });

    if (!userRes.ok) {
      const text = await userRes.text();
      throw new Error(`github_user_fetch_failed:${userRes.status}:${text}`);
    }

    const scopesHeader = userRes.headers.get("x-oauth-scopes") || "";
    const scopes = scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const user = await userRes.json();

    await connectMongo();
    await GithubAccount.findOneAndUpdate(
      { userEmail },
      {
        userEmail,
        githubUserId: user.id,
        githubLogin: user.login,
        accessToken: token,
        scopes,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const frontendBase = process.env.FRONTEND_URL || "http://localhost:3000";
    const redirectUrl =
      `${frontendBase}${returnTo}` +
      `?github=connected&githubLogin=${encodeURIComponent(user.login)}`;

    return res.redirect(302, redirectUrl);
  } catch (error) {
    console.error("[github:callback] Error:", error);
    const frontendBase = process.env.FRONTEND_URL || "http://localhost:3000";
    return res.redirect(302, `${frontendBase}/community?github=error`);
  }
});

// -------------------------
// POST /community/projects/:id/tasks/:taskId/link-repo
// -------------------------
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
        return res.status(400).json({ error: "userEmail y repoFullName son obligatorios" });
      }

      const [owner, repo] = repoFullName.split("/");
      if (!owner || !repo) {
        return res.status(400).json({ error: "repoFullName debe ser owner/repo" });
      }

      await connectMongo();
      const doc: any = await CommunityProject.findById(id);
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

      await normalizeAndPersistTaskIds(doc);

      const estimation: any = doc.estimation || {};
      const tasks: any[] = Array.isArray(estimation.tasks) ? estimation.tasks : [];
      const task = tasks.find((t) => String(t.id) === String(taskId));
      if (!task) return res.status(404).json({ error: "Tarea no encontrada" });

      // Política simple: asignado o dueño del proyecto
      if (task.assigneeEmail !== userEmail && doc.ownerEmail !== userEmail) {
        return res.status(403).json({ error: "Solo el asignado o dueño puede vincular un repo" });
      }

      // Comprueba acceso al repo con el token del userEmail
      const { client } = await getOctokitForEmail(userEmail);
      await client.getRepo(owner, repo);

      ensureTaskDefaults(task);
      task.repo = {
        provider: "github",
        repoFullName,
        checks: task.repo?.checks || { status: "IDLE" },
      };

      // Si ya está en review, lo marcamos SUBMITTED
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
      return res.status(500).json({ error: error?.message || "Error vinculando repo" });
    }
  }
);

// -------------------------
// POST /community/projects/:id/tasks/:taskId/run-verify
// -------------------------
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
      if (!doc || !doc.isPublished) return res.status(404).json({ error: "Proyecto no encontrado" });

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
          workflows?.workflows?.find((w: any) => String(w?.path || "").endsWith("verify.yml")) ||
          workflows?.workflows?.find((w: any) => w?.name === "verify");

        if (workflow?.id) {
          const repoInfo = await client.getRepo(owner, repo);
          const ref = repoInfo?.default_branch || "main";
          await client.dispatchWorkflow(owner, repo, workflow.id, ref);
          console.log(`[github:run-verify] workflow ${workflow.id} dispatch ${owner}/${repo} ref=${ref}`);
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
router.get("/status", async (req: Request, res: Response) => {
  const userEmail = String(req.query.userEmail || "").trim();
  if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

  await connectMongo();
  const acc = await GithubAccount.findOne({ userEmail }).lean();

  return res
    .status(200)
    .json({
      connected: !!acc?.accessToken,
      githubLogin: acc?.githubLogin || null,
      scopes: acc?.scopes || [],
    });
});

export default router;
