import { Schema, Document, model } from "mongoose";

export interface GithubAccountDocument extends Document {
  userEmail: string;
  githubUserId: number;
  githubLogin: string;
  accessToken: string;
  scopes?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const GithubAccountSchema = new Schema<GithubAccountDocument>(
  {
    userEmail: { type: String, required: true, index: true, unique: true },
    githubUserId: { type: Number, required: true, unique: true },
    githubLogin: { type: String, required: true },
    accessToken: { type: String, required: true },
    scopes: { type: [String], default: [] },
  },
  { timestamps: true }
);

export const GithubAccount = model<GithubAccountDocument>(
  "GithubAccount",
  GithubAccountSchema,
  "githubaccounts"
);
