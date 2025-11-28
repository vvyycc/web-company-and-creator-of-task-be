import { randomUUID } from 'crypto';

export type TaskLayer = 'ARCHITECTURE' | 'MODEL' | 'SERVICE' | 'VIEW';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: number;
  price: number;
  layer: TaskLayer;
}

export interface Project {
  id: string;
  ownerEmail: string;
  title: string;
  description: string;
  tasks: Task[];
  totalTasksPrice: number;
  generatorFee: number;
  platformFeePercent: number;
  published: boolean;
}

const projects = new Map<string, Project>();

export const createProject = (data: Omit<Project, 'id' | 'tasks'> & { tasks: Omit<Task, 'id'>[] }): Project => {
  const projectId = randomUUID();
  const tasks: Task[] = data.tasks.map((task) => ({ ...task, id: randomUUID(), projectId }));

  const project: Project = {
    ...data,
    id: projectId,
    tasks,
  };

  projects.set(projectId, project);
  return project;
};

export const getProject = (id: string): Project | undefined => projects.get(id);

export const publishProject = (id: string): Project | undefined => {
  const project = projects.get(id);
  if (!project) return undefined;

  project.published = true;
  projects.set(id, project);
  return project;
};
