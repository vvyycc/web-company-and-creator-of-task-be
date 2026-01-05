import { randomUUID } from "crypto";
import { HOURLY_RATE } from "../../config/pricing";
import { TaskCategory, TaskComplexity } from "../../models/taskTypes";
import {
  EstimatedTask,
  RecommendedStack,
  StackInference,
} from "../../types/generateTasks";

interface OpenAIResponse {
  tasks: Array<{
    title?: string;
    description?: string;
    category?: TaskCategory;
    layer?: TaskCategory;
    complexity?: TaskComplexity;
    estimatedHours?: number;
    acceptanceCriteria?: string[];
    verificationType?: EstimatedTask["verificationType"];
  }>;
  stackInference?: StackInference;
  recommendedStack?: RecommendedStack;
  meta?: {
    model?: string;
    responseId?: string;
  };
}

export interface GenerateTasksFromOpenAIInput {
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
}

export interface GenerateTasksFromOpenAIResult {
  tasks: EstimatedTask[];
  stackInference: StackInference;
  recommendedStack: RecommendedStack;
  openaiMeta: {
    model: string;
    responseId: string;
  };
}

type OpenAIConstructor = typeof import("openai").default;

const STACK_FIELDS: Array<keyof RecommendedStack> = [
  "frontend",
  "backend",
  "smartContracts",
  "database",
  "infra",
  "testing",
  "devops",
  "notes",
];

const categoryToLayer = (category?: TaskCategory): TaskCategory => {
  if (category === "QA") return "SERVICE";
  if (category === "INFRA") return "ARCHITECTURE";
  return category ?? "SERVICE";
};

const normalizeRecommendedStack = (
  stack?: Partial<RecommendedStack> | null
): RecommendedStack => {
  const normalized: RecommendedStack = {
    frontend: [],
    backend: [],
    smartContracts: [],
    database: [],
    infra: [],
    testing: [],
    devops: [],
    notes: [],
  };

  STACK_FIELDS.forEach((key) => {
    const value = stack?.[key];
    normalized[key] = Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];
  });

  return normalized;
};

const normalizeStackInference = (
  stackInference?: Partial<StackInference> | null
): StackInference => {
  return {
    inferred: normalizeRecommendedStack(stackInference?.inferred),
    suggested: normalizeRecommendedStack(stackInference?.suggested),
    reasons: Array.isArray(stackInference?.reasons)
      ? stackInference!.reasons.map((reason) => String(reason)).filter(Boolean)
      : [],
    confidence:
      typeof stackInference?.confidence === "number"
        ? stackInference.confidence
        : 0.65,
  };
};

const normalizeTasks = (tasks: OpenAIResponse["tasks"]): EstimatedTask[] =>
  tasks.map((task, index) => {
    const estimatedHours =
      typeof task.estimatedHours === "number" && task.estimatedHours > 0
        ? task.estimatedHours
        : 4;
    const taskPrice = estimatedHours * HOURLY_RATE;

    return {
      id: randomUUID(),
      title: task.title ?? `Tarea ${index + 1}`,
      description: task.description ?? "",
      category: task.category ?? "SERVICE",
      complexity: task.complexity ?? "MEDIUM",
      priority: index + 1,
      estimatedHours,
      hourlyRate: HOURLY_RATE,
      taskPrice,
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria)
        ? task.acceptanceCriteria.map((item) => String(item)).filter(Boolean)
        : [],
      verificationType: task.verificationType ?? "MANUAL",
      columnId: "todo",
      layer: categoryToLayer(task.layer ?? task.category),
      price: taskPrice,
      developerNetPrice: taskPrice,
    };
  });

const buildPrompt = (input: GenerateTasksFromOpenAIInput) => {
  const { projectTitle, projectDescription, ownerEmail } = input;
  return [
    "Eres un arquitecto de software senior. Genera tareas y stack para el proyecto en JSON válido.",
    "Devuelve exactamente este shape:",
    `{"tasks":[{"title":"","description":"","category":"","layer":"","complexity":"","estimatedHours":0,"acceptanceCriteria":[],"verificationType":""}],"stackInference":{"inferred":{"frontend":[],"backend":[],"smartContracts":[],"database":[],"infra":[],"testing":[],"devops":[],"notes":[]},"suggested":{"frontend":[],"backend":[],"smartContracts":[],"database":[],"infra":[],"testing":[],"devops":[],"notes":[]},"reasons":[],"confidence":0.7},"meta":{"model":"","responseId":""}}`,
    "Usa categorías/layers en {ARCHITECTURE, MODEL, SERVICE, VIEW, INFRA, QA}.",
    "estimatedHours debe ser un número > 0.",
    "Incluye al menos 5 tareas con acceptanceCriteria concretos y verificationType coherente (MANUAL|BACKEND|FRONTEND|WEB3|SOLIDITY).",
    `Contexto: ownerEmail=${ownerEmail}, title=${projectTitle}, description=${projectDescription}`,
  ].join("\n");
};

export const generateTasksFromOpenAI = async (
  input: GenerateTasksFromOpenAIInput
): Promise<GenerateTasksFromOpenAIResult> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY no configurada");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const { default: OpenAI } = (await import("openai")) as { default: OpenAIConstructor };
  const client = new OpenAI({ apiKey });

  const prompt = buildPrompt(input);

  const completion = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" } as any,
    messages: [
      {
        role: "system",
        content:
          "Eres un generador de tareas y stack que responde únicamente con JSON.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
  });

  const responseMessage = completion.choices[0]?.message?.content;
  if (!responseMessage) {
    throw new Error("Respuesta vacía de OpenAI");
  }

  let parsed: OpenAIResponse;
  try {
    parsed = JSON.parse(responseMessage) as OpenAIResponse;
  } catch (error) {
    throw new Error("JSON inválido devuelto por OpenAI");
  }

  if (!Array.isArray(parsed.tasks)) {
    throw new Error("La respuesta de OpenAI no incluye tasks válidas");
  }

  const tasks = normalizeTasks(parsed.tasks);
  const stackInference = normalizeStackInference(parsed.stackInference);
  const recommendedStack = normalizeRecommendedStack(
    parsed.recommendedStack ?? stackInference.suggested
  );

  return {
    tasks,
    stackInference,
    recommendedStack,
    openaiMeta: {
      model,
      responseId: completion.id,
    },
  };
};
