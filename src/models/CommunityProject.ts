// src/models/CommunityProject.ts
import { Schema, model, Document } from 'mongoose';
import { TaskDocument } from './Task';

export interface ProjectRepo {
  provider: "github";
  repoId: number;
  owner: string;
  repoName: string;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  createdAt: Date;
}

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
  projectRepo?: ProjectRepo;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CommunityProjectSchema = new Schema<CommunityProjectDocument>(
  {
    ownerEmail: { type: String, required: true },
    projectTitle: { type: String, required: true },
    projectDescription: { type: String, required: true },
    projectRepo: {
      type: new Schema<ProjectRepo>(
        {
          provider: { type: String, enum: ["github"], required: true },
          repoId: { type: Number, required: true },
          owner: { type: String, required: true },
          repoName: { type: String, required: true },
          fullName: { type: String, required: true },
          htmlUrl: { type: String, required: true },
          private: { type: Boolean, required: true },
          createdAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      required: false,
    },
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
