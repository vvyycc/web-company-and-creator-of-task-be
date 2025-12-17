// src/models/CommunityProject.ts
import { Schema, model, Document } from 'mongoose';
import { TaskDocument } from './Task';

export interface ProjectEstimation {
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
  tasks: TaskDocument[];
  totalHours: number;
  totalTasksPrice: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  generatorServiceFee: number;
  grandTotalClientCost: number;
}

export interface CommunityProjectDocument extends Document {
  ownerEmail: string;
  projectTitle: string;
  projectDescription: string;
  estimation: ProjectEstimation;
  isPublished: boolean;
  projectRepo?: {
    provider: 'github';
    repoId: number;
    owner: string;
    repoName: string;
    fullName: string;
    htmlUrl: string;
    private: boolean;
    createdAt: Date;
  } | null;
  repoSlug?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CommunityProjectSchema = new Schema<CommunityProjectDocument>(
  {
    ownerEmail: { type: String, required: true },
    projectTitle: { type: String, required: true },
    projectDescription: { type: String, required: true },
    // Usamos Mixed para no pelear con el tipado de subdocumentos
    estimation: { type: Schema.Types.Mixed, required: true },
    isPublished: { type: Boolean, default: true },
    projectRepo: {
      type: new Schema({
        provider: { type: String, default: 'github' },
        repoId: Number,
        owner: String,
        repoName: String,
        fullName: String,
        htmlUrl: String,
        private: Boolean,
        createdAt: Date,
      }, { _id: false }),
      default: null,
    },
    repoSlug: { type: String },
  },
  { timestamps: true }
);

export const CommunityProject = model<CommunityProjectDocument>(
  'CommunityProject',
  CommunityProjectSchema,
  'communityprojects' // usa la colección que ya tienes
);
