import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PairingResult } from "@agent-flow/contracts";

export interface WorkerConfig {
  databaseUrl: string;
  apiUrl: string;
  identityFile: string;
  name: string;
  repos: Record<string, string>;
  pollMs: number;
}

export async function readWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<WorkerConfig> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for the durable worker.");
  const api = new URL(env.AGENT_FLOW_API_URL ?? "http://127.0.0.1:3001");
  if (
    !["http:", "https:"].includes(api.protocol) ||
    api.username ||
    api.password
  ) {
    throw new Error(
      "AGENT_FLOW_API_URL must be an HTTP(S) origin without credentials.",
    );
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(api.hostname)) {
    throw new Error("This local MVP connects only to a loopback API.");
  }
  const rawRepos: unknown = JSON.parse(env.AGENT_FLOW_REPOS ?? "{}");
  if (!rawRepos || typeof rawRepos !== "object" || Array.isArray(rawRepos)) {
    throw new Error(
      "AGENT_FLOW_REPOS must be a JSON object of repo keys to absolute paths.",
    );
  }
  const repos: Record<string, string> = {};
  for (const [key, path] of Object.entries(rawRepos)) {
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(key) ||
      typeof path !== "string" ||
      !isAbsolute(path)
    ) {
      throw new Error(
        "Repository configuration requires a simple key and an absolute local path.",
      );
    }
    repos[key] = await realpath(path);
  }
  const pollMs = Number(env.AGENT_FLOW_POLL_MS ?? "2000");
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
    throw new Error("AGENT_FLOW_POLL_MS must be 100–60000 milliseconds.");
  }
  return {
    databaseUrl,
    apiUrl: api.origin,
    identityFile: resolve(
      env.AGENT_FLOW_IDENTITY_FILE ?? `${homedir()}/.agent-flow/worker.json`,
    ),
    name: env.AGENT_FLOW_WORKER_NAME ?? "Local Herdr worker",
    repos,
    pollMs,
  };
}

export interface WorkerIdentity extends PairingResult {
  apiUrl: string;
}

export async function loadIdentity(
  config: WorkerConfig,
): Promise<WorkerIdentity> {
  const value = JSON.parse(
    await readFile(config.identityFile, "utf8"),
  ) as Partial<WorkerIdentity>;
  if (!value.workerId || !value.token || value.apiUrl !== config.apiUrl) {
    throw new Error(
      "Worker identity is missing or belongs to another API. Pair this worker first.",
    );
  }
  return value as WorkerIdentity;
}

export async function pairWorker(
  config: WorkerConfig,
  code: string,
): Promise<WorkerIdentity> {
  // Never overwrite an identity that may still own live resources.
  try {
    await readFile(config.identityFile);
    throw new Error(
      "An identity already exists; use that identity or a new AGENT_FLOW_IDENTITY_FILE.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetch(`${config.apiUrl}/api/workers/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: config.name }),
  });
  if (!response.ok)
    throw new Error(
      `Pairing failed (${response.status}): ${await response.text()}`,
    );
  const result = (await response.json()) as PairingResult;
  if (typeof result.workerId !== "string" || typeof result.token !== "string") {
    throw new Error("Pairing returned an invalid identity.");
  }
  const identity = { ...result, apiUrl: config.apiUrl };
  await mkdir(dirname(config.identityFile), { recursive: true, mode: 0o700 });
  const temporary = `${config.identityFile}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, config.identityFile);
  return identity;
}
