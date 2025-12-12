import { TaskDocument } from '../models/Task';
import { ColumnId } from '../models/taskTypes';
import { getIO } from '../socket';

export type TaskEventReason = 'column_changed' | 'status_changed' | 'assignment_changed';

export interface TaskRealtimeEvent {
  type: 'task_updated';
  reason: TaskEventReason;
  projectId: string;
  task: {
    id: string;
    columnId: ColumnId;
    status: TaskDocument['status'];
    assignedToEmail: string | null;
    assignedAt: Date | null;
  };
}

export const emitTaskEvent = (
  projectId: string,
  reason: TaskEventReason,
  task: TaskDocument
) => {
  const io = getIO();
  const payload: TaskRealtimeEvent = {
    type: 'task_updated',
    reason,
    projectId,
    task: {
      id: task._id.toString(),
      columnId: task.columnId,
      status: task.status,
      assignedToEmail: task.assignedToEmail ?? null,
      assignedAt: task.assignedAt ?? null,
    },
  };

  io.to(`project_${projectId}`).emit('task_updated', payload);
};
