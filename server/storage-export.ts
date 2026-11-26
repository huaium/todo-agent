import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDatabase } from "./database.ts";

export function exportStorage(directory: string, destination: string) {
  const target = resolve(destination);
  const staging = mkdtempSync(join(dirname(target), ".planner-export-"));
  try {
    const file = join(staging, "planner.sqlite");
    closeSync(openSync(file, "wx", 0o600));
    const db = openDatabase(directory, true);
    try {
      db.prepare("VACUUM INTO ?").run(file);
    } finally {
      db.close();
    }
    openDatabase(staging, true).close();
    // Reserve the new name exclusively, including against another export to the same target.
    mkdirSync(target, { mode: 0o700 });
    try {
      renameSync(staging, target);
    } catch (error) {
      rmdirSync(target);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0].trim())
    throw new Error("Usage: npm run storage:export -- <new-directory>");
  exportStorage("data", args[0]);
  console.log("Verified planner and chat export saved in " + resolve(args[0]));
}
