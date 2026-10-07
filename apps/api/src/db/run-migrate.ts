import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@weplay/config";
import { createDb } from "./client.js";
import { migrate } from "./migrate.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
loadDotenv({ path: path.join(root, ".env") });

const env = loadEnv(process.env);
const db = createDb(env.DATABASE_URL);
await migrate(db);
await db.close();
console.log("Migrations applied.");
