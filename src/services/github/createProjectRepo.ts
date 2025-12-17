import { ProjectRepo } from "../../models/CommunityProject";
import { getOctokitForEmail } from "../github";

const GITHUB_API_BASE = "https://api.github.com";

type CreateProjectRepoResult = {
  repo: ProjectRepo;
  githubUsername: string;
};

export async function createProjectRepo(
  ownerEmail: string,
  projectId: string
): Promise<CreateProjectRepoResult> {
  const { account, client } = await getOctokitForEmail(ownerEmail);

  const repoName = `community-${projectId}`;
  const res = await fetch(`${GITHUB_API_BASE}/user/repos`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${client.token}`,
      "User-Agent": "community-verifier/1.0",
    },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: true,
      description: "Community project repository",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `github_create_repo_failed:${res.status}:${errorText || res.statusText}`
    );
  }

  const data = await res.json();

  const repo: ProjectRepo = {
    provider: "github",
    repoId: data.id,
    owner: data.owner?.login || account.githubLogin,
    repoName: data.name,
    fullName: data.full_name,
    htmlUrl: data.html_url,
    private: Boolean(data.private),
    createdAt: new Date(data.created_at),
  };

  return { repo, githubUsername: account.githubLogin };
}
