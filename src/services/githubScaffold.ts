import { getOctokitForEmail } from "./github";

export type RepoScaffoldFile = { path: string; content: string; message?: string };

export async function createRepoIfMissing(ownerEmail: string, repoName: string) {
  const { client } = await getOctokitForEmail(ownerEmail);
  const user = await client.getAuthenticatedUser();

  try {
    const existing = await client.getRepo(user.login, repoName);
    return {
      fullName: existing.full_name,
      url: existing.html_url,
      defaultBranch: existing.default_branch,
      name: existing.name,
    };
  } catch (error: any) {
    if (error?.status !== 404) throw error;
  }

  const created = await client.createRepo({
    name: repoName,
    private: true,
    auto_init: true,
  });

  return {
    fullName: created.full_name,
    url: created.html_url,
    defaultBranch: created.default_branch || "main",
    name: created.name,
  };
}

export async function commitManyFiles(
  repoFullName: string,
  branch: string,
  files: RepoScaffoldFile[],
  ownerEmail: string
) {
  const [owner, repo] = repoFullName.split("/");
  const { client } = await getOctokitForEmail(ownerEmail);

  for (const file of files) {
    const path = file.path.replace(/^\//, "");
    let sha: string | undefined;
    try {
      const existing = await client.getContent(owner, repo, `${path}?ref=${branch}`);
      sha = existing?.sha;
    } catch (error: any) {
      if (error?.status && error.status !== 404) throw error;
    }

    await client.createOrUpdateFile(owner, repo, path, {
      message: file.message || `chore: scaffold ${path}`,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    });
  }
}

const frontendWorkflow = `name: ci
on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run lint --if-present
      - run: npm run test --if-present
`;

const backendWorkflow = frontendWorkflow;
const hardhatWorkflow = frontendWorkflow;

export async function scaffoldFrontend(repoFullName: string, ownerEmail: string, branch = "main") {
  const files: RepoScaffoldFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "frontend", scripts: { dev: "next dev", test: "npm run lint || true" } }, null, 2) },
    { path: "README.md", content: "# Community Frontend\\n" },
    { path: ".github/workflows/ci.yml", content: frontendWorkflow },
  ];
  await commitManyFiles(repoFullName, branch, files, ownerEmail);
}

export async function scaffoldBackend(repoFullName: string, ownerEmail: string, branch = "main") {
  const files: RepoScaffoldFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "backend", scripts: { dev: "ts-node src/index.ts", test: "vitest" } }, null, 2) },
    { path: "README.md", content: "# Community Backend\\n" },
    { path: ".github/workflows/ci.yml", content: backendWorkflow },
  ];
  await commitManyFiles(repoFullName, branch, files, ownerEmail);
}

export async function scaffoldHardhat(repoFullName: string, ownerEmail: string, branch = "main") {
  const files: RepoScaffoldFile[] = [
    { path: "package.json", content: JSON.stringify({ name: "hardhat", scripts: { test: "hardhat test" } }, null, 2) },
    { path: "README.md", content: "# Community Hardhat\\n" },
    { path: ".github/workflows/ci.yml", content: hardhatWorkflow },
  ];
  await commitManyFiles(repoFullName, branch, files, ownerEmail);
}
