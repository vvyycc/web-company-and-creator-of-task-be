// src/services/taskGenerator.ts
import { randomUUID } from "crypto";
import { GeneratedTask, ProjectEstimation } from "../models/Project";
import { TaskCategory, TaskComplexity } from "../models/taskTypes";
import { HOURLY_RATE, PLATFORM_FEE_PERCENT } from "../config/pricing";
import { DEFAULT_PROJECT_STACK } from "../models/stack";
import { RecommendedStack, StackSource } from "../models/recommendedStack";
import { enhanceWorkItemsWithAI } from "./openaiTaskEnhancer";

interface GenerateTasksInput {
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
}

type GeneratedTaskExt = GeneratedTask & {
  dependsOn?: string[];
  recommendedOrder?: number;
  epic?: string;
};

type WorkItemCandidate = {
  text: string;
  score: number;
};

export const DEFAULT_MAX_TASKS = Number(process.env.DEFAULT_MAX_TASKS || 30);
const MIN_ACTIONABLE_SCORE = 2;

const ACTION_VERBS = [
  "implementar",
  "crear",
  "integrar",
  "desplegar",
  "testear",
  "auditar",
  "configurar",
  "automatizar",
  "documentar",
  "refactorizar",
  "optimizar",
  "monitorizar",
  "validar",
  "instrumentar",
];

const GENERIC_BLACKLIST = [
  "visión",
  "estado actual",
  "componentes principales",
  "modelo económico",
  "seguridad y buenas prácticas",
  "impacto esperado",
  "objetivo",
  "beneficios",
  "roadmap",
  "estrategia",
  "oportunidad",
];

const MARKETING_PATTERNS = ["innovador", "revolucionario", "experiencia única", "líder", "¡", "descubre"];

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}]/gu;

export function categoryToLayer(cat: TaskCategory): TaskCategory {
  // Layer must always be valid for TaskSchema enum. QA/INFRA are mapped to real layers.
  if (cat === "QA") return "SERVICE";
  if (cat === "INFRA") return "ARCHITECTURE";
  return cat;
}

function normalize(text: string) {
  return (text || "").toLowerCase();
}

function includesAny(text: string, keywords: string[]): boolean {
  const lower = normalize(text);
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

function clamp(text: string, max = 260) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function sanitizeLine(line: string) {
  return line
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[•·]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isEmojiHeavy(line: string) {
  const matches = line.match(EMOJI_REGEX) || [];
  return matches.length >= 3;
}

function computeActionScore(line: string) {
  let score = 0;
  if (includesAny(line, ACTION_VERBS)) score += 3;
  if (includesAny(line, ["api", "contrato", "wallet", "deploy", "infra", "tests"])) score += 2;
  if (includesAny(line, ["definir", "diseñar", "modelo", "esquema"])) score += 1;
  if (MARKETING_PATTERNS.some((m) => line.toLowerCase().includes(m))) score -= 3;
  if (GENERIC_BLACKLIST.some((m) => line.toLowerCase().includes(m))) score -= 4;
  if (isEmojiHeavy(line)) score -= 3;
  if (line.length < 12) score -= 2;
  return score;
}

function extractWorkItems(text: string): WorkItemCandidate[] {
  const lines = (text || "")
    .split(/\r?\n/)
    .map(sanitizeLine)
    .filter(Boolean);

  const isBullet = (l: string) => /^(\-|\*|•|\d+[\.\)]|\[[ x]?\])\s+/i.test(l);
  const candidates: Map<string, WorkItemCandidate> = new Map();

  const pushCandidate = (raw: string, bonus = 0) => {
    const cleaned = sanitizeLine(raw.replace(/^(\-|\*|•|\d+[\.\)]|\[[ x]?\])\s+/i, ""));
    const key = normalize(cleaned);
    if (!cleaned || cleaned.length < 8) return;
    if (isEmojiHeavy(cleaned)) return;
    if (GENERIC_BLACKLIST.some((w) => key.includes(w))) return;

    const score = computeActionScore(cleaned) + bonus;
    if (score < MIN_ACTIONABLE_SCORE) return;
    const prev = candidates.get(key);
    if (!prev || prev.score < score) {
      candidates.set(key, { text: cleaned, score });
    }
  };

  lines.forEach((line) => {
    if (isBullet(line)) {
      pushCandidate(line, 2);
      return;
    }

    // Split paragraphs by punctuation to avoid broken checklists.
    if (line.length > 120) {
      line
        .split(/[.;]/)
        .map(sanitizeLine)
        .filter(Boolean)
        .forEach((chunk) => pushCandidate(chunk, 0));
    } else {
      pushCandidate(line, 0);
    }
  });

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score).slice(0, 40);
}

function guessComplexity(item: string): TaskComplexity {
  const t = item.toLowerCase();
  if (
    t.length > 120 ||
    includesAny(t, [
      "integración",
      "oauth",
      "stripe",
      "staking",
      "vesting",
      "oracle",
      "chainlink",
      "marketplace",
      "pagos",
    ])
  )
    return "HIGH";
  if (t.length > 60 || includesAny(t, ["roles", "permisos", "validación"])) return "MEDIUM";
  return "SIMPLE";
}

function classifyDomain(item: string) {
  const t = item.toLowerCase();

  if (
    includesAny(t, [
      "solidity",
      "erc-20",
      "erc20",
      "erc-721",
      "erc721",
      "erc-1155",
      "erc1155",
      "staking",
      "vesting",
      "burn",
      "oracle",
      "chainlink",
      "wallet",
      "metamask",
    ])
  )
    return "CONTRACTS";

  if (includesAny(t, ["marketplace", "listing", "royalties", "nft"])) return "MARKETPLACE";

  if (includesAny(t, ["backend", "api", "node", "ethers", "endpoint"])) return "BACKEND";

  if (includesAny(t, ["frontend", "react", "vite", "wallet", "metamask", "ui"])) return "FRONTEND";

  if (includesAny(t, ["seguridad", "audit", "reentrancy", "roles", "hardening"])) return "SECURITY";

  if (includesAny(t, ["deploy", "despliegue", "mainnet", "testnet", "ci", "infra"])) return "INFRA";

  return "GENERAL";
}

function complexityToPoints(c: TaskComplexity) {
  return c === "HIGH" ? 8 : c === "MEDIUM" ? 5 : 2;
}

function estimateHours(c: TaskComplexity, extra = 0) {
  return Math.round((complexityToPoints(c) + extra) * 2.5 * 2) / 2;
}

function makeTask(params: {
  title: string;
  description: string;
  category: TaskCategory;
  complexity: TaskComplexity;
  epic: string;
}): GeneratedTaskExt {
  const estimatedHours = estimateHours(params.complexity);
  const taskPrice = estimatedHours * HOURLY_RATE;

  return {
    id: randomUUID(),
    title: clamp(params.title, 120),
    description: clamp(params.description),
    category: params.category,
    complexity: params.complexity,
    priority: 0, // will be assigned later to keep gaps closed after trimming
    estimatedHours,
    hourlyRate: HOURLY_RATE,
    taskPrice,
    columnId: "todo",
    layer: categoryToLayer(params.category),
    price: taskPrice,
    developerNetPrice: taskPrice,
    epic: params.epic,
  };
}

function buildRecommendedStack(
  projectTitle: string,
  projectDescription: string
): { recommendedStack: RecommendedStack; stackSource: StackSource; stackConfidence: number } {
  const text = `${projectTitle} ${projectDescription}`.toLowerCase();
  const isWeb3 = includesAny(text, [
    "web3",
    "smart contract",
    "solidity",
    "token",
    "wallet",
    "nft",
    "defi",
    "metamask",
    "chainlink",
    "staking",
  ]);

  if (isWeb3) {
    return {
      recommendedStack: {
        frontend: ["React", "Vite", "TypeScript", "TailwindCSS", "wagmi/viem"],
        backend: ["Node.js", "Express", "TypeScript"],
        smartContracts: ["Hardhat", "Solidity", "OpenZeppelin", "Chainlink"],
        database: ["MongoDB", "Mongoose"],
        infra: ["Docker", "Docker Compose", "GitHub Actions"],
        testing: ["Jest", "Vitest", "Hardhat tests"],
        devops: ["GitHub Actions", "ESLint/Prettier"],
        notes: ["Configurar wallets y providers antes de QA."],
      },
      stackSource: "HEURISTIC",
      stackConfidence: 0.78,
    };
  }

  return {
    recommendedStack: {
      frontend: ["React", "Vite", "TypeScript", "TailwindCSS"],
      backend: ["Node.js", "Express", "TypeScript"],
      smartContracts: [],
      database: ["MongoDB", "Mongoose"],
      infra: ["Docker", "Docker Compose", "GitHub Actions"],
      testing: ["Jest", "Vitest"],
      devops: ["GitHub Actions", "ESLint/Prettier"],
      notes: ["Stack SaaS base con REST y autenticación JWT/OAuth."],
    },
    stackSource: "HEURISTIC",
    stackConfidence: 0.62,
  };
}

function buildSmartTasks(
  projectTitle: string,
  projectDescription: string,
  workItems: WorkItemCandidate[],
  maxTasks = DEFAULT_MAX_TASKS
): GeneratedTaskExt[] {
  const tasks: GeneratedTaskExt[] = [];
  const seenTitles = new Set<string>();

  const pushTask = (task: GeneratedTaskExt) => {
    const key = normalize(task.title);
    if (seenTitles.has(key)) return;
    if (tasks.length >= maxTasks) return;
    seenTitles.add(key);
    tasks.push(task);
  };

  // Base epic to make sure we always have more than 4 tasks.
  pushTask(
    makeTask({
      title: "Arquitectura y roadmap inicial",
      description: `Diseñar arquitectura de "${projectTitle}" (capas, contratos, APIs, dependencias).`,
      category: "ARCHITECTURE",
      complexity: "HIGH",
      epic: "Foundation",
    })
  );
  pushTask(
    makeTask({
      title: "Modelo de datos y esquema",
      description: "Definir entidades, índices y validaciones en MongoDB/Mongoose.",
      category: "MODEL",
      complexity: "MEDIUM",
      epic: "Foundation",
    })
  );
  pushTask(
    makeTask({
      title: "Pipeline de CI/CD mínima",
      description: "Configurar lint/test automáticos y build para PRs.",
      category: "INFRA",
      complexity: "MEDIUM",
      epic: "Foundation",
    })
  );

  const cappedItems = workItems.slice(0, Math.max(10, Math.floor(maxTasks / 2)));

  cappedItems.forEach((item, idx) => {
    const c = guessComplexity(item.text);
    const domain = classifyDomain(item.text);
    const epic = `Feature ${idx + 1}`;

    if (c !== "SIMPLE") {
      pushTask(
        makeTask({
          title: `Diseño técnico: ${item.text}`,
          description: `Cerrar enfoque, edge cases y criterios de aceptación para "${item.text}".`,
          category: "ARCHITECTURE",
          complexity: "MEDIUM",
          epic,
        })
      );
    }

    if (domain === "CONTRACTS") {
      pushTask(
        makeTask({
          title: `Smart Contracts: ${item.text}`,
          description: `Implementar contratos Solidity con Hardhat para "${item.text}".`,
          category: "SERVICE",
          complexity: c,
          epic,
        })
      );
      pushTask(
        makeTask({
          title: `Tests Smart Contracts: ${item.text}`,
          description: `Pruebas unitarias y de seguridad para contratos de "${item.text}".`,
          category: "QA",
          complexity: "MEDIUM",
          epic,
        })
      );
    } else if (domain === "BACKEND") {
      pushTask(
        makeTask({
          title: `Backend API: ${item.text}`,
          description: `Implementar endpoints REST/GraphQL para "${item.text}".`,
          category: "SERVICE",
          complexity: c,
          epic,
        })
      );
      pushTask(
        makeTask({
          title: `Backend tests: ${item.text}`,
          description: "Cobertura de endpoints, validaciones y casos de error.",
          category: "QA",
          complexity: "SIMPLE",
          epic,
        })
      );
    } else if (domain === "FRONTEND") {
      pushTask(
        makeTask({
          title: `Frontend UI: ${item.text}`,
          description: `Implementar vistas y flujo UX para "${item.text}".`,
          category: "VIEW",
          complexity: c,
          epic,
        })
      );
    } else if (domain === "MARKETPLACE") {
      pushTask(
        makeTask({
          title: `Marketplace services: ${item.text}`,
          description: `Casos de uso y pricing de marketplace para "${item.text}".`,
          category: "SERVICE",
          complexity: "HIGH",
          epic,
        })
      );
      pushTask(
        makeTask({
          title: `Marketplace UI: ${item.text}`,
          description: `Flujos de listado/checkout para "${item.text}".`,
          category: "VIEW",
          complexity: "MEDIUM",
          epic,
        })
      );
    } else if (domain === "SECURITY") {
      pushTask(
        makeTask({
          title: `Seguridad y QA: ${item.text}`,
          description: `Auditoría de roles, reentrancy y controles de "${item.text}".`,
          category: "QA",
          complexity: "HIGH",
          epic,
        })
      );
    } else if (domain === "INFRA") {
      pushTask(
        makeTask({
          title: `Infra/Deploy: ${item.text}`,
          description: `Provisionar pipelines y despliegue para "${item.text}".`,
          category: "INFRA",
          complexity: c,
          epic,
        })
      );
    } else {
      pushTask(
        makeTask({
          title: `Implementar: ${item.text}`,
          description: `Implementación funcional de "${item.text}".`,
          category: "SERVICE",
          complexity: c,
          epic,
        })
      );
    }
  });

  const trimmed = tasks.slice(0, maxTasks);
  return trimmed.map((task, idx) => ({ ...task, priority: idx + 1 }));
}

export async function generateProjectEstimationFromDescription(
  input: GenerateTasksInput
): Promise<ProjectEstimation> {
  const { projectTitle, projectDescription, ownerEmail } = input;

  const heuristicItems = extractWorkItems(projectDescription);
  const aiResult = await enhanceWorkItemsWithAI({
    title: projectTitle,
    description: projectDescription,
    ownerEmail,
  });

  const mergedItemMap = new Map<string, WorkItemCandidate>();
  const addItem = (text: string, score: number) => {
    const key = normalize(text);
    const prev = mergedItemMap.get(key);
    if (!prev || prev.score < score) mergedItemMap.set(key, { text: clamp(text, 140), score });
  };

  heuristicItems.forEach((item) => addItem(item.text, item.score));
  aiResult?.items.forEach((item) => addItem(item, 6));

  const mergedItems = Array.from(mergedItemMap.values()).sort((a, b) => b.score - a.score);

  const tasks = buildSmartTasks(projectTitle, projectDescription, mergedItems, DEFAULT_MAX_TASKS);

  const { recommendedStack, stackSource, stackConfidence } = aiResult?.recommendedStack
    ? {
        recommendedStack: aiResult.recommendedStack,
        stackSource: aiResult.stackSource,
        stackConfidence: aiResult.stackConfidence ?? 0.7,
      }
    : buildRecommendedStack(projectTitle, projectDescription);

  const totalHours = tasks.reduce((s, t) => s + t.estimatedHours, 0);
  const totalTasksPrice = tasks.reduce((s, t) => s + t.taskPrice, 0);

  const platformFeeAmount = (totalTasksPrice * PLATFORM_FEE_PERCENT) / 100;

  return {
    projectTitle,
    projectDescription,
    ownerEmail,
    tasks,
    totalHours,
    totalTasksPrice,
    platformFeePercent: PLATFORM_FEE_PERCENT,
    platformFeeAmount,
    grandTotalClientCost: totalTasksPrice + platformFeeAmount,
    recommendedStack,
    stackSource,
    stackConfidence,
    stack: DEFAULT_PROJECT_STACK,
  };
}
