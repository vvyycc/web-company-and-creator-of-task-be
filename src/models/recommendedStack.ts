export type StackSource = "HEURISTIC" | "OPENAI";

export interface RecommendedStack {
  frontend: string[];
  backend: string[];
  smartContracts: string[];
  database: string[];
  infra: string[];
  testing: string[];
  devops: string[];
  notes?: string[];
}
