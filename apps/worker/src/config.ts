import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { PairingResult } from "@agent-flow/contracts";
import { pairingRecovery, reserveIdentityFile } from "./identity-file";

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
  const repos: Record<string, string> = Object.create(null);
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

function isPairingResult(value: unknown): value is PairingResult {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "workerId" in value &&
    typeof value.workerId === "string" &&
    value.workerId.trim().length > 0 &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.trim().length > 0
  );
}

export async function loadIdentity(
  config: WorkerConfig,
): Promise<WorkerIdentity> {
  const contents = await readFile(config.identityFile, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(
      "Worker identity contains invalid JSON. Restore a valid identity file before starting.",
    );
  }
  if (!isPairingResult(value)) {
    throw new Error(
      "Worker identity must be an object with non-empty string workerId and token fields.",
    );
  }
  if (!("apiUrl" in value) || value.apiUrl !== config.apiUrl) {
    throw new Error(
      "Worker identity apiUrl is missing or belongs to another API. Use the matching identity and API.",
    );
  }
  return { workerId: value.workerId, token: value.token, apiUrl: value.apiUrl };
}

export async function pairWorker(
  config: WorkerConfig,
  code: string,
): Promise<WorkerIdentity> {
  const reservation = await reserveIdentityFile(
    config.identityFile,
    config.apiUrl,
  );
  let stage = "Pairing request failed; the remote outcome is unknown.";
  let published = false;
  try {
    const response = await fetch(`${config.apiUrl}/api/workers/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: config.name }),
      redirect: "error",
    });
    if (!response.ok) {
      stage = `Pairing failed (HTTP ${response.status}); the remote outcome needs confirmation.`;
      await response.body?.cancel();
      throw new Error(stage);
    }
    stage =
      "Pairing returned an invalid identity; the code may already be consumed.";
    const result: unknown = await response.json();
    if (!isPairingResult(result)) throw new Error(stage);
    const identity = {
      workerId: result.workerId,
      token: result.token,
      apiUrl: config.apiUrl,
    };
    stage =
      "Remote pairing succeeded, but saving or publishing the identity failed.";
    await reservation.publish(`${JSON.stringify(identity, null, 2)}\n`);
    published = true;
    await reservation.cleanup();
    return identity;
  } catch (error) {
    // Never echo an HTTP body, JSON parser excerpt, fetch error or credential.
    const conflict =
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? " An identity now exists and was not overwritten."
        : "";
    throw new Error(
      published
        ? `Identity saved to ${config.identityFile}, but pairing cleanup failed. Use the saved identity; do not pair again. ${pairingRecovery(reservation.lock, reservation.temporary)}`
        : `${stage}${conflict} ${pairingRecovery(reservation.lock, reservation.temporary)}`,
    );
  } finally {
    await reservation.close();
  }
}
