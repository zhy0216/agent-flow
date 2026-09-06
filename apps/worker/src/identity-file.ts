import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

async function owns(path: string, handle: FileHandle): Promise<boolean> {
  const expected = await handle.stat();
  const actual = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return actual?.dev === expected.dev && actual?.ino === expected.ino;
}

async function removeOwned(path: string, handle: FileHandle) {
  if (!(await owns(path, handle))) {
    throw new Error(
      "Pairing file ownership changed; retained remaining files.",
    );
  }
  await unlink(path);
}

export function pairingRecovery(lock: string, temporary: string): string {
  return (
    `Pairing record: ${lock}. Recovery candidate: ${temporary}. ` +
    "Do not retry pairing or remove an active attempt's files. After confirming " +
    "the recorded process has stopped, validate the candidate's workerId, token " +
    "and apiUrl locally without printing credentials. If complete, use it as " +
    "AGENT_FLOW_IDENTITY_FILE to start the paired worker, or publish it with an " +
    "exclusive hard link to the intended identity path; never overwrite an identity. " +
    "If absent or incomplete, reconcile the possibly consumed code with the API " +
    "before removing this attempt's files and explicitly pairing with a fresh code."
  );
}

/** The exclusive lock is never stolen, including after a process dies: the
 * remote one-time request may already have committed. No PID-based auto-unlock.
 * A synced, complete candidate is linked into place without replacing a target.
 * Interrupted requests keep the lock/owner record and candidate for inspection.
 */
export async function reserveIdentityFile(
  identityFile: string,
  apiUrl: string,
) {
  await mkdir(dirname(identityFile), { recursive: true, mode: 0o700 });
  const lock = `${identityFile}.pairing.lock`;
  const temporary = `${identityFile}.${crypto.randomUUID()}.tmp`;
  let lockHandle: FileHandle;
  try {
    lockHandle = await open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `A pairing attempt already owns ${lock}. Do not retry or delete an active lock. ` +
          "Inspect its owner and recovery path after confirming the process has stopped. " +
          "An empty/incomplete record means preparation was interrupted; reconcile " +
          "the remote outcome before manually clearing the lock. Never overwrite an identity.",
      );
    }
    throw new Error(
      `Cannot reserve worker identity at ${lock}; no pairing request was sent.`,
    );
  }
  let temporaryHandle: FileHandle | undefined;
  const close = async () => {
    await temporaryHandle?.close();
    await lockHandle.close();
  };
  const cleanup = async () => {
    // Never recursively remove a directory or delete another attempt's files.
    if (temporaryHandle) await removeOwned(temporary, temporaryHandle);
    await removeOwned(lock, lockHandle);
  };
  try {
    const existing = await lstat(identityFile).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (existing) {
      throw new Error(
        "An identity already exists; use that identity or a new AGENT_FLOW_IDENTITY_FILE.",
      );
    }
    await lockHandle.writeFile(
      `${JSON.stringify(
        {
          version: 1,
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
          apiUrl,
          identityFile,
          temporary,
          // Persist before dispatch: even death during fetch must block a retry.
          outcome: "unknown; the pairing request may have consumed its code",
          recovery: pairingRecovery(lock, temporary),
        },
        null,
        2,
      )}\n`,
    );
    await lockHandle.sync();
    temporaryHandle = await open(temporary, "wx", 0o600);
  } catch (error) {
    try {
      await cleanup();
    } catch {
      throw new Error(
        `Identity preparation failed; no pairing request was sent. Cleanup incomplete. ${pairingRecovery(lock, temporary)}`,
      );
    } finally {
      await close();
    }
    throw error;
  }
  const candidate = temporaryHandle;
  return {
    lock,
    temporary,
    close,
    cleanup,
    async publish(contents: string) {
      await candidate.writeFile(contents);
      await candidate.sync();
      if (
        !(await owns(lock, lockHandle)) ||
        !(await owns(temporary, candidate))
      ) {
        throw new Error("Pairing file ownership changed.");
      }
      // rename() replaces existing identities. link() fails with EEXIST instead.
      await link(temporary, identityFile);
    },
  };
}
