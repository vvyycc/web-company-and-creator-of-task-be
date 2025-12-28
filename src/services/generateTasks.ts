// src/services/taskGenerator.ts
import { randomUUID } from "crypto";
import { GeneratedTask, ProjectEstimation } from "../models/Project";
import { TaskCategory, TaskComplexity } from "../models/taskTypes";
import { HOURLY_RATE, PLATFORM_FEE_PERCENT } from "../config/pricing";

/* ======================================================
   Types
====================================================== */

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

/* ======================================================
   Utils
====================================================== */
function categoryToLayer(cat: TaskCategory): TaskCategory {
  // Tu schema no acepta QA ni INFRA en layer.
  // Map: QA -> SERVICE (o ARCHITECTURE), INFRA -> ARCHITECTURE (o SERVICE)
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

/* ======================================================
   Extraction of real work items (PM-style)
====================================================== */

function extractWorkItems(text: string): string[] {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const isHeading = (l: string) =>
    /^(\d+️⃣|\d+\.|#+)\s+/.test(l) ||
    (l.length < 70 &&
      /smart|contracts|backend|frontend|marketplace|seguridad|infra|despliegue|qa|tests|gobernanza/i.test(
        l
      ));

  const isBullet = (l: string) => /^(\-|\*|•|\d+[\.\)])\s+/.test(l);

  const items: string[] = [];

  // bullets
  lines
    .filter(isBullet)
    .forEach((l) =>
      items.push(l.replace(/^(\-|\*|•|\d+[\.\)])\s+/, "").trim())
    );

  // headings + following content
  for (let i = 0; i < lines.length; i++) {
    if (!isHeading(lines[i])) continue;

    for (let j = i + 1; j < Math.min(i + 7, lines.length); j++) {
      const nxt = lines[j];
      if (isHeading(nxt)) break;
      if (isBullet(nxt)) continue;
      if (nxt.length < 8) continue;

      const chunk = nxt.replace(/[•]/g, "").trim();
      if (chunk.length > 180) {
        chunk
          .split(/[.;]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 10)
          .slice(0, 3)
          .forEach((p) => items.push(p));
      } else {
        items.push(chunk);
      }
    }
  }

  return Array.from(new Set(items)).slice(0, 30);
}

/* ======================================================
   Heuristics
====================================================== */

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
  if (t.length > 60 || includesAny(t, ["roles", "permisos", "validación"]))
    return "MEDIUM";
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
    ])
  )
    return "CONTRACTS";

  if (includesAny(t, ["marketplace", "listing", "royalties", "nft"]))
    return "MARKETPLACE";

  if (includesAny(t, ["backend", "api", "node", "ethers", "endpoint"]))
    return "BACKEND";

  if (includesAny(t, ["frontend", "react", "vite", "wallet", "metamask", "ui"]))
    return "FRONTEND";

  if (includesAny(t, ["seguridad", "audit", "reentrancy", "roles"]))
    return "SECURITY";

  if (includesAny(t, ["deploy", "despliegue", "mainnet", "testnet", "ci"]))
    return "INFRA";

  return "GENERAL";
}

function complexityToPoints(c: TaskComplexity) {
  return c === "HIGH" ? 8 : c === "MEDIUM" ? 5 : 2;
}

function estimateHours(c: TaskComplexity, extra = 0) {
  return Math.round((complexityToPoints(c) + extra) * 2.5 * 2) / 2;
}

/* ======================================================
   Task factory
====================================================== */

function makeTask(params: {
  title: string;
  description: string;
  category: TaskCategory;
  complexity: TaskComplexity;
  priority: number;
  epic: string;
}): GeneratedTaskExt {
  const estimatedHours = estimateHours(params.complexity);
  const taskPrice = estimatedHours * HOURLY_RATE;

  return {
    id: randomUUID(),
    title: params.title,
    description: clamp(params.description),
    category: params.category,
    complexity: params.complexity,
    priority: params.priority,
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

/* ======================================================
   Builder
====================================================== */

function buildSmartTasks(
  projectTitle: string,
  projectDescription: string
): GeneratedTaskExt[] {
  let p = 1;
  const tasks: GeneratedTaskExt[] = [];

  // Foundation
  tasks.push(
    makeTask({
      title: "Arquitectura y diseño global Web3",
      description:
        "Definir arquitectura completa: smart contracts, backend, frontend, flujos on-chain/off-chain.",
      category: "ARCHITECTURE",
      complexity: "HIGH",
      priority: p++,
      epic: "Foundation",
    })
  );

  tasks.push(
    makeTask({
      title: "Modelo de datos y entidades clave",
      description:
        "Definir entidades off-chain necesarias (usuarios, assets, marketplace, ventas).",
      category: "MODEL",
      complexity: "MEDIUM",
      priority: p++,
      epic: "Foundation",
    })
  );

  // Items reales del proyecto
  const items = extractWorkItems(projectDescription);

  items.forEach((item, idx) => {
    const c = guessComplexity(item);
    const domain = classifyDomain(item);
    const epic = `Feature ${idx + 1}`;

    // Diseño
    if (c !== "SIMPLE") {
      tasks.push(
        makeTask({
          title: `Diseño técnico: ${item}`,
          description: `Definir enfoque, edge cases y criterios de aceptación para "${item}".`,
          category: "ARCHITECTURE",
          complexity: "MEDIUM",
          priority: p++,
          epic,
        })
      );
    }

    if (domain === "CONTRACTS") {
      tasks.push(
        makeTask({
          title: `Smart Contracts: ${item}`,
          description: `Implementación Solidity/Hardhat de "${item}".`,
          category: "SERVICE",
          complexity: c,
          priority: p++,
          epic,
        })
      );
      tasks.push(
        makeTask({
          title: `Tests Smart Contracts: ${item}`,
          description: `Tests unitarios e integración para "${item}".`,
          category: "QA",
          complexity: "MEDIUM",
          priority: p++,
          epic,
        })
      );
    } else if (domain === "BACKEND") {
      tasks.push(
        makeTask({
          title: `Backend API: ${item}`,
          description: `Implementar endpoints y lógica Node.js para "${item}".`,
          category: "SERVICE",
          complexity: c,
          priority: p++,
          epic,
        })
      );
      tasks.push(
        makeTask({
          title: `Backend QA: ${item}`,
          description: `Tests de endpoints y validaciones.`,
          category: "QA",
          complexity: "SIMPLE",
          priority: p++,
          epic,
        })
      );
    } else if (domain === "FRONTEND") {
      tasks.push(
        makeTask({
          title: `Frontend UI: ${item}`,
          description: `Implementar UI Web3 para "${item}".`,
          category: "VIEW",
          complexity: c,
          priority: p++,
          epic,
        })
      );
    } else if (domain === "MARKETPLACE") {
      tasks.push(
        makeTask({
          title: `Marketplace: ${item}`,
          description: `Funcionalidad de marketplace para "${item}".`,
          category: "SERVICE",
          complexity: "HIGH",
          priority: p++,
          epic,
        })
      );
      tasks.push(
        makeTask({
          title: `Marketplace UI: ${item}`,
          description: `Vista frontend para "${item}".`,
          category: "VIEW",
          complexity: "MEDIUM",
          priority: p++,
          epic,
        })
      );
    } else if (domain === "SECURITY") {
      tasks.push(
        makeTask({
          title: `Seguridad: ${item}`,
          description: `Hardening y revisión de seguridad para "${item}".`,
          category: "QA",
          complexity: "HIGH",
          priority: p++,
          epic,
        })
      );
    } else if (domain === "INFRA") {
      tasks.push(
        makeTask({
          title: `Infra / Deploy: ${item}`,
          description: `Preparar despliegue y configuración para "${item}".`,
          category: "INFRA",
          complexity: c,
          priority: p++,
          epic,
        })
      );
    } else {
      tasks.push(
        makeTask({
          title: `Implementar: ${item}`,
          description: `Implementación general de "${item}".`,
          category: "SERVICE",
          complexity: c,
          priority: p++,
          epic,
        })
      );
    }
  });

  return tasks;
}

/* ======================================================
   Public API
====================================================== */

export function generateProjectEstimationFromDescription(
  input: GenerateTasksInput
): ProjectEstimation {
  const { projectTitle, projectDescription, ownerEmail } = input;

  const tasks = buildSmartTasks(projectTitle, projectDescription);

  const totalHours = tasks.reduce((s, t) => s + t.estimatedHours, 0);
  const totalTasksPrice = tasks.reduce((s, t) => s + t.taskPrice, 0);

  const platformFeeAmount =
    (totalTasksPrice * PLATFORM_FEE_PERCENT) / 100;

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
  };
}
