import fs from "fs";
import path from "path";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { GithubAccount } from "../models/GithubAccount";
import { createGithubClient } from "./github";

export type ProjectRepoInfo = {
  name?: string;
  fullName: string;
  htmlUrl: string;
};

type RepoContext = {
  projectId: string;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  repoUrl: string;
  ownerEmail: string;
  ownerToken: string;

  // ✅ NUEVO: para decidir si un commit es del owner
  ownerGithubLogin: string;
};

export type RepoMemberState = "NONE" | "INVITED" | "ACTIVE";

export type RepoMemberStatus = {
  joined: boolean;           // compatibilidad
  state: RepoMemberState;    // NUEVO
  repoFullName: string;
  repoUrl: string;
};

const GITHUB_PERMISSION_ERROR = "github_permissions_missing";

// ================================
// ✅ Repo name constraints (GitHub)
// ================================
// - max 100 chars
// - allowed: letters, numbers, hyphens (recommended)
// - cannot start/end with hyphen
// - avoid consecutive hyphens
const MAX_REPO_NAME = 100;

function stripDiacritics(input: string) {
  return input.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function slugifyRepoName(input: string) {
  const base = stripDiacritics(String(input || ""))
    .toLowerCase()
    .trim()
    // separadores -> guiones
    .replace(/[\s._/\\]+/g, "-")
    // quita chars raros (incluye emojis)
    .replace(/[^a-z0-9-]+/g, "")
    // colapsa guiones
    .replace(/-+/g, "-")
    // quita guiones inicio/fin
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  return base;
}
function parseRepoFullName(repoFullName: string): { owner: string; repo: string } {
  const [owner, repo] = String(repoFullName || "").split("/");
  if (!owner || !repo) throw new Error("invalid_repo_full_name");
  return { owner, repo };
}

function isOwnerOrBotLogin(login: unknown, ownerLogin: string) {
  const l = String(login || "").toLowerCase();
  if (!l) return false;
  return l === String(ownerLogin || "").toLowerCase() || BOT_LOGINS.has(l);
}
function safeRepoNameFromTitle(params: {
  projectTitle: string;
  projectId?: string; // para unicidad
  prefix?: string; // opcional
}) {
  const { projectTitle, projectId, prefix } = params;

  const slug = slugifyRepoName(projectTitle);

  // sufijo corto para unicidad
  const shortId = projectId ? String(projectId).slice(-8).toLowerCase() : "";
  const suffix = shortId ? `-${shortId}` : "";

  const safePrefix = prefix ? `${slugifyRepoName(prefix)}-` : "";

  // recorta slug para que quepa: prefix + slug + suffix <= 100
  const maxSlugLen = MAX_REPO_NAME - safePrefix.length - suffix.length;
  const trimmedSlug = (slug || "community-project").slice(0, Math.max(1, maxSlugLen));

  let name = `${safePrefix}${trimmedSlug}${suffix}`;

  // limpieza final
  name = name.replace(/-+$/g, "").replace(/^-+/g, "");
  if (!name) name = "community-project";

  // garantía final <= 100
  if (name.length > MAX_REPO_NAME) {
    name = name.slice(0, MAX_REPO_NAME).replace(/-+$/g, "");
  }

  return name;
}

// ================================
// ✅ Bonus: descripción segura
// ================================
function sanitizeGithubDescription(input?: string): string {
  if (!input) return "";
  return input
    .replace(/[\r\n\t]/g, " ")   // fuera control chars
    .replace(/\s+/g, " ")        // colapsa espacios
    .trim()
    .slice(0, 200);              // ✅ (bonus) límite conservador
}

// (compat, pero ya NO se usa para repoName)
const slugify = (value: string, fallback: string) => {
  const base = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return base || `project-${fallback}`;
};

const buildReadmeContent = (title: string, description: string) => {
  const safeTitle = title?.trim() || "Proyecto";
  const safeDescription = description?.trim() || "";
  return `# ${safeTitle}\n\n${safeDescription}\n`;
};

const getVerifyWorkflowTemplate = () => {
  const templatePath = path.join(__dirname, "../../github/workflows/verify.yml");
  try {
    return fs.readFileSync(templatePath, "utf8");
  } catch (error) {
    console.warn("[community:repo] No se pudo leer plantilla verify.yml", error);
    return null;
  }
};

export const isGithubIntegrationPermissionError = (error: any) =>
  error?.status === 403 &&
  /Resource not accessible by integration/i.test(
    error?.message || error?.responseBody || ""
  );

async function getRepoContext(projectId: string): Promise<RepoContext> {
  await connectMongo();
  const project = await CommunityProject.findById(projectId).lean();
  if (!project) throw new Error("community_project_not_found");

  const repoFullName = project?.projectRepo?.fullName;
  const repoUrl = project?.projectRepo?.htmlUrl;

  if (!repoFullName || !repoUrl) {
    throw new Error("project_repo_missing");
  }

  const ownerAccount = await GithubAccount.findOne({ userEmail: project.ownerEmail }).lean();
  if (!ownerAccount) {
    throw new Error("github_not_connected_owner");
  }

  const [repoOwner, repoName] = repoFullName.split("/");
  if (!repoOwner || !repoName) {
    throw new Error("invalid_project_repo");
  }

  return {
    projectId: String(projectId),
    repoOwner,
    repoName,
    repoFullName,
    repoUrl,
    ownerEmail: project.ownerEmail,
    ownerToken: ownerAccount.accessToken,
    ownerGithubLogin: ownerAccount.githubLogin || "",
  };
}

export async function createProjectRepo(
  ownerEmail: string,
  projectId: string,
  projectTitle: string,
  projectDescription: string
): Promise<ProjectRepoInfo> {
  await connectMongo();
  const ownerAccount = await GithubAccount.findOne({ userEmail: ownerEmail }).lean();
  if (!ownerAccount) {
    throw new Error("github_not_connected_owner");
  }

  const client = createGithubClient(ownerAccount.accessToken);

  // ✅ Nombre seguro
  const repoNameBase = safeRepoNameFromTitle({
    projectTitle,
    projectId,
    prefix: "community", // opcional
  });

  let repoName = repoNameBase;

  // ✅ Si ya existe, añade sufijo extra (sin pasarte de 100)
  try {
    await client.getRepo(ownerAccount.githubLogin, repoNameBase);

    const extra = projectId.slice(-6).toLowerCase();
    const tentative = `${repoNameBase}-${extra}`;
    repoName =
      tentative.length <= MAX_REPO_NAME
        ? tentative
        : tentative.slice(0, MAX_REPO_NAME).replace(/-+$/g, "");
  } catch (error: any) {
    if (error?.status && error.status !== 404) {
      throw error;
    }
  }

  let createdRepo;
  try {
    const safeDescription = sanitizeGithubDescription(projectDescription);

    createdRepo = await client.createRepo({
      name: repoName,
      description: safeDescription,
      private: true,
      auto_init: true,
    });
  } catch (error: any) {
    if (isGithubIntegrationPermissionError(error)) {
      console.error(
        `[community:repo] No se pudo crear repo por permisos faltantes (Resource not accessible by integration): project=${projectId}`
      );
      const wrapped: any = new Error(GITHUB_PERMISSION_ERROR);
      wrapped.code = GITHUB_PERMISSION_ERROR;
      throw wrapped;
    }
    throw error;
  }

  const repoOwnerLogin = createdRepo?.owner?.login ?? ownerAccount.githubLogin;
  const readmeContent = buildReadmeContent(projectTitle, projectDescription);

  const workflowTemplate = getVerifyWorkflowTemplate();

  try {
    let sha: string | undefined;
    try {
      const existingReadme = await client.getContent(repoOwnerLogin, repoName, "README.md");
      sha = existingReadme?.sha;
    } catch (readmeError: any) {
      if (readmeError?.status && readmeError.status !== 404) throw readmeError;
    }

    await client.createOrUpdateFile(repoOwnerLogin, repoName, "README.md", {
      message: "Add project description",
      content: Buffer.from(readmeContent, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    });
  } catch (error) {
    console.warn(
      `[community:repo] No se pudo actualizar README para project=${projectId} repo=${repoName}:`,
      error
    );
  }

  console.log(
    `[community:repo] repo created project=${projectId} repo=${createdRepo?.full_name} owner=${ownerEmail}`
  );

  if (workflowTemplate) {
    try {
      await client.createOrUpdateFile(repoOwnerLogin, repoName, ".github/workflows/verify.yml", {
        message: "Add verify workflow",
        content: Buffer.from(workflowTemplate, "utf8").toString("base64"),
      });
      console.log(
        `[community:repo] verify workflow added project=${projectId} repo=${createdRepo?.full_name}`
      );
    } catch (error) {
      console.warn(
        `[community:repo] No se pudo agregar workflow verify.yml project=${projectId} repo=${createdRepo?.full_name}`,
        error
      );
    }
  }

  return {
    name: createdRepo?.name ?? repoName,
    fullName: createdRepo?.full_name ?? `${repoOwnerLogin}/${repoName}`,
    htmlUrl: createdRepo?.html_url,
  };
}

export async function dispatchVerifyWorkflow(
  projectId: string,
  params: { taskId: string; branch: string; checklistKeys?: string[]; workflowNameOrId?: string }
): Promise<boolean> {
  const context = await getRepoContext(projectId);
  const client = createGithubClient(context.ownerToken);
  const { repoOwner, repoName } = context;

  try {
    const workflows = await client.listWorkflows(repoOwner, repoName);
    const workflow = workflows?.workflows?.find((w: any) => {
      const path = String(w?.path || "");
      const name = String(w?.name || "");
      const matchName = params.workflowNameOrId
        ? String(params.workflowNameOrId).toLowerCase()
        : "verify";
      return path.toLowerCase().endsWith("verify.yml") || name.toLowerCase() === matchName;
    });

    const workflowId = params.workflowNameOrId || workflow?.id || workflow?.path || "verify.yml";
    const ref = params.branch;

    await client.dispatchWorkflow(repoOwner, repoName, workflowId, ref, {
      projectId,
      taskId: params.taskId,
      branch: params.branch,
      checklistKeys: params.checklistKeys,
    });

    console.log(
      `[community:verify] dispatched project=${projectId} task=${params.taskId} repo=${repoOwner}/${repoName} workflow=${workflowId} ref=${ref}`
    );
    return true;
  } catch (error) {
    console.warn(
      `[community:verify] No se pudo disparar workflow project=${projectId} task=${params.taskId}:`,
      error
    );
    return false;
  }
}

async function checkRepoMembership(projectId: string, userEmail: string): Promise<RepoMemberStatus> {
  const context = await getRepoContext(projectId);
  const userAccount = await GithubAccount.findOne({ userEmail }).lean();

  // No tiene cuenta github conectada => no puede aceptar ni colaborar
  if (!userAccount) {
    return { joined: false, state: "NONE", repoFullName: context.repoFullName, repoUrl: context.repoUrl };
  }

  const client = createGithubClient(context.ownerToken);

  try {
    // 1) ¿Ya es collaborator REAL? => ACTIVE
    const isMember = await client.isCollaborator(
      context.repoOwner,
      context.repoName,
      userAccount.githubLogin
    );

    if (isMember) {
      console.log(
        `[community:repo] member check ACTIVE project=${projectId} user=${userEmail} login=${userAccount.githubLogin}`
      );
      return { joined: true, state: "ACTIVE", repoFullName: context.repoFullName, repoUrl: context.repoUrl };
    }

    // 2) Si NO es collaborator, miramos invitaciones pendientes => INVITED
    let invitations: any[] = [];
    try {
      invitations =
        (await client.listInvitations(context.repoOwner, context.repoName))?.filter(Boolean) || [];
    } catch (error: any) {
      if (isGithubIntegrationPermissionError(error)) {
        const wrapped: any = new Error(GITHUB_PERMISSION_ERROR);
        wrapped.code = GITHUB_PERMISSION_ERROR;
        throw wrapped;
      }
      throw error;
    }

    const hasInvite = invitations.some(
      (inv: any) =>
        String(inv?.invitee?.login || "").toLowerCase() ===
        String(userAccount.githubLogin).toLowerCase()
    );

    if (hasInvite) {
      console.log(
        `[community:repo] member check INVITED project=${projectId} user=${userEmail} login=${userAccount.githubLogin}`
      );

      // OJO: joined=true solo por compatibilidad, pero state=INVITED
      return { joined: true, state: "INVITED", repoFullName: context.repoFullName, repoUrl: context.repoUrl };
    }

    console.warn(
      `[community:repo] member check NONE project=${projectId} user=${userEmail} login=${userAccount.githubLogin}`
    );

    return { joined: false, state: "NONE", repoFullName: context.repoFullName, repoUrl: context.repoUrl };
  } catch (error: any) {
    if (isGithubIntegrationPermissionError(error)) {
      const wrapped: any = new Error(GITHUB_PERMISSION_ERROR);
      wrapped.code = GITHUB_PERMISSION_ERROR;
      throw wrapped;
    }
    throw error;
  }
}

export async function ensureRepoMember(projectId: string, userEmail: string) {
  return checkRepoMembership(projectId, userEmail);
}

export async function inviteUserToRepo(projectId: string, userEmail: string) {
  const context = await getRepoContext(projectId);
  const userAccount = await GithubAccount.findOne({ userEmail }).lean();

  if (!userAccount) {
    throw new Error("github_account_not_found");
  }

  const membership = await checkRepoMembership(projectId, userEmail);
  if (membership.joined) {
    return membership;
  }

  const client = createGithubClient(context.ownerToken);

  try {
    await client.inviteCollaborator(context.repoOwner, context.repoName, userAccount.githubLogin);
  } catch (error: any) {
    if (isGithubIntegrationPermissionError(error)) {
      console.error(
        `[community:repo] No se pudo invitar por permisos faltantes (Resource not accessible by integration): project=${projectId}, user=${userEmail}`
      );
      const wrapped: any = new Error(GITHUB_PERMISSION_ERROR);
      wrapped.code = GITHUB_PERMISSION_ERROR;
      throw wrapped;
    }
    throw error;
  }

  console.log(
    `[community:repo] invite sent project=${projectId} user=${userEmail} login=${userAccount.githubLogin}`
  );

  return {
    joined: true,
    state: "INVITED",
    repoFullName: context.repoFullName,
    repoUrl: context.repoUrl,
  };
}

// =====================================================
// ✅ NUEVO: Cleanup de rama al volver doing -> todo
// =====================================================
// Regla:
// - Si no hay commits ahead del base -> borrar rama
// - Si hay commits y TODOS son owner o bots -> borrar rama
// - Si hay commits de otro usuario -> NO borrar
const BOT_LOGINS = new Set<string>([
  "github-actions[bot]",
  "github-actions",
  "dependabot[bot]",
]);

export async function cleanupTaskBranchOnBackToTodo(params: {
  projectId: string;
  taskBranch: string;
  baseBranch?: string;
}): Promise<{ deleted: boolean; reason: string }> {
  const context = await getRepoContext(params.projectId);
  const client: any = createGithubClient(context.ownerToken);

  const repoOwner = context.repoOwner;
  const repoName = context.repoName;

  const branch = String(params.taskBranch || "").trim();
  if (!branch) return { deleted: false, reason: "no_branch" };

  // 1) base branch
    // Nunca borrar la rama default
  let defaultBranch = "main";
  try {
    const repo = await client.getRepo(repoOwner, repoName);
    defaultBranch = repo?.default_branch || "main";
  } catch {}

  if (branch === defaultBranch) return { deleted: false, reason: "branch_is_base" };

  // 2) si la rama no existe, no hacemos nada
  try {
    // wrapper debería tener getRef; si no, esto puede fallar
    await client.getRef?.(repoOwner, repoName, `heads/${branch}`);
  } catch (e: any) {
    if (e?.status === 404) return { deleted: false, reason: "branch_not_found" };
    // si no existe getRef, seguimos (pero en ese caso deleteRef también puede faltar)
  }

  // 3) comparar base...branch
 try {
    await client.getRef?.(repoOwner, repoName, `heads/${branch}`);
  } catch (e: any) {
    if (e?.status === 404) return { deleted: false, reason: "branch_not_found" };
    // si falla por otro motivo, no rompemos
    return { deleted: false, reason: "cannot_get_ref" };
  }

  const ownerLogin = String(context.ownerGithubLogin || "").toLowerCase();
  const isOwnerOrBot = (login?: string | null) => {
    const l = String(login || "").toLowerCase();
    if (!l) return false;
    return l === ownerLogin || BOT_LOGINS.has(l);
  };

  // 2) Listar commits del branch (últimos 30)
  let commits: any[] = [];
  try {
    const list = await client.listCommits?.(repoOwner, repoName, { sha: branch, per_page: 30 });
    commits = Array.isArray(list) ? list : Array.isArray(list?.data) ? list.data : [];
  } catch {
    // si no podemos listar commits, no borramos por seguridad
    return { deleted: false, reason: "cannot_list_commits" };
  }

  // Caso: branch recién creada pero sin commits “útiles”
  if (!commits.length) {
    try {
      await client.deleteRef?.(repoOwner, repoName, `heads/${branch}`);
      return { deleted: true, reason: "no_commits" };
    } catch {
      return { deleted: false, reason: "delete_ref_not_available" };
    }
  }

  // 3) Si hay algún commit de otro user -> NO borrar
  const hasNonOwnerCommit = commits.some((c: any) => {
    const authorLogin = c?.author?.login ?? null;
    const committerLogin = c?.committer?.login ?? null;

    // Si ninguno es owner/bot -> otro user
    const ok = isOwnerOrBot(authorLogin) || isOwnerOrBot(committerLogin);
    return !ok;
  });

  if (hasNonOwnerCommit) {
    return { deleted: false, reason: "has_commits_by_non_owner" };
  }

  // 4) Solo owner/bots -> borrar
  try {
    await client.deleteRef?.(repoOwner, repoName, `heads/${branch}`);
    return { deleted: true, reason: "only_owner_or_bots_commits" };
  } catch {
    return { deleted: false, reason: "delete_ref_not_available" };
  }

 

}
 export async function safeDeleteBranchIfNoCommits(
  ownerEmail: string,              // owner del proyecto (para token)
  repoFullName: string,            // "owner/repo"
  branch: string                   // "task-xxx"
): Promise<{ deleted: boolean; reason: string }> {
  const { owner, repo } = parseRepoFullName(repoFullName);
  const b = String(branch || "").trim();
  if (!b) return { deleted: false, reason: "no_branch" };

  await connectMongo();
  const ownerAccount = await GithubAccount.findOne({ userEmail: ownerEmail }).lean();
  if (!ownerAccount?.accessToken) return { deleted: false, reason: "github_not_connected_owner" };

  const client: any = createGithubClient(ownerAccount.accessToken);

  // 0) repo info + default branch
  let defaultBranch = "main";
  try {
    const repoInfo = await client.getRepo(owner, repo);
    defaultBranch = repoInfo?.default_branch || "main";
  } catch {
    // si no podemos leer repo, no borramos por seguridad
    return { deleted: false, reason: "cannot_get_repo" };
  }

  if (b === defaultBranch) return { deleted: false, reason: "branch_is_default" };

  // 1) si el ref no existe, no hacemos nada
  try {
    await client.getRef(owner, repo, `heads/${b}`);
  } catch (e: any) {
    if (e?.status === 404) return { deleted: false, reason: "branch_not_found" };
    return { deleted: false, reason: "cannot_get_branch_ref" };
  }

  // 2) obtener HEAD commit sha del branch y del default (con listCommits per_page=1)
  const normalizeList = (raw: any) => (Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : []);

  let branchCommits: any[] = [];
  let defaultCommits: any[] = [];

  try {
    branchCommits = normalizeList(await client.listCommits(owner, repo, { sha: b, per_page: 1 }));
    defaultCommits = normalizeList(await client.listCommits(owner, repo, { sha: defaultBranch, per_page: 1 }));
  } catch {
    return { deleted: false, reason: "cannot_list_commits" };
  }

  const branchHeadSha = branchCommits?.[0]?.sha ? String(branchCommits[0].sha) : "";
  const defaultHeadSha = defaultCommits?.[0]?.sha ? String(defaultCommits[0].sha) : "";

  if (!branchHeadSha || !defaultHeadSha) {
    return { deleted: false, reason: "missing_head_sha" };
  }

  // ✅ Regla 1 (real “sin cambios”): si HEAD del branch == HEAD del default => no hay commits propios
  const hasOwnChanges = branchHeadSha !== defaultHeadSha;

  // ✅ Regla 2 (tu regla): si hay cambios, solo borramos si NO hay commits de no-owner
  // (en este caso necesitamos mirar algunos commits del branch)
  if (hasOwnChanges) {
    // miramos últimos 20 para detectar autor no-owner (suficiente en la práctica)
    let recent: any[] = [];
    try {
      recent = normalizeList(await client.listCommits(owner, repo, { sha: b, per_page: 20 }));
    } catch {
      return { deleted: false, reason: "cannot_list_recent_commits" };
    }

    const ownerLogin = String(ownerAccount.githubLogin || "").toLowerCase();

    const hasNonOwnerCommit = recent.some((c: any) => {
      const authorLogin = c?.author?.login ?? null;
      const committerLogin = c?.committer?.login ?? null;

      const ok =
        isOwnerOrBotLogin(authorLogin, ownerLogin) ||
        isOwnerOrBotLogin(committerLogin, ownerLogin);

      return !ok;
    });

    if (hasNonOwnerCommit) {
      // ✅ si hay commits de otro usuario -> rama debe permanecer
      return { deleted: false, reason: "has_non_owner_commits" };
    }

    // si solo hay commits del owner/bots, sí puedes borrarla según tu regla
  }

  // 3) borrar ref
  try {
    await client.deleteRef(owner, repo, `heads/${b}`);
    return { deleted: true, reason: hasOwnChanges ? "deleted_owner_or_bot_only" : "deleted_no_changes" };
  } catch (e: any) {
    if (e?.status === 404) return { deleted: false, reason: "ref_already_deleted" };
    return { deleted: false, reason: "delete_failed" };
  }
}
