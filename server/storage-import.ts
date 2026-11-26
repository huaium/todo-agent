import { resolve } from "node:path";
import { importLegacyDatabase } from "./database.ts";

const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.trim() === "")
  throw new Error("Usage: npm run storage:import -- [directory]");
const directory = resolve(args[0] ?? "data");
importLegacyDatabase(directory);
console.log("Imported planner data into " + resolve(directory, "planner.sqlite"));
