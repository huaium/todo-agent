import type { PlannerTask } from "../shared/planner.ts";
export { detailsSchema, type TaskDetails } from "../shared/task-details.ts";
export class PlannerError extends Error {}
export class TaskEditConflict extends Error {
  readonly current: PlannerTask;
  constructor(current: PlannerTask) {
    super("任务已在其他位置更改。");
    this.current = current;
  }
}
