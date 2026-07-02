import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDiscordService } from "./discordBot.js";
import { startLiveChartDailySync } from "./livechartSync.js";
import { startScheduler } from "./scheduler.js";
import { createStore } from "./store.js";
import { createWebApp } from "./web.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataPath = process.env.DATA_FILE || path.join(rootDir, "data", "db.json");

const store = createStore(dataPath);
await store.init();

const discord = createDiscordService(store);
discord.start().catch((error) => {
  console.error(`Discord startup failed: ${error.stack || error.message}`);
});

startScheduler(store, discord);
startLiveChartDailySync(store);

const app = createWebApp(store, discord, rootDir);
const port = Number.parseInt(process.env.WEB_PORT || "3000", 10);

app.listen(port, () => {
  console.log(`Web panel running at http://localhost:${port}`);
  console.log(`Data file: ${dataPath}`);
});
