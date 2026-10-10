/** One-shot task selection shared by the header control and the root Taskboard. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TaskId } from '@deepseek-ai/dsh-api-taskboard-controller/client'

interface TaskboardNavigationState {
  requestedTaskId: TaskId | undefined
}

type TaskboardNavigationActions = {
  openTask: (draft: TaskboardNavigationState, taskId: TaskId) => void
  completeTaskRequest: (draft: TaskboardNavigationState, taskId: TaskId) => void
}

/**
 * Declare root-scoped navigation without persisting dialog selection.
 * @returns a handle shared by the task button and board registrations.
 */
export function createTaskboardNavigationStore(): EngineStoreHandle<TaskboardNavigationState, TaskboardNavigationActions> {
  return defineStore({
    init: (): TaskboardNavigationState => ({ requestedTaskId: undefined }),
    actions: {
      /**
       * Request details for a task in the authoritative snapshot.
       * @param draft - Navigation state.
       * @param taskId - Task to open.
       */
      openTask: (draft, taskId: TaskId) => { draft.requestedTaskId = taskId },
      /**
       * Consume a request without clearing a newer navigation.
       * @param draft - Navigation state.
       * @param taskId - Request handled by the board.
       */
      completeTaskRequest: (draft, taskId: TaskId) => {
        if (draft.requestedTaskId === taskId) draft.requestedTaskId = undefined
      },
    },
  })
}
