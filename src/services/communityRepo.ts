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

export type ProjectRepoType = "mono" | "backend" | "frontend" | "contracts";

type RepoContext = {
  projectId: string;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  repoUrl: string;
  ownerEmail: string;
  ownerToken: string;
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

function buildRepoNameForType(baseName: string, projectId: string, type: ProjectRepoType) {
  const repoNameBase = safeRepoNameFromTitle({
    projectTitle: baseName,
    projectId,
    prefix: "community",
  });

  if (type === "mono") return repoNameBase;

  const suffix = type === "backend" ? "-backend" : type === "frontend" ? "-frontend" : "-contracts";
  const maxBaseLength = MAX_REPO_NAME - suffix.length;
  const trimmedBase = repoNameBase.slice(0, Math.max(1, maxBaseLength)).replace(/-+$/g, "");

  return `${trimmedBase}${suffix}`;
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

// (lo dejo por compatibilidad, pero ya NO se usa para repoName)
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

  const repoFromProject: any = (project as any)?.projectRepo;
  const repoFullName = repoFromProject?.fullName;
  const repoUrl = repoFromProject?.htmlUrl;
  const repoFromList: any =
    Array.isArray((project as any)?.projectRepos) && (project as any).projectRepos.length
      ? (project as any).projectRepos[0]
      : null;

  const finalRepoFullName =
    repoFullName ||
    repoFromProject?.repoFullName ||
    (typeof repoFromProject === "string" ? repoFromProject : undefined) ||
    repoFromList?.fullName ||
    repoFromList?.repoFullName;

  const finalRepoUrl = repoUrl || repoFromList?.htmlUrl || repoFromList?.repoUrl;

  if (!finalRepoFullName || !finalRepoUrl) {
    throw new Error("project_repo_missing");
  }

  const ownerAccount = await GithubAccount.findOne({ userEmail: project.ownerEmail }).lean();
  if (!ownerAccount) {
    throw new Error("github_not_connected_owner");
  }

  const [repoOwner, repoName] = finalRepoFullName.split("/");
  if (!repoOwner || !repoName) {
    throw new Error("invalid_project_repo");
  }

  return {
    projectId: String(projectId),
    repoOwner,
    repoName,
    repoFullName: finalRepoFullName,
    repoUrl: finalRepoUrl,
    ownerEmail: project.ownerEmail,
    ownerToken: ownerAccount.accessToken,
  };
}

async function createRepoWithName(
  ownerAccount: any,
  repoNameBase: string,
  projectId: string,
  projectTitle: string,
  projectDescription: string
): Promise<ProjectRepoInfo> {
  const client = createGithubClient(ownerAccount.accessToken);
  let repoName = repoNameBase;

  // ✅ Si ya existe un repo con ese nombre, añade sufijo extra corto (y vuelve a limitar a 100)
  try {
    await client.getRepo(ownerAccount.githubLogin, repoNameBase);

    const extra = projectId.slice(-6).toLowerCase();
    // añade un segundo sufijo, recortando para no pasarse
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
    `[community:repo] repo created project=${projectId} repo=${createdRepo?.full_name} owner=${ownerAccount?.userEmail}`
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

export async function createProjectRepo(
  ownerEmail: string,
  projectId: string,
  projectTitle: string,
  projectDescription: string
): Promise<ProjectRepoInfo> {
  return createProjectRepoForType(ownerEmail, projectId, projectTitle, projectDescription, "mono");
}

export async function createProjectRepoForType(
  ownerEmail: string,
  projectId: string,
  baseName: string,
  projectDescription: string,
  type: ProjectRepoType
): Promise<ProjectRepoInfo> {
  await connectMongo();
  const ownerAccount = await GithubAccount.findOne({ userEmail: ownerEmail }).lean();
  if (!ownerAccount) {
    throw new Error("github_not_connected_owner");
  }

  const repoNameBase = buildRepoNameForType(baseName, projectId, type);
  return createRepoWithName(ownerAccount, repoNameBase, projectId, baseName, projectDescription);
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
