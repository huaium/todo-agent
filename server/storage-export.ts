import { deepStrictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  openDatabase,
  readConversation,
  readLegacyFiles,
  readPlannerDocument,
  transaction,
} from "./database.ts";

export function exportStorage(directory: string, destination: string) {
  const db = openDatabase(directory, true);
  let snapshot;
  try {
    snapshot = transaction(
      db,
      () => ({ planner: readPlannerDocument(db), chat: readConversation(db) }),
      "DEFERRED",
    );
  } finally {
    db.close();
  }
  const target = resolve(destination);
  const staging = mkdtempSync(join(dirname(target), ".planner-export-"));
  try {
    const options = { flag: "wx", mode: 0o600, flush: true };
    writeFileSync(
      join(staging, "tasks.json"),
      JSON.stringify(snapshot.planner, null, 2) + "\n",
      options,
    );
    writeFileSync(join(staging, "tasks.json.chat.json"), JSON.stringify(snapshot.chat), options);
    deepStrictEqual(readLegacyFiles(staging), snapshot);
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
