// src/models/CommunityProject.ts
import { Schema, model, Document } from 'mongoose';
import { GeneratedTask } from './project';

export interface ProjectEstimation {
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
  tasks: GeneratedTask[];
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
  },
  { timestamps: true }
);

export const CommunityProject = model<CommunityProjectDocument>(
  'CommunityProject',
  CommunityProjectSchema,
  'communityprojects' // usa la colección que ya tienes
);
