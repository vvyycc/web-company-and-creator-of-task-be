import { createHash } from "crypto";
import { connectMongo } from "../db/mongo";
import { OpenAIUsage } from "../models/Usage";
import { RecommendedStack, StackSource } from "../models/recommendedStack";

type StackEnhancement = {
  items: string[];
  recommendedStack?: RecommendedStack;
  stackConfidence?: number;
  stackSource: StackSource;
};

const OPENAI_ENABLED = String(process.env.OPENAI_ENABLED || "").toLowerCase() === "true";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 320);
const OPENAI_MONTHLY_BUDGET = Number(
  process.env.OPENAI_MONTHLY_BUDGET_EUR ||
    process.env.OPENAI_MONTHLY_BUDGET_TOKENS ||
    120000
);
const OPENAI_TIMEOUT_MS = 12000;
const RATE_LIMIT_WINDOW_MS = 10_000;

const responseCache = new Map<string, StackEnhancement>();
const lastUserCall: Map<string, number> = new Map();

const isBudgetConfigured = () =>
  Number.isFinite(OPENAI_MONTHLY_BUDGET) && OPENAI_MONTHLY_BUDGET > 0;

const monthKey = () => {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}`;
};

const estimateTokens = (text: string) => Math.ceil((text || "").length / 4);

async function hasBudget(ownerEmail: string | undefined, estimatedTokens: number) {
  if (!ownerEmail || !isBudgetConfigured()) return true;
  await connectMongo();
  const usage = await OpenAIUsage.findOne({ ownerEmail, month: monthKey() });
  return !usage || usage.tokensUsed + estimatedTokens <= OPENAI_MONTHLY_BUDGET;
}

async function registerUsage(ownerEmail: string | undefined, tokensUsed: number) {
  if (!ownerEmail || !tokensUsed || !isBudgetConfigured()) return;
  await connectMongo();
  await OpenAIUsage.findOneAndUpdate(
    { ownerEmail, month: monthKey() },
    {
      $setOnInsert: {
        tokensUsed: 0,
        requests: 0,
      },
      $inc: { tokensUsed, requests: 1 },
      $set: { updatedAt: new Date() },
    },
    { upsert: true, new: true }
  );
}

function safeParseJson(content: string | undefined): Partial<StackEnhancement> | null {
  if (!content) return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isRateLimited(ownerEmail?: string) {
  if (!ownerEmail) return false;
  const last = lastUserCall.get(ownerEmail) || 0;
  const now = Date.now();
  if (now - last < RATE_LIMIT_WINDOW_MS) return true;
  lastUserCall.set(ownerEmail, now);
  return false;
}

export async function enhanceWorkItemsWithAI({
  title,
  description,
  ownerEmail,
}: {
  title: string;
  description: string;
  ownerEmail?: string;
}): Promise<StackEnhancement | null> {
  if (!OPENAI_ENABLED || !OPENAI_API_KEY) return null;
  if (isRateLimited(ownerEmail)) return null;

  const hash = createHash("sha256")
    .update(`${title}::${description}`)
    .digest("hex");

  if (responseCache.has(hash)) {
    return responseCache.get(hash) || null;
  }

  const estimatedTokens = estimateTokens(title + description) + OPENAI_MAX_OUTPUT_TOKENS;
  const budgetOk = await hasBudget(ownerEmail, estimatedTokens);
  if (!budgetOk) {
    // Budget guard: fall back to heuristics without throwing or blocking the request.
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: OPENAI_MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Eres un generador de tareas productivas. Devuelve JSON estricto con 'items' accionables (verbos como implementar, integrar, testear) y 'recommendedStack' opcional. No añadas texto fuera del JSON.",
          },
          {
            role: "user",
            content: [
              "Titulo:", title,
              "\nDescripcion:", description,
              "\nEstructura JSON esperada:",
              JSON.stringify(
                {
                  items: [
                    "Implementar API REST para pagos con Stripe",
                    "Configurar login con OAuth2",
                  ],
                  recommendedStack: {
                    frontend: ["React", "Vite", "TailwindCSS"],
                    backend: ["Node.js", "Express", "TypeScript"],
                    smartContracts: ["Hardhat", "Solidity"],
                    database: ["MongoDB", "Mongoose"],
                    infra: ["Docker", "GitHub Actions"],
                    testing: ["Jest", "Hardhat tests"],
                    devops: ["CI with caching"],
                    notes: ["Usar wagmi para wallets"],
                  },
                  stackConfidence: 0.72,
                },
                null,
                2
              ),
            ].join(" "),
          },
        ],
      }),
    });

    if (!response.ok) return null;

    const json = (await response.json()) as any;
    const content: string | undefined = json?.choices?.[0]?.message?.content;
    const parsed = safeParseJson(content);

    if (!parsed || !Array.isArray(parsed.items)) {
      return null;
    }

    const sanitizedItems = parsed.items
      .filter((item: unknown) => typeof item === "string")
      .map((item: string) => item.trim())
      .filter(Boolean)
      .slice(0, 20);

    const result: StackEnhancement = {
      items: sanitizedItems,
      recommendedStack: parsed.recommendedStack as RecommendedStack | undefined,
      stackConfidence: parsed.stackConfidence,
      stackSource: "OPENAI",
    };

    const completionTokensEstimate =
      estimateTokens(content || "") + OPENAI_MAX_OUTPUT_TOKENS;
    await registerUsage(ownerEmail, completionTokensEstimate);
    responseCache.set(hash, result);
    return result;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return null;
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
