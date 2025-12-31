import OpenAI from "openai";
import { HOURLY_RATE } from "../config/pricing";
import {
  GenerateTasksRequestBody,
  GeneratedAcceptanceTask,
  StackAnalysis,
  StructuredStack,
  TaskGenerationResult,
} from "../types/generateTasks";

const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type RawTask = Omit<GeneratedAcceptanceTask, "price">;

interface RawAiResponse extends StackAnalysis {
  tasks: RawTask[];
}

const STACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["frontend", "backend", "database", "smartContracts", "infra", "testing", "devops", "notes"],
  properties: {
    frontend: { type: "array", items: { type: "string" } },
    backend: { type: "array", items: { type: "string" } },
    database: { type: "array", items: { type: "string" } },
    smartContracts: { type: "array", items: { type: "string" } },
    infra: { type: "array", items: { type: "string" } },
    testing: { type: "array", items: { type: "string" } },
    devops: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
};

const RESPONSE_SCHEMA = {
  name: "TaskGenerationResponse",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["tasks", "stackInference", "recommendedStack", "stackSource", "stackConfidence"],
    properties: {
      tasks: {
        type: "array",
        minItems: 4,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description", "category", "complexity", "acceptanceCriteria", "estimatedHours"],
          properties: {
            title: { type: "string", minLength: 6 },
            description: { type: "string", minLength: 12 },
            category: {
              type: "string",
              enum: ["ARCHITECTURE", "MODEL", "SERVICE", "VIEW", "INFRA", "QA"],
            },
            complexity: { type: "string", enum: ["SIMPLE", "MEDIUM", "HIGH"] },
            acceptanceCriteria: {
              type: "array",
              minItems: 3,
              maxItems: 7,
              items: { type: "string", minLength: 8 },
            },
            estimatedHours: { type: "number", minimum: 1 },
          },
        },
      },
      stackInference: STACK_SCHEMA,
      recommendedStack: STACK_SCHEMA,
      stackSource: { type: "string", const: "OPENAI" },
      stackConfidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  strict: true,
} as const;

function computePricing(tasks: RawTask[]): GeneratedAcceptanceTask[] {
  return tasks.map((task) => {
    const price = Math.round(task.estimatedHours * HOURLY_RATE * 100) / 100;
    return { ...task, price };
  });
}

function normalizeStack(stack: StructuredStack): StructuredStack {
  return {
    frontend: stack.frontend || [],
    backend: stack.backend || [],
    database: stack.database || [],
    smartContracts: stack.smartContracts || [],
    infra: stack.infra || [],
    testing: stack.testing || [],
    devops: stack.devops || [],
    notes: stack.notes || [],
  };
}

export async function generateTasksFromOpenAI(input: GenerateTasksRequestBody): Promise<TaskGenerationResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const completion = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
    messages: [
      {
        role: "system",
        content: [
          "Eres un generador de backlog técnico para MVPs. Debes responder únicamente en JSON válido conforme al esquema.",
          "Reglas clave:",
          "- Sin heurísticas locales ni supuestos adicionales: todo proviene de OpenAI.",
          "- Las tareas deben ser técnicas, accionables y tener complexity SIMPLE | MEDIUM | HIGH.",
          "- Cada tarea debe incluir criterios de aceptación técnicos (3–7) verificables.",
          "- Si el proyecto es Web3/NFT, smartContracts debe incluir Solidity, Hardhat y OpenZeppelin.",
          "- El stack siempre incluye frontend, backend, database, smartContracts, infra, testing, devops, notes (arrays).",
          "- Infra y DevOps solo si son necesarios para el MVP.",
          "- Devuelve stackSource=\"OPENAI\".",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Título del proyecto: ${input.title}`,
          `Descripción del proyecto: ${input.description}`,
          "Genera backlog, inferencia de stack y recomendaciones faltantes para un MVP completo.",
        ].join("\n"),
      },
    ],
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI no devolvió contenido");
  }

  const parsed: RawAiResponse = JSON.parse(content);
  const tasks = computePricing(parsed.tasks);

  const totalHours = tasks.reduce((sum, task) => sum + task.estimatedHours, 0);
  const totalPrice = tasks.reduce((sum, task) => sum + task.price, 0);

  return {
    tasks,
    stackInference: normalizeStack(parsed.stackInference),
    recommendedStack: normalizeStack(parsed.recommendedStack),
    stackSource: parsed.stackSource,
    stackConfidence: parsed.stackConfidence,
    totalHours,
    totalPrice,
    hourlyRate: HOURLY_RATE,
  };
}
