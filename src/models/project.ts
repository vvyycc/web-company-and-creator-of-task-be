import { randomUUID } from 'crypto';

export type TaskComplexity = 'SIMPLE' | 'MEDIUM' | 'HIGH';

export type TaskCategory = 'ARCHITECTURE' | 'MODEL' | 'SERVICE' | 'VIEW' | 'INFRA' | 'QA';

export type ColumnId = 'todo' | 'doing' | 'done';

export interface GeneratedTask {
  id: string; // uuid
  title: string;
  description: string;
  category: TaskCategory; // ARCHITECTURE, MODEL, SERVICE, VIEW, ...
  complexity: TaskComplexity;
  priority: number; // 1, 2, 3, ...
  estimatedHours: number; // horas estimadas para esa tarea
  hourlyRate: number; // siempre 30
  taskPrice: number; // estimatedHours * hourlyRate
  // Alias legacy para mantener compatibilidad con integraciones previas.
  layer?: TaskCategory;
  price?: number;
  developerNetPrice?: number;
  columnId: ColumnId;
}

export interface ProjectEstimation {
  projectTitle: string;
  projectDescription: string;
  ownerEmail: string;
  tasks: GeneratedTask[];
  totalHours: number; // suma de estimatedHours
  totalTasksPrice: number; // suma de taskPrice
  platformFeePercent: number; // siempre 1
  platformFeeAmount: number; // totalTasksPrice * 0.01
  generatorServiceFee: number; // fijo 30 €
  grandTotalClientCost: number; // totalTasksPrice + platformFeeAmount + generatorServiceFee
  // Alias legacy para compatibilidad con clientes anteriores.
  title?: string;
  description?: string;
  generatorFee?: number;
}

export interface Project extends ProjectEstimation {
  id: string;
  published: boolean;
  publishedAt?: Date;
}

const projects = new Map<string, Project>();

type CreateProjectInput =
  Omit<
    Project,
    | 'id'
    | 'tasks'
    | 'platformFeeAmount'
    | 'grandTotalClientCost'
    | 'published'
    | 'publishedAt'
  > & {
    tasks: Omit<GeneratedTask, 'id'>[];
    platformFeeAmount: number;
    grandTotalClientCost: number;
    published?: boolean;
    publishedAt?: Date;
  };

export const createProject = (data: CreateProjectInput): Project => {
  const projectId = randomUUID();
  const tasks: GeneratedTask[] = data.tasks.map((task, index) => ({
    ...task,
    id: randomUUID(),
    priority: task.priority ?? index + 1,
    columnId: task.columnId ?? 'todo',
  }));

  const project: Project = {
    ...data,
    id: projectId,
    tasks,
    generatorFee: data.generatorFee ?? data.generatorServiceFee,
    published: data.published ?? false,
    publishedAt: data.publishedAt,
  };

  projects.set(projectId, project);
  return project;
};

export const getProject = (id: string): Project | undefined => projects.get(id);

export const publishProject = (id: string): Project | undefined => {
  const project = projects.get(id);
  if (!project) return undefined;

  project.published = true;
  project.publishedAt = new Date();
  projects.set(id, project);
  return project;
};

export const listProjects = (): Project[] => Array.from(projects.values());

export const listPublishedProjects = (): Project[] =>
  listProjects().filter((project) => project.published);

export const findTaskById = (
  taskId: string
):
  | {
      project: Project;
      task: GeneratedTask;
    }
  | undefined => {
  for (const project of projects.values()) {
    const task = project.tasks.find((t) => t.id === taskId);
    if (task) {
      return { project, task };
    }
  }
  return undefined;
};
