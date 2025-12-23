import express, { Request, Response } from "express";
import { connectMongo } from "../db/mongo";
import { GithubAccount } from "../models/GithubAccount";
import {
  exchangeCodeForToken,
  createGithubClient,
} from "../services/github";


const router = express.Router();

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/**
 * ✅ RUTAS FINALES (si montas app.use("/integrations", router)):
 * - GET  /integrations/github/login?userEmail=...&returnTo=...
 * - GET  /integrations/github/callback?code=...&state=...
 * - GET  /integrations/github/status?userEmail=...
 *
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

  // ✅ delete_repo necesario para poder borrar repos desde backend
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: "repo read:user workflow delete_repo",
    state,
    prompt: "consent",
  });

  return res.redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
});

// -------------------------
// GET /github/callback ✅ FIX DUPLICATE KEY
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

    const client = createGithubClient(token);
    const user = await client.getAuthenticatedUser(); // { id, login }

    await connectMongo();

    // 1) Si el githubUserId ya existe ligado a otro email => conflicto
    const existingByGithubId = await GithubAccount.findOne({ githubUserId: user.id });

    if (
      existingByGithubId &&
      String(existingByGithubId.userEmail).toLowerCase() !== userEmail.toLowerCase()
    ) {
      const frontendBase = process.env.FRONTEND_URL || "http://localhost:3000";
      return res.redirect(
        302,
        `${frontendBase}${returnTo}?github=conflict&reason=github_already_linked`
      );
    }

    // 2) Limpia docs previos para ese userEmail con otro githubUserId (evita inconsistencias)
    await GithubAccount.deleteMany({ userEmail, githubUserId: { $ne: user.id } });

    // 3) Upsert por githubUserId (evita E11000 duplicate key)
    await GithubAccount.findOneAndUpdate(
      { githubUserId: user.id },
      {
        userEmail,
        githubUserId: user.id,
        githubLogin: user.login,
        accessToken: token,
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
// GET /github/status?userEmail=...
// -------------------------
router.get("/status", async (req: Request, res: Response) => {
  const userEmail = String(req.query.userEmail || "").trim();
  if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

  await connectMongo();
  const acc = await GithubAccount.findOne({ userEmail }).lean();

  return res.status(200).json({
    connected: !!acc?.accessToken,
    githubLogin: acc?.githubLogin || null,
  });
});

export default router;
