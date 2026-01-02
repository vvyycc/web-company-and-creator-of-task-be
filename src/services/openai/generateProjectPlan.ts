import { HOURLY_RATE, PLATFORM_FEE_PERCENT } from "../../config/pricing";
import {
  GeneratedTask,
  ProjectEstimation,
  RecommendedStack,
  StackInference,
} from "../../models/Project";
import { TaskCategory, TaskComplexity } from "../../models/taskTypes";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

type OpenAIClient = {
  chat: { completions: { create: (input: any) => Promise<any> } };
};

type OpenAIPlan = {
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
  tasks: Array<Partial<GeneratedTask> & { acceptanceCriteria?: string[] | string }>;
  stackInferred: RecommendedStack;
  stackRecommended: RecommendedStack;
  stackMissing?: Record<string, string[]>;
  stackInferredReasons: string[];
  stackSignals?: string[];
  stackConfidence?: number;
};

function getOpenAIClient(): OpenAIClient | null {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("openai");
    const OpenAIConstructor = mod?.default || mod;
    return new OpenAIConstructor({ apiKey });
  } catch (error) {
    console.warn("OpenAI SDK no disponible:", error);
    return null;
  }
}

function extractJSON(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON payload in OpenAI response");
  return JSON.parse(match[0]);
}

function normalizeAcceptanceCriteria(value: unknown, fallbackTitle: string): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 8);
  }

  if (typeof value === "string") {
    const parts = value
      .split(/[\n•\-]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.slice(0, 8);
  }

  return [
    `Criterio mínimo validable para ${fallbackTitle}`,
    `Endpoint o contrato probado para ${fallbackTitle}`,
    `Tests o evidencia de QA para ${fallbackTitle}`,
  ];
}

function normalizeCategory(value?: string): TaskCategory {
  const v = (value || "").toUpperCase();
  if (v === "MODEL") return "MODEL";
  if (v === "VIEW" || v === "FRONTEND" || v === "UI") return "VIEW";
  if (v === "ARCHITECTURE") return "ARCHITECTURE";
  if (v === "QA" || v === "TEST" || v === "TESTING") return "QA";
  if (v === "INFRA" || v === "DEVOPS" || v === "OPS") return "INFRA";
  return "SERVICE";
}

function normalizeComplexity(value?: string): TaskComplexity {
  const v = (value || "").toUpperCase();
  if (v === "HIGH") return "HIGH";
  if (v === "MEDIUM") return "MEDIUM";
  return "SIMPLE";
}

function normalizeTask(raw: Partial<GeneratedTask> & { acceptanceCriteria?: string[] | string }, idx: number): GeneratedTask {
  const estimatedHours = raw.estimatedHours ?? Math.max(3, Math.min(24, Number(raw.taskPrice || 0) / HOURLY_RATE || 6));
  const taskPrice = raw.taskPrice ?? estimatedHours * HOURLY_RATE;

  return {
    id: raw.id || `task-${idx + 1}`,
    title: raw.title || `Tarea ${idx + 1}`,
    description: raw.description || "Detalle pendiente",
    category: normalizeCategory(raw.category as string),
    complexity: normalizeComplexity(raw.complexity as string),
    priority: raw.priority ?? idx + 1,
    estimatedHours,
    hourlyRate: HOURLY_RATE,
    taskPrice,
    columnId: raw.columnId || "todo",
    layer: raw.layer || normalizeCategory(raw.category as string),
    price: taskPrice,
    developerNetPrice: taskPrice,
    acceptanceCriteria: normalizeAcceptanceCriteria(raw.acceptanceCriteria, raw.title || `Tarea ${idx + 1}`),
  };
}

export async function generateProjectPlanWithOpenAI(
  input: Pick<ProjectEstimation, "projectTitle" | "projectDescription" | "ownerEmail">
): Promise<ProjectEstimation> {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error("OpenAI client not configured");
  }

  const completion = await client.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.3,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Eres un arquitecto de software senior. Devuelve SOLO JSON con stack inferido, stack recomendado y un backlog de tareas técnicas. Si hay NFTs/marketplace/staking incluye Solidity, Hardhat, OpenZeppelin, Ethers y wallet (MetaMask/Wagmi/RainbowKit). No incluyas CI/CD ni Docker salvo justificación clara.",
      },
      {
        role: "user",
        content: `Genera plan para el proyecto. Campos obligatorios: projectTitle, projectDescription, ownerEmail, tasks (8-30 items con title, description, category, complexity, priority, estimatedHours, hourlyRate, taskPrice, acceptanceCriteria 3-7 items), stackInferred, stackInferredReasons, stackSignals, stackRecommended, stackMissing si aplica, stackConfidence (0-1).\nEntrada:\nTitle: ${input.projectTitle}\nDescription: ${input.projectDescription}\nOwner: ${input.ownerEmail}`,
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("Respuesta vacía de OpenAI");

  const parsed = extractJSON(content) as OpenAIPlan;

  const normalizedTasks: GeneratedTask[] = (parsed.tasks || [])
    .slice(0, 40)
    .map((t, idx) => normalizeTask(t, idx));

  const totalHours = normalizedTasks.reduce((sum, task) => sum + task.estimatedHours, 0);
  const totalTasksPrice = normalizedTasks.reduce((sum, task) => sum + task.taskPrice, 0);
  const platformFeeAmount = (totalTasksPrice * PLATFORM_FEE_PERCENT) / 100;

  const stackConfidence = typeof parsed.stackConfidence === "number" ? parsed.stackConfidence : 0.72;

  const stackInference: StackInference = {
    inferred: parsed.stackInferred,
    suggested: parsed.stackRecommended,
    missing: parsed.stackMissing,
    reasons: parsed.stackInferredReasons || [],
    signals: parsed.stackSignals,
    confidence: stackConfidence,
  };

  return {
    projectTitle: parsed.projectTitle || input.projectTitle,
    projectDescription: parsed.projectDescription || input.projectDescription,
    ownerEmail: parsed.ownerEmail || input.ownerEmail,
    tasks: normalizedTasks,
    totalHours,
    totalTasksPrice,
    platformFeePercent: PLATFORM_FEE_PERCENT,
    platformFeeAmount,
    grandTotalClientCost: totalTasksPrice + platformFeeAmount,
    stackInferred: parsed.stackInferred,
    stackInferredReasons: parsed.stackInferredReasons || [],
    stackSignals: parsed.stackSignals,
    stackRecommended: parsed.stackRecommended,
    recommendedStack: parsed.stackRecommended,
    stackMissing: parsed.stackMissing,
    stackInference,
    stackSource: "OPENAI",
    stackConfidence,
    openaiMeta: {
      model: DEFAULT_MODEL,
      responseId: completion.id,
      source: "chat.completions",
    },
  };
}
