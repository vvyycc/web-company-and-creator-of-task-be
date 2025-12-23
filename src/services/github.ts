import crypto from "crypto";
import { Request } from "express";
import { connectMongo } from "../db/mongo";
import { GithubAccount } from "../models/GithubAccount";

const GITHUB_API_BASE = "https://api.github.com";

export type GithubClient = {
  token: string;

  getAuthenticatedUser: () => Promise<{ id: number; login: string }>;
  getRepo: (owner: string, repo: string) => Promise<any>;

  listWorkflows: (owner: string, repo: string) => Promise<any>;

  // ✅ IMPORTANTE: mantener firma con 6 args (como te lo pide TS)
  dispatchWorkflow: (
    owner: string,
    repo: string,
    workflowId: number | string,
    ref: string,
    projectId: string | number,
    taskId: string | number
  ) => Promise<void>;

  createRepo: (payload: {
    name: string;
    description?: string;
    private?: boolean;
    auto_init?: boolean;
  }) => Promise<any>;

  getContent: (owner: string, repo: string, path: string) => Promise<any>;

  createOrUpdateFile: (
    owner: string,
    repo: string,
    path: string,
    payload: { message: string; content: string; sha?: string }
  ) => Promise<any>;

  inviteCollaborator: (owner: string, repo: string, username: string) => Promise<any>;
  isCollaborator: (owner: string, repo: string, username: string) => Promise<boolean>;
  listInvitations: (owner: string, repo: string) => Promise<any[]>;
  deleteRepo: (owner: string, repo: string) => Promise<void>;

  // ✅ NUEVO: refs (ramas)
  getRef: (owner: string, repo: string, ref: string) => Promise<any>;
  createRef: (owner: string, repo: string, ref: string, sha: string) => Promise<any>;
};

async function githubRequest(token: string, path: string, options: RequestInit = {}): Promise<any> {
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
    const error: any = new Error(
      `GitHub API ${path} failed with ${res.status}: ${errorText || res.statusText}`
    );
    error.status = res.status;
    error.responseBody = errorText;
    throw error;
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

    // ✅ FIX: ahora acepta projectId/taskId (aunque tu workflow no los use, TS lo exige)
    async dispatchWorkflow(
      owner: string,
      repo: string,
      workflowId: number | string,
      ref: string,
      projectId: string | number,
      taskId: string | number
    ) {
      await githubRequest(token, `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
        method: "POST",
        body: JSON.stringify({
          ref,
          inputs: {
            projectId: String(projectId),
            taskId: String(taskId),
          },
        }),
      });
    },

    async createRepo(payload) {
      return githubRequest(token, "/user/repos", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },

    async getContent(owner: string, repo: string, path: string) {
      return githubRequest(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`);
    },

    async createOrUpdateFile(owner: string, repo: string, path: string, payload) {
      return githubRequest(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    },

    async inviteCollaborator(owner: string, repo: string, username: string) {
      return githubRequest(
        token,
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`,
        { method: "PUT" }
      );
    },

    async isCollaborator(owner: string, repo: string, username: string) {
      try {
        await githubRequest(token, `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}`);
        return true;
      } catch (error: any) {
        if (error?.status === 404) return false;
        throw error;
      }
    },

    async listInvitations(owner: string, repo: string) {
      return githubRequest(token, `/repos/${owner}/${repo}/invitations`);
    },

    async deleteRepo(owner: string, repo: string) {
      await githubRequest(token, `/repos/${owner}/${repo}`, { method: "DELETE" });
    },

    // ✅ NUEVO: getRef / createRef
    async getRef(owner: string, repo: string, ref: string) {
      // ref ejemplo: "heads/main" o "heads/my-branch"
      return githubRequest(token, `/repos/${owner}/${repo}/git/ref/${encodeURIComponent(ref)}`);
    },

    async createRef(owner: string, repo: string, ref: string, sha: string) {
      // ref ejemplo: "refs/heads/my-branch"
      return githubRequest(token, `/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref, sha }),
      });
    },
  };
}

export async function exchangeCodeForToken(code: string, redirectUri?: string) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Faltan GITHUB_CLIENT_ID o GITHUB_CLIENT_SECRET");
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
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

  const digest = `sha256=${crypto.createHmac("sha256", secret).update(payloadBuffer).digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch (error) {
    console.error("[github:webhook] Error comparando firmas:", error);
    return false;
  }
}

export async function deleteGithubRepoForOwner(ownerEmail: string, repoFullName: string) {
  const { client } = await getOctokitForEmail(ownerEmail);

  const me = await client.getAuthenticatedUser();
  const [owner, repo] = repoFullName.split("/");

  const repoInfo = await client.getRepo(owner, repo);
  const hasAdmin = Boolean(repoInfo?.permissions?.admin);

  if (!hasAdmin) {
    throw new Error(`El token (${me.login}) no tiene admin sobre ${owner}/${repo}`);
  }

  await client.deleteRepo(owner, repo);
}
