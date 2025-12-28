import path from "path";
import { connectMongo } from "../db/mongo";
import { CommunityProject } from "../models/CommunityProject";
import type { ChecklistItem, ChecklistStatus } from "../routes/community";
import { getOctokitForEmail } from "./github";

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
};

export type VerificationSpec = {
  taskId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  version: string;
  generatedAt: string;
  expectations: VerificationExpectation[];
};

export type RepoStack =
  | "node"
  | "solidity_foundry"
  | "solidity_hardhat"
  | "java_maven"
  | "java_gradle"
  | "php"
  | "frontend_playwright"
  | "unknown";

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

export const generateVerificationSpec = (task: {
  id: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
}): VerificationSpec => {
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

  return {
    taskId: task.id,
    title: task.title || "Task",
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
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
): Promise<RepoStack> => {
  const [owner, repo] = String(repoFullName).split("/");
  if (!owner || !repo) return "unknown";

  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!email) return "unknown";

  const { client } = await getOctokitForEmail(email);

  try {
    const ref = branch.startsWith("heads/") || branch.startsWith("refs/") ? branch : `heads/${branch}`;
    const tree = await client.getTree(owner, repo, ref);
    const paths: string[] =
      (tree?.tree || []).map((item: any) => String(item?.path || "").toLowerCase()) || [];

    const includes = (filename: string) =>
      paths.some((p) => p === filename.toLowerCase() || p.endsWith(`/${filename.toLowerCase()}`));

    if (includes("package.json")) return "node";
    if (includes("foundry.toml")) return "solidity_foundry";
    if (paths.some((p) => p.includes("hardhat.config"))) return "solidity_hardhat";
    if (includes("pom.xml")) return "java_maven";
    if (includes("build.gradle") || includes("build.gradle.kts")) return "java_gradle";
    if (includes("composer.json")) return "php";
    if (includes("playwright.config.ts") || includes("playwright.config.js")) return "frontend_playwright";

    return "unknown";
  } catch (error) {
    console.warn("[verification] Stack detection failed:", error);
    return "unknown";
  }
};

const buildNodeTest = (spec: VerificationSpec) => {
  const expectations = spec.expectations
    .map(
      (exp) => `test('${exp.key} - ${exp.title}', () => {
  assert.ok(spec.expectations.find((e) => e.key === '${exp.key}'), 'Expectation missing in spec');
  assert.ok(true, 'TODO: Implement verification for ${exp.type}');
});`
    )
    .join("\n\n");

  return `import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const specPath = path.join(process.cwd(), '${SPEC_DIR}', 'task-${spec.taskId}.json');
const raw = fs.readFileSync(specPath, 'utf8');
const spec = JSON.parse(raw);

test('spec metadata', () => {
  assert.ok(spec.taskId, 'taskId missing');
  assert.ok(Array.isArray(spec.expectations) && spec.expectations.length > 0, 'expectations missing');
});

${expectations}
`;
};

export const translateSpecToTests = (stack: RepoStack, spec: VerificationSpec): GeneratedTestFile[] => {
  const testContent = buildNodeTest(spec);
  const testPath = path.posix.join("verification", `task-${spec.taskId}.spec.js`);
  return [{ path: testPath, content: testContent }];
};

const workflowForStack = (stack: RepoStack) => `name: verify

on:
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
    steps:
      - name: Checkout task branch
        uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          elif [ -f package.json ]; then
            npm install
          else
            echo "No package.json found, skipping install"
          fi

      - name: Run generated verification
        run: |
          if ls verification/*.spec.js 1> /dev/null 2>&1; then
            node --test verification/*.spec.js
          else
            echo "No generated verification tests found"
          fi
`;

export const ensureWorkflowExists = async (
  stack: RepoStack,
  repoFullName: string,
  branch: string,
  actorEmail?: string
) => {
  const workflowPath = ".github/workflows/verify.yml";
  const content = workflowForStack(stack);
  return commitFileToBranch(
    repoFullName,
    branch,
    workflowPath,
    content,
    "chore: ensure verification workflow",
    actorEmail
  );
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
  await client.dispatchWorkflow(owner, repo, "verify.yml", branch, {
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
    const runs = await client.listWorkflowRuns(owner, repo, { branch, workflowId: "verify.yml", per_page: 5 });
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
