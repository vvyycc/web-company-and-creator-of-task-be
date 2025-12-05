import { Schema, model, Document } from 'mongoose';
import { TaskDocument, TaskSchema } from './Task';

export interface ProjectDocument extends Document {
  ownerEmail: string;
  title: string;
  description: string;
  tasks: TaskDocument[];
  totalTasksPrice: number;
  generatorFee: number;
  platformFeePercent: number;
  published: boolean;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema = new Schema<ProjectDocument>(
  {
    ownerEmail: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    tasks: { type: [TaskSchema], default: [] },
    totalTasksPrice: { type: Number, required: true },
    generatorFee: { type: Number, required: true },
    platformFeePercent: { type: Number, required: true },
    published: { type: Boolean, default: false },
    publishedAt: { type: Date },
  },
  { timestamps: true }
);

export const ProjectModel = model<ProjectDocument>('Project', ProjectSchema);
