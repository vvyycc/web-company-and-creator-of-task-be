import { Schema, model, Document } from "mongoose";

export interface UsageDocument extends Document {
  ownerEmail: string;
  month: string; // YYYY-MM
  tokensUsed: number;
  requests: number;
  updatedAt: Date;
}

const UsageSchema = new Schema<UsageDocument>(
  {
    ownerEmail: { type: String, required: true },
    month: { type: String, required: true },
    tokensUsed: { type: Number, default: 0 },
    requests: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

UsageSchema.index({ ownerEmail: 1, month: 1 }, { unique: true });

export const OpenAIUsage = model<UsageDocument>(
  "OpenAIUsage",
  UsageSchema,
  "openai_usage"
);
