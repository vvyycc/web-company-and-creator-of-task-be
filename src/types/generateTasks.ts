export type StackCategoryList = string[];

export interface StructuredStack {
  frontend: StackCategoryList;
  backend: StackCategoryList;
  database: StackCategoryList;
  smartContracts: StackCategoryList;
  infra: StackCategoryList;
  testing: StackCategoryList;
  devops: StackCategoryList;
  notes: StackCategoryList;
}

export interface StackAnalysis {
  stackInference: StructuredStack;
  recommendedStack: StructuredStack;
  stackSource: "OPENAI";
  stackConfidence: number;
}

export interface GeneratedAcceptanceTask {
  title: string;
  description: string;
  category: "ARCHITECTURE" | "MODEL" | "SERVICE" | "VIEW" | "INFRA" | "QA";
  complexity: "SIMPLE" | "MEDIUM" | "HIGH";
  acceptanceCriteria: string[];
  estimatedHours: number;
  price: number;
}

export interface GenerateTasksRequestBody {
  title: string;
  description: string;
}

export interface TaskGenerationResult extends StackAnalysis {
  tasks: GeneratedAcceptanceTask[];
  totalHours: number;
  totalPrice: number;
  hourlyRate: number;
}
