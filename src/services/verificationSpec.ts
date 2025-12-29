import path from "path";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import { ProjectStack, normalizeProjectStack, DEFAULT_PROJECT_STACK } from "../models/stack";
import type { ChecklistItem, ChecklistStatus } from "../routes/community";
import { getOctokitForEmail } from "./github";
import { getStackAdapter, AdapterCommands } from "./stackAdapters";

export type VerificationExpectationType =
  | "http"
  | "contract"
  | "cli"
  | "ui"
  | "file"
  | "db"
  | "security"
  | "unknown";

export type VerificationExpectation = {
  key: string;
  title: string;
  description?: string;
  type: VerificationExpectationType;
  target?: string;
  successCriteria?: string[];
  artifacts?: Array<{ path: string; mustExist?: boolean; contains?: string[] }>;
};

export type VerificationSpec = {
  taskId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  stack: ProjectStack;
  version: string;
  generatedAt: string;
  expectations: VerificationExpectation[];
};

export type GeneratedTestFile = { path: string; content: string };

const SPEC_DIR = ".community/verification";

const stripDiacritics = (input: string) =>
  input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "");

export const slugify = (input: string, fallback = "task") => {
  const slug = stripDiacritics(String(input || ""))
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || fallback;
};

export const buildTaskBranchName = (task: { id: string; title?: string }) => {
  const branchSlug = slugify(task.title || `task-${task.id}`);
  return `task/${task.id}-${branchSlug}`;
};

function inferExpectationType(text: string): VerificationExpectationType {
  const t = text.toLowerCase();
  if (t.includes("http") || t.includes("api") || t.includes("endpoint") || t.includes("rest")) {
    return "http";
  }
  if (t.includes("contract") || t.includes("solidity")) return "contract";
  if (t.includes("cli") || t.includes("command")) return "cli";
  if (t.includes("ui") || t.includes("screen") || t.includes("page")) return "ui";
  if (t.includes("db") || t.includes("database")) return "db";
  if (t.includes("security") || t.includes("auth") || t.includes("permission")) return "security";
  return "file";
}

function extractExpectationLines(acceptance?: string, description?: string) {
  const acc = String(acceptance || "").trim();
  if (acc) {
    const lines = acc
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-") || l.startsWith("*"))
      .map((l) => l.replace(/^[-*]\s*/, ""))
      .filter(Boolean);
    if (lines.length) return lines;
  }

  const desc = String(description || "").trim();
  if (!desc) return [];

  return desc
    .split(/[.;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 6);
}

export const generateVerificationSpec = (
  task: {
    id: string;
    title?: string;
    description?: string;
    acceptanceCriteria?: string;
  },
  projectStack?: ProjectStack | null
): VerificationSpec => {
  const lines = extractExpectationLines(task.acceptanceCriteria, task.description);
  const expectations: VerificationExpectation[] = lines.map((text, index) => {
    const key = `${slugify(text || `item-${index}`, "item")}-${index}`;
    return {
      key,
      title: text || `Expectation ${index + 1}`,
      description: text,
      type: inferExpectationType(text),
      successCriteria: [
        "Define objective validation for this expectation.",
        "Add implementation that satisfies the acceptance criteria.",
      ],
    };
  });

  if (!expectations.length) {
    expectations.push({
      key: `${slugify(task.title || "expectation")}-0`,
      title: task.title || "Expectation",
      description: task.description || "Validate the delivered changes.",
      type: "file",
      successCriteria: ["Verify deliverable matches task description."],
    });
  }

  const stack = normalizeProjectStack(projectStack);

  return {
    taskId: task.id,
    title: task.title || "Task",
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    stack,
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    expectations,
  };
};

export const buildChecklistFromSpec = (spec: VerificationSpec, existing?: ChecklistItem[]) => {
  const currentMap = new Map<string, ChecklistItem>();
  (existing || []).forEach((item) => currentMap.set(item.key, item));

  return spec.expectations.map((expectation, index) => {
    const prev = currentMap.get(expectation.key);
    const status: ChecklistStatus =
      prev && ["PENDING", "PASSED", "FAILED"].includes(prev.status) ? prev.status : "PENDING";
    return {
      key: expectation.key || `${slugify(expectation.title, "item")}-${index}`,
      text: expectation.title || expectation.description || expectation.key,
      status,
      details: expectation.description,
    };
  });
};

async function resolveOwnerEmailByRepo(repoFullName: string) {
  await connectMongo();
  const project = await CommunityProject.findOne({
    $or: [{ "projectRepo.fullName": repoFullName }, { "projectRepo.repoFullName": repoFullName }],
  }).lean();

  return project?.ownerEmail || null;
}

export const commitFileToBranch = async (
  repoFullName: string,
  branch: string,
  filePath: string,
  content: string,
  message: string,
  actorEmail?: string
) => {
  const [owner, repo] = String(repoFullName).split("/");
  if (!owner || !repo) throw new Error("invalid_repo_full_name");

  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!email) throw new Error("repo_owner_email_not_found");

  const { client } = await getOctokitForEmail(email);

  let sha: string | undefined;
  try {
    const existing = await client.getContent(owner, repo, `${filePath}?ref=${branch}`);
    const existingContent = Buffer.from(existing.content || "", "base64").toString("utf8");
    if (existingContent.trim() === content.trim()) {
      return { updated: false, sha: existing.sha };
    }
    sha = existing.sha;
  } catch (error: any) {
    if (error?.status && error.status !== 404) throw error;
  }

  await client.createOrUpdateFile(owner, repo, filePath, {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    ...(sha ? { sha } : {}),
    branch,
  });

  return { updated: true };
};

export const fetchVerificationSpec = async (
  repoFullName: string,
  branch: string,
  taskId: string,
  actorEmail?: string
): Promise<VerificationSpec | null> => {
  const [owner, repo] = String(repoFullName).split("/");
  if (!owner || !repo) throw new Error("invalid_repo_full_name");

  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!email) throw new Error("repo_owner_email_not_found");

  const { client } = await getOctokitForEmail(email);
  const filePath = path.posix.join(SPEC_DIR, `task-${taskId}.json`);
  try {
    const existing = await client.getContent(owner, repo, `${filePath}?ref=${branch}`);
    const raw = Buffer.from(existing.content || "", "base64").toString("utf8");
    return JSON.parse(raw);
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
};

export const detectRepoStack = async (
  repoFullName: string,
  branch: string,
  actorEmail?: string
): Promise<ProjectStack> => {
  const [owner, repo] = String(repoFullName).split("/");
  if (!owner || !repo) return DEFAULT_PROJECT_STACK;

  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!email) return DEFAULT_PROJECT_STACK;

  const { client } = await getOctokitForEmail(email);

  try {
    const ref = branch.startsWith("heads/") || branch.startsWith("refs/") ? branch : `heads/${branch}`;
    const tree = await client.getTree(owner, repo, ref);
    const paths: string[] =
      (tree?.tree || []).map((item: any) => String(item?.path || "").toLowerCase()) || [];

    const includes = (filename: string) =>
      paths.some((p) => p === filename.toLowerCase() || p.endsWith(`/${filename.toLowerCase()}`));

    if (includes("package.json")) return { ...DEFAULT_PROJECT_STACK, primary: "node" };
    if (includes("foundry.toml")) return { primary: "solidity", testRunner: "foundry", packageManager: "npm" };
    if (paths.some((p) => p.includes("hardhat.config"))) return { primary: "solidity", testRunner: "hardhat", packageManager: "npm" };
    if (includes("pom.xml")) return { primary: "java", testRunner: "maven" };
    if (includes("build.gradle") || includes("build.gradle.kts")) return { primary: "java", testRunner: "gradle" };
    if (includes("composer.json")) return { primary: "php", testRunner: "phpunit" };
    if (includes("playwright.config.ts") || includes("playwright.config.js")) return { primary: "react", testRunner: "playwright" };

    return DEFAULT_PROJECT_STACK;
  } catch (error) {
    console.warn("[verification] Stack detection failed:", error);
    return DEFAULT_PROJECT_STACK;
  }
};

const workflowForStack = (stack: ProjectStack, commands?: AdapterCommands) => {
  const installCmd = (commands?.install || "").replace(/\n+/g, "\n").trim();
  const testCmd = (commands?.test || "").replace(/\n+/g, "\n").trim();

  return `name: community-verify

on:
  push:
    branches:
      - 'task/**'
      - 'community/**'
  pull_request:
    branches: [ main, master ]
    paths:
      - '.community/verification/**'
      - 'verification/**'
      - 'tests/**'
      - '**/*.spec.*'
  workflow_dispatch:
    inputs:
      projectId:
        description: "Community project id"
        required: true
      taskId:
        description: "Task id"
        required: true
      branch:
        description: "Task branch to verify"
        required: true

jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      VERIFY_PRIMARY: ${stack.primary}
      VERIFY_TEST_RUNNER: ${stack.testRunner || ""}
      VERIFY_PACKAGE_MANAGER: ${stack.packageManager || ""}
      VERIFY_INSTALL_COMMAND: "${installCmd}"
      VERIFY_TEST_COMMAND: "${testCmd}"
    steps:
      - name: Checkout task branch
        uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch || github.ref_name }}

      - name: Locate verification spec
        id: spec
        run: |
          mkdir -p .community/verification
          FILE=$(ls .community/verification/task-*.json 2>/dev/null | head -n 1 || true)
          if [ -z "$FILE" ]; then
            echo "No verification spec found" >&2
            exit 1
          fi
          echo "file=$FILE" >> "$GITHUB_OUTPUT"
          SPEC_FILE="$FILE" node -e "const fs=require('fs'); const f=process.env.SPEC_FILE; const d=JSON.parse(fs.readFileSync(f,'utf8')); const out=fs.createWriteStream(process.env.GITHUB_OUTPUT,{flags:'a'}); out.write('primary='+ (d.stack?.primary||'unknown')+'\\n'); out.write('runner='+ (d.stack?.testRunner||'')+'\\n'); out.write('pm='+ (d.stack?.packageManager||'')+'\\n');"

      - name: Setup Node
        if: startsWith(steps.spec.outputs.primary, 'node') || steps.spec.outputs.primary == 'nextjs' || steps.spec.outputs.primary == 'react' || steps.spec.outputs.primary == 'vue' || steps.spec.outputs.primary == 'angular' || steps.spec.outputs.primary == 'solidity'
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Setup Python
        if: steps.spec.outputs.primary == 'python'
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Setup Java
        if: steps.spec.outputs.primary == 'java'
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '17'

      - name: Setup PHP
        if: steps.spec.outputs.primary == 'php'
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.2'

      - name: Install dependencies
        run: |
          if [ -n "$VERIFY_INSTALL_COMMAND" ]; then
            eval "$VERIFY_INSTALL_COMMAND"
            exit $?
          fi
          PM="\${STACK_PM:-$VERIFY_PACKAGE_MANAGER}"
          if [ "$PM" = "pnpm" ]; then npm install -g pnpm && pnpm install; elif [ "$PM" = "yarn" ]; then yarn install --frozen-lockfile || yarn install; elif [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; elif [ -f requirements.txt ]; then pip install -r requirements.txt; elif [ -f pom.xml ]; then mvn -B -ntp dependency:resolve; elif [ -f composer.json ]; then composer install --no-interaction --no-progress; else echo "No dependency manifest found"; fi
        env:
          STACK_PM: \${{ steps.spec.outputs.pm }}

      - name: Run verification tests
        run: |
          if [ -n "$VERIFY_TEST_COMMAND" ]; then
            eval "$VERIFY_TEST_COMMAND"
            exit $?
          fi
          PRIMARY="\${STACK_PRIMARY}"
          if [ "$PRIMARY" = "python" ]; then pytest -q || pytest; elif [ "$PRIMARY" = "java" ]; then mvn -B -ntp test; elif [ "$PRIMARY" = "php" ]; then vendor/bin/phpunit || phpunit; elif [ "$PRIMARY" = "solidity" ]; then npx hardhat test || npm test -- --runInBand; else node --test verification/**/*.spec.js verification/**/*.spec.ts || npm test -- --runInBand || npm run test; fi
        env:
          STACK_PRIMARY: \${{ steps.spec.outputs.primary }}

      - name: Upload verification artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: community-verification-results
          path: |
            verification/**
            .community/verification/**
`;
};

export const ensureWorkflowExists = async (
  stack: ProjectStack,
  repoFullName: string,
  branch: string,
  commands?: AdapterCommands,
  actorEmail?: string
) => {
  const workflowPath = ".github/workflows/community-verify.yml";
  const content = workflowForStack(stack, commands);
  return commitFileToBranch(
    repoFullName,
    branch,
    workflowPath,
    content,
    "chore: ensure community verification workflow",
    actorEmail
  );
};

export const ensureVerificationFilesInBranch = async (
  repoFullName: string,
  branch: string,
  spec: VerificationSpec,
  actorEmail?: string
) => {
  const normalizedSpec = { ...spec, stack: normalizeProjectStack(spec.stack) };
  const adapter = getStackAdapter(normalizedSpec.stack);
  const adapterResult = adapter.generate(normalizedSpec);

  const filePath = path.posix.join(SPEC_DIR, `task-${spec.taskId}.json`);
  await commitFileToBranch(
    repoFullName,
    branch,
    filePath,
    JSON.stringify(normalizedSpec, null, 2),
    `chore: add verification spec for task ${spec.taskId}`,
    actorEmail
  );

  for (const file of adapterResult.files) {
    await commitFileToBranch(
      repoFullName,
      branch,
      file.path,
      file.content,
      `test: add verification for task ${spec.taskId}`,
      actorEmail
    );
  }

  await ensureWorkflowExists(normalizedSpec.stack, repoFullName, branch, adapterResult.commands, actorEmail);

  return {
    adapter: adapter.id,
    filesGenerated: adapterResult.files.map((f) => f.path),
  };
};

export const triggerWorkflow = async (
  repoFullName: string,
  branch: string,
  payload: { projectId: string; taskId: string },
  actorEmail?: string
) => {
  const [owner, repo] = String(repoFullName).split("/");
  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!owner || !repo || !email) throw new Error("invalid_repo_context");

  const { client } = await getOctokitForEmail(email);
  await client.dispatchWorkflow(owner, repo, "community-verify.yml", branch, {
    projectId: payload.projectId,
    taskId: payload.taskId,
    branch,
  });
};

export const pollOrFetchLatestRun = async (
  repoFullName: string,
  branch: string,
  actorEmail?: string
): Promise<{ conclusion: string | null; url?: string }> => {
  const [owner, repo] = String(repoFullName).split("/");
  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!owner || !repo || !email) throw new Error("invalid_repo_context");

  const { client } = await getOctokitForEmail(email);
  try {
    const runs = await client.listWorkflowRuns(owner, repo, { branch, workflowId: "community-verify.yml", per_page: 5 });
    const run =
      runs?.workflow_runs?.find((r: any) => String(r.head_branch) === branch) ||
      runs?.workflow_runs?.[0];

    return { conclusion: run?.conclusion ?? null, url: run?.html_url };
  } catch (error) {
    console.warn("[verification] Cannot fetch workflow runs:", error);
    return { conclusion: null };
  }
};

export const SPEC_PATH = SPEC_DIR;
