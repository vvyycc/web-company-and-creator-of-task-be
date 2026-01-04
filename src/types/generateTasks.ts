import { ColumnId, TaskCategory, TaskComplexity } from "../models/taskTypes";

export interface GenerateTasksRequestBody {
  ownerEmail: string;
  projectTitle?: string;
  projectDescription?: string;
  title?: string;
  description?: string;
}

export type TaskVerificationType =
  | "MANUAL"
  | "BACKEND"
  | "FRONTEND"
  | "WEB3"
  | "SOLIDITY";

export interface RecommendedStack {
  frontend: string[];
  backend: string[];
  smartContracts: string[];
  database: string[];
  infra: string[];
  testing: string[];
  devops: string[];
  notes: string[];
}

export interface StackInference {
  inferred: RecommendedStack;
  suggested: RecommendedStack;
  reasons: string[];
  confidence: number;
}

export interface EstimatedTask {
  id: string;
  title: string;
  description: string;
  category: TaskCategory;
  complexity: TaskComplexity;
  priority: number;
  estimatedHours: number;
  hourlyRate: number;
  taskPrice: number;
  acceptanceCriteria: string[];
  verificationType: TaskVerificationType;
  columnId: ColumnId;
  layer: TaskCategory;
  price: number;
  developerNetPrice: number;
}

export interface StackMeta {
  recommendedStack: RecommendedStack;
  stackInference: StackInference;
  stackSource: "OPENAI" | "HEURISTIC";
  stackConfidence: number;
  openaiMeta?: {
    model: string;
    responseId: string;
  };
}

export interface GenerateTasksResponseProject extends StackMeta {
  ownerEmail: string;
  projectTitle: string;
  projectDescription: string;
  tasks: EstimatedTask[];
  totalHours: number;
  totalTasksPrice: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  grandTotalClientCost: number;
}
