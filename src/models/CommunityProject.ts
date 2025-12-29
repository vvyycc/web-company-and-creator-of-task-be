// src/models/CommunityProject.ts
import { Schema, model, Document } from 'mongoose';
import { GeneratedTask } from './Project';
import { ProjectStack, DEFAULT_PROJECT_STACK } from './stack';

export interface ProjectEstimation {
  id?: string;
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
  tasks: GeneratedTask[];
  totalHours: number;
  totalTasksPrice: number;
  platformFeePercent: number;
  platformFeeAmount: number;
  generatorServiceFee?: number;
  generatorFee?: number;
  grandTotalClientCost: number;
  published?: boolean;
  stack?: ProjectStack;
}

export interface CommunityProjectDocument extends Document {
  ownerEmail: string;
  projectTitle: string;
  projectDescription: string;
  estimation: ProjectEstimation;
  stack?: ProjectStack;
  projectRepo?: {
    name?: string;
    fullName: string;
    htmlUrl: string;
  };
  isPublished: boolean;
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
    projectRepo: {
      name: { type: String },
      fullName: { type: String },
      htmlUrl: { type: String },
    },
    stack: { type: Schema.Types.Mixed, default: DEFAULT_PROJECT_STACK },
    isPublished: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const CommunityProject = model<CommunityProjectDocument>(
  'CommunityProject',
  CommunityProjectSchema,
  'communityprojects' // usa la colección que ya tienes
);
