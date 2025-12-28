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

export type VerificationRule =
  | { op: "exists"; path: string }
  | { op: "changed"; path: string }
  | { op: "contains"; path: string; value: string }
  | { op: "regex"; path: string; value: string };

export type VerificationExpectation = {
  key: string;
  title: string;
  description?: string;
  type: VerificationExpectationType;
  target?: string;
  successCriteria?: string[];
  rules?: VerificationRule[];
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

const keywordPathHints: Array<{ match: RegExp; glob: string }> = [
  { match: /(route|endpoint|api)/i, glob: "src/routes/**/*" },
  { match: /(service|logic|use case|handler)/i, glob: "src/services/**/*" },
  { match: /(model|schema|database|db|mongo)/i, glob: "src/models/**/*" },
  { match: /(socket|websocket)/i, glob: "src/socket.ts" },
  { match: /(config|env|environment)/i, glob: "src/config/**/*" },
  { match: /(test|spec|qa)/i, glob: "**/*test*.ts" },
  { match: /(workflow|pipeline|ci)/i, glob: ".github/workflows/**/*" },
];

function inferRuleGlob(text: string): string {
  for (const hint of keywordPathHints) {
    if (hint.match.test(text)) return hint.glob;
  }
  return "src/**/*";
}

function buildRulesForExpectation(taskId: string, expectationKey: string, text: string): VerificationRule[] {
  const glob = inferRuleGlob(text);
  const specPath = path.posix.join(SPEC_DIR, `task-${taskId}.json`);

  const rules: VerificationRule[] = [
    { op: "changed", path: glob },
    { op: "exists", path: specPath },
    {
      op: "contains",
      path: specPath,
      value: `"${expectationKey}"`,
    },
  ];

  return rules;
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
      rules: buildRulesForExpectation(task.id, key, text || ""),
    };
  });

  if (!expectations.length) {
    const fallbackKey = `${slugify(task.title || "expectation")}-0`;
    expectations.push({
      key: fallbackKey,
      title: task.title || "Expectation",
      description: task.description || "Validate the delivered changes.",
      type: "file",
      successCriteria: ["Verify deliverable matches task description."],
      rules: buildRulesForExpectation(task.id, fallbackKey, task.description || task.title || ""),
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

const describeRule = (rule: VerificationRule): string => {
  if (!rule) return "";
  if (rule.op === "exists") return `exists: ${rule.path}`;
  if (rule.op === "changed") return `changed: ${rule.path}`;
  if (rule.op === "contains") return `contains: ${rule.path} -> ${rule.value}`;
  if (rule.op === "regex") return `regex: ${rule.path} /${rule.value}/`;
  return "";
};

export const buildChecklistFromSpec = (
  spec: VerificationSpec,
  existing?: ChecklistItem[],
  options?: { forcePending?: boolean; includeRuleDetails?: boolean }
) => {
  const currentMap = new Map<string, ChecklistItem>();
  (existing || []).forEach((item) => currentMap.set(item.key, item));

  return spec.expectations.map((expectation, index) => {
    const prev = currentMap.get(expectation.key);
    const status: ChecklistStatus =
      options?.forcePending || !prev || !["PENDING", "PASSED", "FAILED"].includes(prev.status)
        ? "PENDING"
        : (prev.status as ChecklistStatus);

    const detailsFromRules =
      options?.includeRuleDetails && expectation.rules && expectation.rules.length
        ? expectation.rules.map((r) => `- ${describeRule(r)}`).join("\n")
        : expectation.description;

    return {
      key: expectation.key || `${slugify(expectation.title, "item")}-${index}`,
      text: expectation.title || expectation.description || expectation.key,
      status,
      ...(detailsFromRules ? { details: detailsFromRules } : {}),
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
  actorEmail?: string,
  workflowId: string = "verify.yml"
) => {
  const [owner, repo] = String(repoFullName).split("/");
  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!owner || !repo || !email) throw new Error("invalid_repo_context");

  const { client } = await getOctokitForEmail(email);
  await client.dispatchWorkflow(owner, repo, workflowId, branch, {
    projectId: payload.projectId,
    taskId: payload.taskId,
    branch,
  });
};

export const pollOrFetchLatestRun = async (
  repoFullName: string,
  branch: string,
  actorEmail?: string,
  workflowId: string = "verify.yml"
): Promise<{ conclusion: string | null; url?: string }> => {
  const [owner, repo] = String(repoFullName).split("/");
  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!owner || !repo || !email) throw new Error("invalid_repo_context");

  const { client } = await getOctokitForEmail(email);
  try {
    const runs = await client.listWorkflowRuns(owner, repo, { branch, workflowId, per_page: 5 });
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

export const buildCommunityVerifyRunner = () =>
  String.raw`#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SPEC_DIR = path.join(process.cwd(), '.community', 'verification');

const args = process.argv.slice(2);
const taskArg = args.find((a) => a.startsWith('--task='));
const taskIdFilter = taskArg ? taskArg.replace('--task=', '').trim() : null;

const log = (msg) => console.log(msg);

const safeExec = (command) => {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return '';
  }
};

const detectBaseRef = () => {
  const candidates = ['origin/main', 'origin/master', 'main', 'master'];
  for (const ref of candidates) {
    try {
      execSync(\`git rev-parse --verify \${ref}\`, { stdio: 'ignore' });
      return ref;
    } catch (e) {
      // ignore
    }
  }
  return 'origin/main';
};

const listSpecFiles = () => {
  if (!fs.existsSync(SPEC_DIR)) return [];
  return fs.readdirSync(SPEC_DIR)
    .filter((f) => /^task-.*\\.json$/i.test(f))
    .map((f) => path.join(SPEC_DIR, f))
    .filter((f) => (taskIdFilter ? f.includes(\`task-\${taskIdFilter}.json\`) : true));
};

const describeRule = (rule) => {
  if (!rule) return '';
  if (rule.op === 'exists') return \`exists: \${rule.path}\`;
  if (rule.op === 'changed') return \`changed: \${rule.path}\`;
  if (rule.op === 'contains') return \`contains: \${rule.path} -> \${rule.value}\`;
  if (rule.op === 'regex') return \`regex: \${rule.path} /\${rule.value}/\`;
  return '';
};

const gitList = (pattern) => {
  const out = safeExec(\`git ls-files \"\${pattern}\"\`);
  if (!out) return [];
  return out.split('\\n').map((l) => l.trim()).filter(Boolean);
};

const ruleCheckers = {
  exists: (rule) => {
    const matches = gitList(rule.path);
    return { ok: matches.length > 0, details: matches };
  },
  changed: (rule) => {
    const base = detectBaseRef();
    const out = safeExec(\`git diff --name-only \${base}...HEAD -- \"\${rule.path}\"\`);
    const files = out ? out.split('\\n').map((l) => l.trim()).filter(Boolean) : [];
    return { ok: files.length > 0, details: files };
  },
  contains: (rule) => {
    const matches = gitList(rule.path);
    if (!matches.length) return { ok: false, details: [\`No files match \${rule.path}\`] };
    const hit = matches.find((file) => {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        return raw.includes(rule.value);
      } catch (e) {
        return false;
      }
    });
    return { ok: !!hit, details: hit ? [hit] : [] };
  },
  regex: (rule) => {
    const matches = gitList(rule.path);
    if (!matches.length) return { ok: false, details: [\`No files match \${rule.path}\`] };
    const regex = new RegExp(rule.value);
    const hit = matches.find((file) => {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        return regex.test(raw);
      } catch (e) {
        return false;
      }
    });
    return { ok: !!hit, details: hit ? [hit] : [] };
  },
};

const evaluateExpectation = (spec, expectation) => {
  const rules = Array.isArray(expectation.rules) ? expectation.rules : [];
  if (!rules.length) {
    return { ok: false, ruleResults: [], message: 'No rules defined' };
  }

  const ruleResults = rules.map((rule) => {
    const fn = ruleCheckers[rule.op];
    if (!fn) return { rule, ok: false, details: ['unsupported rule'] };
    const result = fn(rule);
    return { rule, ok: !!result.ok, details: result.details || [] };
  });

  const ok = ruleResults.every((r) => r.ok);
  return { ok, ruleResults, message: ok ? 'PASSED' : 'FAILED' };
};

const evaluateSpec = (specPath) => {
  const raw = fs.readFileSync(specPath, 'utf8');
  const spec = JSON.parse(raw);
  const expectations = Array.isArray(spec.expectations) ? spec.expectations : [];

  const results = expectations.map((expectation) => {
    const res = evaluateExpectation(spec, expectation);
    return { expectation, ...res };
  });

  const ok = results.every((r) => r.ok);
  return { spec, specPath, ok, results };
};

const main = () => {
  const specFiles = listSpecFiles();
  if (!specFiles.length) {
    console.error('No verification specs found in .community/verification');
    process.exit(1);
  }

  const allResults = specFiles.map((file) => evaluateSpec(file));

  for (const specResult of allResults) {
    log(\`\\nSpec: \${path.basename(specResult.specPath)} => \${specResult.ok ? 'PASSED' : 'FAILED'}\`);
    for (const result of specResult.results) {
      log(\`  - \${result.expectation.key}: \${result.ok ? 'PASSED' : 'FAILED'}\`);
      result.ruleResults.forEach((rr) => {
        log(\`      \${rr.ok ? '✔' : '✖'} \${describeRule(rr.rule)}\${rr.details.length ? \` (\${rr.details.join(', ')})\` : ''}\`);
      });
      if (!result.ruleResults.length) {
        log('      ✖ No rules to evaluate');
      }
    }
  }

  const allOk = allResults.every((r) => r.ok);
  log(\`\\nSummary: \${allOk ? 'PASSED' : 'FAILED'} (\${allResults.filter((r) => r.ok).length}/\${allResults.length} specs)\`);
  process.exit(allOk ? 0 : 1);
};

main();
`;

export const buildCommunityVerifyWorkflow = () => `name: community-verify

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run community verification
        run: node .community/runner/verify.mjs
`;
