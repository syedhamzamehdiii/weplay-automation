import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import {
  DeviceFarmClient,
  ListArtifactsCommand,
  ListJobsCommand
} from "@aws-sdk/client-device-farm";

const root = fileURLToPath(new URL("../../../", import.meta.url));
loadDotenv({ path: path.join(root, ".env") });

const runArn = process.argv[2];
if (!runArn) {
  console.error("usage: fetch-df-artifacts.mjs <runArn>");
  process.exit(1);
}

const client = new DeviceFarmClient({
  region: process.env.AWS_REGION || "us-west-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const jobs = await client.send(new ListJobsCommand({ arn: runArn }));
const runId = runArn.split("/").pop() || "run";
const outDir = path.join(root, "tmp-df-artifacts", `run-${runId}`);
await mkdir(outDir, { recursive: true });

const summary = (jobs.jobs ?? []).map((job) => ({
  name: job.name,
  status: job.status,
  result: job.result,
  device: job.device?.name,
  arn: job.arn
}));
console.log(JSON.stringify({ jobs: summary }, null, 2));

async function listAll(arn, type) {
  const artifacts = [];
  let nextToken;
  do {
    const response = await client.send(new ListArtifactsCommand({ arn, type, nextToken }));
    artifacts.push(...(response.artifacts ?? []));
    nextToken = response.nextToken;
  } while (nextToken);
  return artifacts;
}

const arns = [runArn, ...(jobs.jobs ?? []).map((job) => job.arn).filter(Boolean)];
const wanted = [];
for (const arn of arns) {
  for (const type of ["FILE", "LOG", "SCREENSHOT"]) {
    const artifacts = await listAll(arn, type);
    for (const artifact of artifacts) {
      const name = `${artifact.name ?? "artifact"}.${artifact.extension ?? "bin"}`;
      wanted.push({ name, type: artifact.type ?? type, url: artifact.url, arn: artifact.arn, category: type });
    }
  }
}

await writeFile(path.join(outDir, "index.json"), JSON.stringify(wanted, null, 2));
const interesting = wanted.filter((row) => {
  const n = row.name.toLowerCase();
  return (
    n.includes("test spec") ||
    n.includes("testspec") ||
    n.includes("provision") ||
    n.includes("customer") ||
    n.includes("logcat") ||
    n.includes("page_source") ||
    n.endsWith(".txt") ||
    n.includes("appium") ||
    n.includes("inspect") ||
    n.endsWith(".json") ||
    n.endsWith(".zip") ||
    n.includes("video") ||
    n.endsWith(".mp4") ||
    n.endsWith(".webm")
  );
});

for (const row of interesting) {
  if (!row.url) {
    continue;
  }
  const response = await fetch(row.url);
  if (!response.ok) {
    console.error("download failed", row.name, response.status);
    continue;
  }
  const body = Buffer.from(await response.arrayBuffer());
  const safe = row.name.replace(/[^\w.-]+/g, "_").slice(0, 120);
  await writeFile(path.join(outDir, safe), body);
  console.log("saved", safe, body.length);
}
