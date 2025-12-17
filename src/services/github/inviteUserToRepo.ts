import { ProjectRepo } from "../../models/CommunityProject";
import { getOctokitForEmail } from "../github";

const GITHUB_API_BASE = "https://api.github.com";

export async function inviteUserToRepo(
  projectRepo: ProjectRepo,
  ownerEmail: string,
  githubUsername: string
): Promise<void> {
  const { client } = await getOctokitForEmail(ownerEmail);

  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${projectRepo.owner}/${projectRepo.repoName}/collaborators/${githubUsername}`,
    {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${client.token}`,
        "User-Agent": "community-verifier/1.0",
      },
      body: JSON.stringify({ permission: "push" }),
    }
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(
      `github_invite_failed:${res.status}:${errorText || res.statusText}`
    );
  }
}
