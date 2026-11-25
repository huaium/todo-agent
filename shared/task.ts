export interface Task {
  id: string;
  title: string;
  done: boolean;
  [field: string]: unknown;
}

export const priorities = ["低", "中", "高"] as const;
export const efforts = ["小", "中", "大"] as const;
