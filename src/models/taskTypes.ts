// src/models/taskTypes.ts

export type TaskComplexity = 'SIMPLE' | 'MEDIUM' | 'HIGH';

export type TaskCategory =
  | 'ARCHITECTURE'
  | 'MODEL'
  | 'SERVICE'
  | 'VIEW'
  | 'INFRA'
  | 'QA';

// Columnas del tablero tipo Trello
export type ColumnId = 'todo' | 'doing' | 'done';
