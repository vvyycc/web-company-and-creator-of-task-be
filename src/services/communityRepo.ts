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
};

export type RepoMemberState = "NONE" | "INVITED" | "ACTIVE";

export type RepoMemberStatus = {
  joined: boolean;           // compatibilidad
  state: RepoMemberState;    // NUEVO
  repoFullName: string;
  repoUrl: string;
};

const GITHUB_PERMISSION_ERROR = "github_permissions_missing";

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

  const repoSuffix = projectId.slice(-6).toLowerCase();
  const repoNameBase = slugify(projectTitle, repoSuffix);
  const client = createGithubClient(ownerAccount.accessToken);

  let repoName = repoNameBase;
  try {
    await client.getRepo(ownerAccount.githubLogin, repoNameBase);
    repoName = `${repoNameBase}-${repoSuffix}`;
  } catch (error: any) {
    if (error?.status && error.status !== 404) {
      throw error;
    }
  }

  let createdRepo;
  try {
    createdRepo = await client.createRepo({
      name: repoName,
      description: projectDescription,
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
