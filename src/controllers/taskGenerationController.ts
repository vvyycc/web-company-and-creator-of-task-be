import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { HOURLY_RATE, PLATFORM_FEE_PERCENT } from "../config/pricing";
import { connectMongo } from "../db/mongo";
import { Subscription } from "../models/Subscription";
import {
  ColumnId,
  TaskCategory,
  TaskComplexity,
} from "../models/taskTypes";
import { generateProjectEstimationFromDescription } from "../services/generateTasks";
import { generateTasksFromOpenAI } from "../services/openai/openaiTaskGenerator";
import {
  EstimatedTask,
  GenerateTasksRequestBody,
  GenerateTasksResponseProject,
  RecommendedStack,
  StackInference,
  TaskVerificationType,
} from "../types/generateTasks";

const STACK_KEYS: Array<keyof RecommendedStack> = [
  "frontend",
  "backend",
  "smartContracts",
  "database",
  "infra",
  "testing",
  "devops",
  "notes",
];

const WEB3_KEYWORDS = [
  "nft",
  "web3",
  "erc721",
  "erc-721",
  "erc1155",
  "erc-1155",
  "erc20",
  "erc-20",
  "solidity",
  "hardhat",
];

const normalizeRecommendedStack = (
  stack?: Partial<RecommendedStack> | null,
  ensureWeb3SmartContracts = false
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

  STACK_KEYS.forEach((key) => {
    const value = stack?.[key];
    normalized[key] = Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];
  });

  if (ensureWeb3SmartContracts) {
    const required = ["Solidity", "Hardhat", "OpenZeppelin"];
    normalized.smartContracts = Array.from(
      new Set([...(normalized.smartContracts || []), ...required])
    );
  } else if (!ensureWeb3SmartContracts && !normalized.smartContracts.length) {
    normalized.smartContracts = [];
  }

  STACK_KEYS.forEach((key) => {
    if (!normalized[key]) normalized[key] = [];
  });

  return normalized;
};

const normalizeStackInference = (
  stackInference: Partial<StackInference> | null | undefined,
  isWeb3Project: boolean
): StackInference => {
  return {
    inferred: normalizeRecommendedStack(stackInference?.inferred, false),
    suggested: normalizeRecommendedStack(
      stackInference?.suggested,
      isWeb3Project
    ),
    reasons: Array.isArray(stackInference?.reasons)
      ? stackInference!.reasons.map((reason) => String(reason)).filter(Boolean)
      : [],
    confidence:
      typeof stackInference?.confidence === "number"
        ? stackInference.confidence
        : 0.65,
  };
};

const hasMeaningfulSuggestion = (stack: RecommendedStack): boolean => {
  return STACK_KEYS.some(
    (key) => Array.isArray(stack[key]) && stack[key].length > 0
  );
};

const categoryToLayer = (category?: TaskCategory): TaskCategory => {
  if (category === "QA") return "SERVICE";
  if (category === "INFRA") return "ARCHITECTURE";
  return category ?? "SERVICE";
};

const normalizeAcceptanceCriteria = (
  acceptanceCriteria?: string[] | string
): string[] => {
  if (Array.isArray(acceptanceCriteria)) {
    return acceptanceCriteria.map((item) => String(item)).filter(Boolean);
  }
  if (typeof acceptanceCriteria === "string" && acceptanceCriteria.trim()) {
    return acceptanceCriteria
      .split(/\r?\n|;|\./)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const normalizeVerificationType = (
  verificationType?: string
): TaskVerificationType => {
  const allowed: TaskVerificationType[] = [
    "MANUAL",
    "BACKEND",
    "FRONTEND",
    "WEB3",
    "SOLIDITY",
  ];
  const found = allowed.find(
    (type) => type.toLowerCase() === verificationType?.toLowerCase()
  );
  return found ?? "MANUAL";
};

type GenericTaskInput = Partial<EstimatedTask> & {
  acceptanceCriteria?: string | string[];
  columnId?: ColumnId;
};

const normalizeTasks = (
  tasks: GenericTaskInput[],
  isWeb3Project: boolean
): EstimatedTask[] => {
  return tasks.map((task, index) => {
    const estimatedHours =
      typeof task.estimatedHours === "number" && task.estimatedHours > 0
        ? task.estimatedHours
        : 4;
    const taskPrice = estimatedHours * HOURLY_RATE;

    const category =
      task.category && task.category !== ("undefined" as TaskCategory)
        ? task.category
        : task.layer ?? "SERVICE";

    const normalizedLayer = categoryToLayer(category);

    const acceptanceCriteria = normalizeAcceptanceCriteria(
      task.acceptanceCriteria
    );

    const verificationType =
      task.verificationType ??
      (isWeb3Project ? ("WEB3" as TaskVerificationType) : "MANUAL");

    return {
      id: task.id ?? randomUUID(),
      title: task.title ?? `Tarea ${index + 1}`,
      description: task.description ?? "",
      category,
      complexity: task.complexity ?? "MEDIUM",
      priority: task.priority ?? index + 1,
      estimatedHours,
      hourlyRate: HOURLY_RATE,
      taskPrice,
      acceptanceCriteria,
      verificationType: normalizeVerificationType(verificationType),
      columnId: "todo",
      layer: normalizedLayer,
      price: taskPrice,
      developerNetPrice: taskPrice,
    };
  });
};

const isWeb3 = (title: string, description: string): boolean => {
  const haystack = `${title} ${description}`.toLowerCase();
  return WEB3_KEYWORDS.some((keyword) => haystack.includes(keyword));
};

const buildHeuristicStack = (
  isWeb3Project: boolean
): RecommendedStack => {
  const baseStack: RecommendedStack = {
    frontend: ["Next.js", "React", "TypeScript"],
    backend: ["Node.js", "Express", "TypeScript"],
    smartContracts: [],
    database: ["PostgreSQL"],
    infra: ["Docker", "AWS"],
    testing: ["Jest"],
    devops: ["GitHub Actions"],
    notes: [],
  };

  return normalizeRecommendedStack(baseStack, isWeb3Project);
};

export const handleGenerateTasks = async (
  req: Request<unknown, unknown, GenerateTasksRequestBody>,
  res: Response<
    { project: GenerateTasksResponseProject } | { error: string; message?: string }
  >
) => {
  const { ownerEmail, projectTitle, projectDescription, title, description } =
    req.body || {};

  const resolvedTitle = projectTitle ?? title ?? "";
  const resolvedDescription = projectDescription ?? description ?? "";

  if (!ownerEmail || !resolvedTitle || !resolvedDescription) {
    return res.status(400).json({
      error:
        "ownerEmail, projectTitle y projectDescription (o title/description) son obligatorios",
    });
  }

  await connectMongo();
  const subscription = await Subscription.findOne({ email: ownerEmail });

  if (!subscription || subscription.status !== "active") {
    return res.status(402).json({
      error: "subscription_required",
      message:
        "Necesitas una suscripción activa de 30 €/mes para generar el troceado de tareas.",
    });
  }

  const isWeb3Project = isWeb3(resolvedTitle, resolvedDescription);

  let tasks: EstimatedTask[] = [];
  let stackInference: StackInference = {
    inferred: normalizeRecommendedStack({}, false),
    suggested: normalizeRecommendedStack({}, isWeb3Project),
    reasons: [],
    confidence: 0.65,
  };
  let recommendedStack: RecommendedStack = stackInference.suggested;
  let stackSource: "OPENAI" | "HEURISTIC" = "HEURISTIC";
  let openaiMeta: GenerateTasksResponseProject["openaiMeta"];

  try {
    const aiResult = await generateTasksFromOpenAI({
      projectTitle: resolvedTitle,
      projectDescription: resolvedDescription,
      ownerEmail,
    });

    const normalizedStackInference = normalizeStackInference(
      aiResult.stackInference,
      isWeb3Project
    );

    const normalizedRecommendedStack = normalizeRecommendedStack(
      aiResult.recommendedStack ?? normalizedStackInference.suggested,
      isWeb3Project
    );

    if (
      aiResult.tasks.length < 3 ||
      !hasMeaningfulSuggestion(normalizedStackInference.suggested) ||
      !hasMeaningfulSuggestion(normalizedRecommendedStack)
    ) {
      throw new Error("Respuesta de OpenAI incompleta o insuficiente");
    }

    tasks = normalizeTasks(aiResult.tasks, isWeb3Project);
    stackInference = normalizedStackInference;
    recommendedStack = normalizedRecommendedStack;
    stackSource = "OPENAI";
    openaiMeta = aiResult.openaiMeta;
  } catch (error) {
    console.warn("Falling back to heuristic generator:", error);

    const estimation = generateProjectEstimationFromDescription({
      ownerEmail,
      projectTitle: resolvedTitle,
      projectDescription: resolvedDescription,
    });

    tasks = normalizeTasks(estimation.tasks, isWeb3Project);

    const heuristicSuggested = buildHeuristicStack(isWeb3Project);
    stackInference = {
      inferred: normalizeRecommendedStack({}, false),
      suggested: heuristicSuggested,
      reasons: ["Fallback local: OpenAI no disponible o falló."],
      confidence: 0.55,
    };
    recommendedStack = heuristicSuggested;
    stackSource = "HEURISTIC";
  }

  const totalHours = tasks.reduce((sum, task) => sum + task.estimatedHours, 0);
  const totalTasksPrice = tasks.reduce((sum, task) => sum + task.taskPrice, 0);
  const platformFeeAmount = (totalTasksPrice * PLATFORM_FEE_PERCENT) / 100;

  const responseProject: GenerateTasksResponseProject = {
    ownerEmail,
    projectTitle: resolvedTitle,
    projectDescription: resolvedDescription,
    tasks,
    totalHours,
    totalTasksPrice,
    platformFeePercent: PLATFORM_FEE_PERCENT,
    platformFeeAmount,
    grandTotalClientCost: totalTasksPrice + platformFeeAmount,
    recommendedStack,
    stackInference,
    stackSource,
    stackConfidence: stackInference.confidence,
    ...(stackSource === "OPENAI" && openaiMeta ? { openaiMeta } : {}),
  };

  return res.status(200).json({ project: responseProject });
};
