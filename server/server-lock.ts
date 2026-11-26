import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function acquireServerLock(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Keep the write lock on a separate file so planner writes and exports can proceed.
  const lock = new DatabaseSync(join(directory, "server-lock.sqlite"));
  try {
    lock.exec("BEGIN IMMEDIATE");
    return lock;
  } catch (error) {
    lock.close();
    if (error instanceof Error && "errcode" in error && error.errcode === 5)
      throw new Error("Another planner server is already using " + directory, { cause: error });
    throw error;
  }
}
