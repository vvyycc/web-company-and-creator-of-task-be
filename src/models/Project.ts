import { Schema, model, Document } from 'mongoose';
import { TaskDocument, TaskSchema } from './Task';
import { TaskCategory, TaskComplexity, ColumnId } from './taskTypes';



export interface GeneratedTask {
  id: string;
  title: string;
  description: string;
  category: TaskCategory;
  complexity: TaskComplexity;
  priority: number;
  estimatedHours: number;
  hourlyRate: number;
  taskPrice: number;

  // para el board tipo Trello
  columnId: ColumnId;

  // alias legacy
  layer?: TaskCategory;
  price?: number;
  developerNetPrice?: number;
}

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
  projectDurationHours?: number;
  criticalPathTaskIds?: string[];
}
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
