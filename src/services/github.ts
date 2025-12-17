import crypto from "crypto";
import { Request } from "express";
import { connectMongo } from "../db/mongo";
import { GithubAccount } from "../models/GithubAccount";

const GITHUB_API_BASE = "https://api.github.com";

export type GithubRepoInfo = {
  provider: "github";
  repoId: number;
  owner: string;
  repoName: string;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  createdAt: Date;
};

export type GithubClient = {
  token: string;
  getAuthenticatedUser: () => Promise<{ id: number; login: string }>;
  getRepo: (owner: string, repo: string) => Promise<any>;
  listWorkflows: (owner: string, repo: string) => Promise<any>;
  dispatchWorkflow: (
    owner: string,
    repo: string,
    workflowId: number | string,
    ref: string
  ) => Promise<void>;
};

async function githubRequest(
  token: string,
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const res = await fetch(`${GITHUB_API_BASE}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "community-verifier/1.0",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `GitHub API ${path} failed with ${res.status}: ${errorText || res.statusText}`
    );
  }

  if (res.status === 204) return null;
  return res.json();
}

export function createGithubClient(token: string): GithubClient {
  return {
    token,
    async getAuthenticatedUser() {
      const data = await githubRequest(token, "/user");
      return { id: data.id, login: data.login };
    },
    async getRepo(owner: string, repo: string) {
      return githubRequest(token, `/repos/${owner}/${repo}`);
    },
    async listWorkflows(owner: string, repo: string) {
      return githubRequest(token, `/repos/${owner}/${repo}/actions/workflows`);
    },
    async dispatchWorkflow(owner: string, repo: string, workflowId: number | string, ref: string) {
      await githubRequest(token, `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref }),
      });
    },
  };
}

export function slugifyRepoName(title: string): string {
  const normalized = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const slug = normalized
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();

  return slug || "project";
}

async function createGithubRepo(token: string, name: string, description: string) {
  const res = await fetch(`${GITHUB_API_BASE}/user/repos`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "community-verifier/1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      description,
      private: true,
      auto_init: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`create_repo_failed:${res.status}:${text || res.statusText}`);
    (error as any).status = res.status;
    throw error;
  }

  return res.json();
}

async function upsertReadme(
  token: string,
  owner: string,
  repo: string,
  content: string,
  message = "chore: initialize community README"
) {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  let sha: string | undefined;

  try {
    const current = await githubRequest(token, `/repos/${owner}/${repo}/contents/README.md`);
    sha = current?.sha;
  } catch (error: any) {
    // 404 when file does not exist; ignore
    if (!String(error?.message || "").includes("404")) {
      console.warn("[github] No se pudo leer README actual:", error);
    }
  }

  await githubRequest(token, `/repos/${owner}/${repo}/contents/README.md`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: encoded,
      sha,
    }),
  });
}

export async function createProjectRepo(
  ownerEmail: string,
  projectId: string,
  projectTitle: string,
  projectDescription: string
): Promise<GithubRepoInfo> {
  const { account } = await getOctokitForEmail(ownerEmail);
  const baseSlug = slugifyRepoName(projectTitle);
  let attemptedSlug = baseSlug;

  try {
    const repo = await createGithubRepo(account.accessToken, attemptedSlug, projectDescription);

    const readme = `# ${projectTitle}\n\n${projectDescription}\n\n## Cómo contribuir\n- Abre issues o pull requests para proponer cambios.\n- Sigue las guías de contribución del proyecto.\n`;
    await upsertReadme(account.accessToken, repo.owner.login, repo.name, readme);

    console.log(`[github:create-repo] Creado ${repo.full_name} con slug ${attemptedSlug}`);
    return {
      provider: "github",
      repoId: repo.id,
      owner: repo.owner.login,
      repoName: repo.name,
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      private: repo.private,
      createdAt: new Date(repo.created_at),
    };
  } catch (error: any) {
    const message = String(error?.message || "");
    if (String(error?.status) === "422") {
      const suffix = projectId?.slice(-6) || Date.now().toString(36);
      attemptedSlug = `${baseSlug}-${suffix}`;
      const repo = await createGithubRepo(account.accessToken, attemptedSlug, projectDescription);
      const readme = `# ${projectTitle}\n\n${projectDescription}\n\n## Cómo contribuir\n- Abre issues o pull requests para proponer cambios.\n- Sigue las guías de contribución del proyecto.\n`;
      await upsertReadme(account.accessToken, repo.owner.login, repo.name, readme);
      console.log(
        `[github:create-repo] Slug en colisión, usando ${attemptedSlug} para proyecto ${projectId} (${message})`
      );
      return {
        provider: "github",
        repoId: repo.id,
        owner: repo.owner.login,
        repoName: repo.name,
        fullName: repo.full_name,
        htmlUrl: repo.html_url,
        private: repo.private,
        createdAt: new Date(repo.created_at),
      };
    }
    console.error(
      `[github:create-repo] Error creando repo para ${ownerEmail} slug=${attemptedSlug} scopes=${
        account.scopes?.join(",") || ""
      }:`,
      error
    );
    throw error;
  }
}

export async function checkCollaborator(
  repoFullName: string,
  username: string,
  token: string
): Promise<boolean> {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) return false;

  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/collaborators/${username}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "community-verifier/1.0",
    },
  });

  if (res.status === 204) return true;
  if (res.status === 404 || res.status === 302 || res.status === 301) return false;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`check_collaborator_failed:${res.status}:${text}`);
  }

  return false;
}

export async function exchangeCodeForToken(code: string, redirectUri?: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Faltan GITHUB_CLIENT_ID o GITHUB_CLIENT_SECRET");
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`No se pudo intercambiar el código OAuth: ${text}`);
  }

  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`Respuesta OAuth inválida: ${data.error || "sin token"}`);
  }

  return data.access_token;
}

export async function getOctokitForEmail(userEmail: string) {
  await connectMongo();
  const account = await GithubAccount.findOne({ userEmail });
  if (!account) throw new Error("github_account_not_found");

  const client = createGithubClient(account.accessToken);
  return { account, client };
}

export function verifyGithubSignature(req: Request): boolean {
  const signature = req.header("x-hub-signature-256");
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!signature || !secret) {
    console.warn("[github:webhook] Falta signature o secreto");
    return false;
  }

  const body = (req as any).body;
  const payloadBuffer = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));

  const digest = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payloadBuffer)
    .digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch (error) {
    console.error("[github:webhook] Error comparando firmas:", error);
    return false;
  }
}
