import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./store.js";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: npm run import -- "C:\\path\\to\\summer-2026.csv"');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataPath = process.env.DATA_FILE || path.join(rootDir, "data", "db.json");

const store = createStore(dataPath);
await store.init();

const csv = await fs.readFile(path.resolve(csvPath), "utf8");
const result = await store.importCsv(csv, {
  updateExisting: true,
  overwriteSchedule: true
});

console.log(`Import complete: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`);
