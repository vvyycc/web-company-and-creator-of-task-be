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

export const SPEC_DIR = ".community/verification";
export const SPEC_PATH = SPEC_DIR;

export const COMMUNITY_WORKFLOW_FILE = ".github/workflows/community-verify.yml";

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------
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

  // OJO: "changed" debe fallar si NO hay cambios reales -> perfecto para evitar DONE sin código
  const rules: VerificationRule[] = [
    { op: "changed", path: glob },
    { op: "exists", path: specPath },
    { op: "contains", path: specPath, value: `"${expectationKey}"` },
  ];

  return rules;
}

// -----------------------------------------------------------------------------
// Spec generation
// -----------------------------------------------------------------------------
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
        "Must satisfy acceptance criteria",
        "Must include objective verification rules",
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

// -----------------------------------------------------------------------------
// Checklist mapping
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// GitHub helpers
// -----------------------------------------------------------------------------
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

// -----------------------------------------------------------------------------
// ✅ AUTOGENERATED TESTS (agnostic + enforce runner)
// -----------------------------------------------------------------------------
const buildRunnerBackedTest = (spec: VerificationSpec) => {
  // Este test es agnóstico al stack: ejecuta tu runner que evalúa rules (changed/exists/contains/regex)
  // Si no hay cambios reales en el glob inferido => FALLA => checklist rojo X y vuelve a doing.
  return `import test from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';

test('community verification runner for task ${spec.taskId}', () => {
  try {
    execSync(\`node .community/runner/verify.mjs --task=${spec.taskId}\`, {
      stdio: 'inherit'
    });
    assert.ok(true);
  } catch (e) {
    // runner devuelve exit 1 si falla cualquier expectation
    assert.fail('Community verification failed for task ${spec.taskId}');
  }
});
`;
};

// Si más adelante quieres tests "propios" por stack, aquí puedes bifurcar.
// De momento dejamos runner-backed que es el que hace la verificación objetiva.
export const translateSpecToTests = (stack: RepoStack, spec: VerificationSpec): GeneratedTestFile[] => {
  const testContent = buildRunnerBackedTest(spec);
  const testPath = path.posix.join("verification", `task-${spec.taskId}.spec.js`);
  return [{ path: testPath, content: testContent }];
};

// -----------------------------------------------------------------------------
// Workflows
// -----------------------------------------------------------------------------
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
    inputs:
      projectId:
        description: "Community project id"
        required: false
      taskId:
        description: "Task id"
        required: false
      branch:
        description: "Task branch"
        required: false

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          # Importante: para que git diff origin/main...HEAD funcione
          fetch-depth: 0
          # En PR usa la rama head; en workflow_dispatch puedes forzar inputs.branch si quieres
          ref: \${{ github.event.inputs.branch || github.head_ref || github.ref_name }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run community verification
        run: node .community/runner/verify.mjs
`;

// -----------------------------------------------------------------------------
// Opcional: workflow "verify.yml" (stack-based) para el futuro
// -----------------------------------------------------------------------------
export const ensureWorkflowExists = async (
  stack: RepoStack,
  repoFullName: string,
  branch: string,
  actorEmail?: string
) => {
  // Por ahora NO tocamos verify.yml porque tu verificación se basa en community-verify.yml.
  // Si más adelante quieres uno por stack, aquí lo implementas.
  return { updated: false };
};

// -----------------------------------------------------------------------------
// Workflow dispatch
// -----------------------------------------------------------------------------
export const triggerWorkflow = async (
  repoFullName: string,
  branch: string,
  payload: { projectId: string; taskId: string },
  actorEmail?: string,
  workflowId: string = "community-verify.yml"
) => {
  const [owner, repo] = String(repoFullName).split("/");
  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!owner || !repo || !email) throw new Error("invalid_repo_context");

  const { client } = await getOctokitForEmail(email);

  // Ahora el workflow acepta estos inputs => no habrá 422
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
  workflowId: string = "community-verify.yml",
  options?: { afterIso?: string }
): Promise<{ conclusion: string | null; url?: string }> => {
  const [owner, repo] = String(repoFullName).split("/");
  const email = actorEmail || (await resolveOwnerEmailByRepo(repoFullName));
  if (!owner || !repo || !email) throw new Error("invalid_repo_context");

  const { client } = await getOctokitForEmail(email);

  try {
    const runs = await client.listWorkflowRuns(owner, repo, { branch, workflowId, per_page: 10 });

    const after = options?.afterIso ? new Date(options.afterIso).getTime() : null;

    // IMPORTANTÍSIMO:
    // - coger run de ESTE workflow
    // - de ESTA branch
    // - preferir workflow_dispatch
    // - y si afterIso está, que sea posterior al dispatch, para no “coger” un run viejo success
    const candidates =
      (runs?.workflow_runs || [])
        .filter((r: any) => String(r.head_branch) === branch)
        .filter((r: any) => !after || new Date(String(r.created_at || 0)).getTime() >= after)
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) || [];

    const run =
      candidates.find((r: any) => r.event === "workflow_dispatch") ||
      candidates[0];

    return { conclusion: run?.conclusion ?? null, url: run?.html_url };
  } catch (error) {
    console.warn("[verification] Cannot fetch workflow runs:", error);
    return { conclusion: null };
  }
};

// -----------------------------------------------------------------------------
// ✅ NUEVO: helper para escribir spec + runner + workflow + tests en rama
// -----------------------------------------------------------------------------
export const ensureVerificationAssetsOnBranch = async (params: {
  repoFullName: string;
  branch: string;
  task: { id: string; title?: string; description?: string; acceptanceCriteria?: string };
  actorEmail: string;
  stack?: RepoStack;
}) => {
  const { repoFullName, branch, task, actorEmail } = params;

  const spec = generateVerificationSpec({
    id: String(task.id),
    title: task.title,
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
  });

  const specPath = `${SPEC_PATH}/task-${task.id}.json`;

  // detect stack (opcional)
  const stack = params.stack || (await detectRepoStack(repoFullName, branch, actorEmail));

  // tests
  const tests = translateSpecToTests(stack, spec);

  // commit spec + runner + workflow + tests
  await commitFileToBranch(
    repoFullName,
    branch,
    specPath,
    JSON.stringify(spec, null, 2),
    `chore: add verification spec for task ${task.id}`,
    actorEmail
  );

  await commitFileToBranch(
    repoFullName,
    branch,
    ".community/runner/verify.mjs",
    buildCommunityVerifyRunner(),
    "chore: ensure community verify runner",
    actorEmail
  );

  await commitFileToBranch(
    repoFullName,
    branch,
    COMMUNITY_WORKFLOW_FILE,
    buildCommunityVerifyWorkflow(),
    "chore: ensure community verify workflow",
    actorEmail
  );

  for (const f of tests) {
    await commitFileToBranch(
      repoFullName,
      branch,
      f.path,
      f.content,
      `test: add generated verification test for task ${task.id}`,
      actorEmail
    );
  }

  return { spec, stack, tests };
};
