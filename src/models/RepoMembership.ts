import { Schema, Document, model, Types } from "mongoose";

export type RepoMembershipStatus = "NOT_INVITED" | "INVITED" | "ACCEPTED";

export interface RepoMembershipDocument extends Document {
  projectId: Types.ObjectId;
  userEmail: string;
  githubLogin: string;
  status: RepoMembershipStatus;
  invitedAt?: Date | null;
  acceptedAt?: Date | null;
  lastCheckedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const RepoMembershipSchema = new Schema<RepoMembershipDocument>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "CommunityProject", required: true },
    userEmail: { type: String, required: true, index: true },
    githubLogin: { type: String, required: true },
    status: { type: String, enum: ["NOT_INVITED", "INVITED", "ACCEPTED"], default: "NOT_INVITED" },
    invitedAt: { type: Date },
    acceptedAt: { type: Date },
    lastCheckedAt: { type: Date },
  },
  { timestamps: true }
);

RepoMembershipSchema.index({ projectId: 1, userEmail: 1 }, { unique: true });

export const RepoMembership = model<RepoMembershipDocument>(
  "RepoMembership",
  RepoMembershipSchema,
  "repomemberships"
);
