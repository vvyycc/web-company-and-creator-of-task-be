import { Schema, Types } from 'mongoose';

export interface TaskDocument {
  _id: Types.ObjectId;
  title: string;
  description: string;
  priority: number;
  price: number;
  layer: 'ARCHITECTURE' | 'MODEL' | 'SERVICE' | 'VIEW';
  columnId: 'todo' | 'doing' | 'done';
  status: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'REJECTED';
  assignedToEmail?: string | null;
  assignedAt?: Date | null;
  acceptanceCriteria: string;
  verificationType: 'MANUAL' | 'BACKEND' | 'FRONTEND' | 'WEB3' | 'SOLIDITY';
  verificationStatus: 'NOT_SUBMITTED' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
  verificationNotes: string;
  verifiedByEmail?: string | null;
  verifiedAt?: Date | null;
}

export type TaskStatus = TaskDocument['status'];

export const TaskSchema = new Schema<TaskDocument>(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    priority: { type: Number, required: true },
    price: { type: Number, required: true },
    layer: {
      type: String,
      enum: ['ARCHITECTURE', 'MODEL', 'SERVICE', 'VIEW'],
      required: true,
    },
    columnId: { type: String, enum: ['todo', 'doing', 'done'], default: 'todo' },
    status: {
      type: String,
      enum: ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'REJECTED'],
      default: 'TODO',
    },
    assignedToEmail: { type: String, default: null },
    assignedAt: { type: Date, default: null },
    acceptanceCriteria: { type: String, default: '' },
    verificationType: {
      type: String,
      enum: ['MANUAL', 'BACKEND', 'FRONTEND', 'WEB3', 'SOLIDITY'],
      default: 'MANUAL',
    },
    verificationStatus: {
      type: String,
      enum: ['NOT_SUBMITTED', 'SUBMITTED', 'APPROVED', 'REJECTED'],
      default: 'NOT_SUBMITTED',
    },
    verificationNotes: { type: String, default: '' },
    verifiedByEmail: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
  },
  { _id: true }
);
