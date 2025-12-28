import express, { Request, Response } from "express";
import { connectMongo } from "../db/mongo";
import { GithubAccount } from "../models/GithubAccount";
import { exchangeCodeForToken, createGithubClient } from "../services/github";

const router = express.Router();

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/**
 * ✅ RUTAS FINALES (si montas app.use("/integrations/github", router)):
 * - GET  /integrations/github/login?userEmail=...&returnTo=...&popup=1
 * - GET  /integrations/github/callback?code=...&state=...
 * - GET  /integrations/github/status?userEmail=...
 */

// -------------------------
// Helpers
// -------------------------
function getFrontendBase() {
  return process.env.FRONTEND_URL || "http://localhost:3000";
}

function safeReturnTo(input: unknown, fallback = "/community") {
  if (typeof input !== "string") return fallback;
  if (!input.startsWith("/")) return fallback;
  if (input.startsWith("//")) return fallback; // evita open-redirect
  return input;
}

function sendPopupClose(res: Response, payload: any) {
  const frontendBase = getFrontendBase();
  const json = JSON.stringify(payload || {});

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>GitHub OAuth</title>
  </head>
  <body>
    <script>
      (function(){
        var data = ${json};
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.postMessage(data, "${frontendBase}");
          }
        } catch (e) {}

        try { window.close(); } catch (e) {}

        // fallback si el navegador bloquea window.close()
        setTimeout(function(){
          try {
            var returnTo = (data && data.returnTo) ? data.returnTo : "/community";
            var qs = (data && data.qs) ? data.qs : "?github=connected";
            window.location.href = "${frontendBase}" + returnTo + qs;
          } catch (e) {
            window.location.href = "${frontendBase}/community?github=connected";
          }
        }, 350);
      })();
    </script>
    <p>Conectando GitHub… Puedes cerrar esta ventana.</p>
  </body>
</html>`;

  return res.status(200).setHeader("Content-Type", "text/html").send(html);
}

// -------------------------
// GET /github/login
// -------------------------
router.get("/login", async (req: Request, res: Response) => {
  const userEmail = (req.query.userEmail as string) || "";
  const returnTo = safeReturnTo(req.query.returnTo, "/community");
  const popup = String(req.query.popup || "") === "1";

  if (!userEmail) return res.status(400).json({ error: "userEmail es obligatorio" });

  const clientId = process.env.GITHUB_CLIENT_ID;
  const callbackUrl = process.env.GITHUB_CALLBACK_URL;

  if (!clientId || !callbackUrl) {
    return res.status(500).json({ error: "Faltan variables OAuth de GitHub" });
  }

  const state = Buffer.from(
    JSON.stringify({ userEmail, returnTo, popup, ts: Date.now() }),
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
// GET /github/callback ✅ FIX DUPLICATE KEY + POPUP MODE
// -------------------------
router.get("/callback", async (req: Request, res: Response) => {
  // intentamos recuperar returnTo/popup incluso en error
  const parseState = () => {
    let userEmail = "";
    let returnTo = "/community";
    let popup = false;

    const state = String((req.query as any).state || "");
    if (state) {
      try {
        const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
        userEmail = parsed.userEmail || "";
        returnTo = safeReturnTo(parsed.returnTo, "/community");
        popup = !!parsed.popup;
      } catch {}
    }
    return { userEmail, returnTo, popup };
  };

  try {
    const { code } = req.query as { code?: string; state?: string };
    if (!code) return res.status(400).json({ error: "code es obligatorio" });

    const { userEmail, returnTo, popup } = parseState();
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
      const frontendBase = getFrontendBase();
      const qs = "?github=conflict&reason=github_already_linked";

      if (popup) {
        return sendPopupClose(res, {
          github: "conflict",
          reason: "github_already_linked",
          returnTo,
          qs,
        });
      }

      return res.redirect(302, `${frontendBase}${returnTo}${qs}`);
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

    const frontendBase = getFrontendBase();
    const qs = `?github=connected&githubLogin=${encodeURIComponent(user.login)}`;

    // ✅ Popup mode: notifica al opener y cierra
    if (popup) {
      return sendPopupClose(res, {
        github: "connected",
        githubLogin: user.login,
        returnTo,
        qs,
      });
    }

    // ✅ Normal mode: redirect al frontend
    return res.redirect(302, `${frontendBase}${returnTo}${qs}`);
  } catch (error) {
    console.error("[github:callback] Error:", error);

    const { returnTo, popup } = parseState();
    const frontendBase = getFrontendBase();
    const qs = "?github=error";

    if (popup) {
      return sendPopupClose(res, { github: "error", returnTo, qs });
    }

    return res.redirect(302, `${frontendBase}${returnTo}${qs}`);
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
