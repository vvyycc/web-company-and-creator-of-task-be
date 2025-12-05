import { Schema, Types } from 'mongoose';

export interface TaskDocument {
  _id: Types.ObjectId;
  title: string;
  description: string;
  priority: number;
  price: number;
  layer: 'ARCHITECTURE' | 'MODEL' | 'SERVICE' | 'VIEW';
  columnId: 'todo' | 'doing' | 'done';
}

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
  },
  { _id: true }
);
