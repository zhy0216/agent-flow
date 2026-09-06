import type { CommandResult, CommandRunner } from "./adapter";

// Limits count raw UTF-8 bytes per stream, excluding the truncation notice.
export const COMMAND_OUTPUT_LIMITS = { stdout: 2_000_000, stderr: 200_000 };
export const COMMAND_CLEANUP_GRACE_MS = 500;

/** A fixed allocation, even for a single chunk larger than the entire budget. */
export class OutputTail {
  private readonly bytes: Uint8Array;
  private cursor = 0;
  private size = 0;
  private total = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("Output limit must be a positive integer of bytes.");
    this.bytes = new Uint8Array(limit);
  }

  append(chunk: Uint8Array) {
    this.total += chunk.byteLength;
    if (chunk.byteLength >= this.limit) {
      this.bytes.set(chunk.subarray(-this.limit));
      this.cursor = 0;
      this.size = this.limit;
      return;
    }
    const first = Math.min(chunk.byteLength, this.limit - this.cursor);
    this.bytes.set(chunk.subarray(0, first), this.cursor);
    this.bytes.set(chunk.subarray(first), 0);
    this.cursor = (this.cursor + chunk.byteLength) % this.limit;
    this.size = Math.min(this.limit, this.size + chunk.byteLength);
  }

  text(stream: "stdout" | "stderr") {
    const ordered = new Uint8Array(this.size);
    const start = (this.cursor + this.limit - this.size) % this.limit;
    const first = Math.min(this.size, this.limit - start);
    ordered.set(this.bytes.subarray(start, start + first));
    ordered.set(this.bytes.subarray(0, this.size - first), first);
    let offset = 0;
    // Discard only a code point cut by eviction. Chunk boundaries do not affect
    // decoding; genuinely invalid/incomplete source UTF-8 uses replacement chars.
    if (this.total > this.size) {
      while (
        offset < ordered.length &&
        ((ordered[offset] ?? 0) & 0xc0) === 0x80
      )
        offset++;
    }
    const omitted = this.total - this.size + offset;
    const notice = omitted
      ? `[${stream} truncated: ${omitted} bytes omitted; retained ${this.size - offset} bytes, limit ${this.limit} UTF-8 bytes]\n`
      : "";
    return notice + new TextDecoder().decode(ordered.subarray(offset));
  }
}

// Run trusted supervision code in a new POSIX session (Bun detached=true).
// It stays alive after the command exits, pinning its PID/PGID until the pipes
// drain or cleanup is requested. Only this still-live leader signals -its OWN
// PID. The worker never signals a cached PID/PGID after a leader may have exited.
// No shell, process-table scan, Herdr pane, or caller process group is involved.
// The private IPC channel is not inherited by the command. Disconnect and a
// local deadline also clean up if the worker disappears. A descendant that
// deliberately creates another session escapes this group; pipe waiting is
// still bounded, and incomplete cleanup requires review, never an unsafe kill.
const supervisorSource = `
const { closeSync } = require("node:fs");
let started = false;
const stop = () => {
  try { process.kill(-process.pid, "SIGKILL"); }
  catch (error) { process.send?.({ error: "Owned process group cleanup failed: " + error.message }); process.exit(1); }
};
process.on("disconnect", stop);
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);
process.on("message", (request) => {
  if (request === "stop") return stop();
  if (started) return;
  started = true;
  setTimeout(stop, request.timeoutMs + ${COMMAND_CLEANUP_GRACE_MS});
  try {
    const child = Bun.spawn([request.command, ...request.args], {
      cwd: request.cwd, env: request.env,
      stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    // Keep only IPC alive: EOF now depends on the command and its descendants.
    closeSync(1);
    closeSync(2);
    child.exited.then(
      exitCode => process.send?.({ exitCode }),
      error => process.send?.({ error: "Command exit observation failed: " + error.message }),
    );
  } catch (error) {
    process.send?.({ error: "Could not start command: " + error.message });
  }
});
process.send({ ready: process.pid });
`;

export class CommandRunError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommandRunError";
  }
}

function capture(stream: ReadableStream<Uint8Array>, tail: OutputTail) {
  let reader: ReturnType<typeof stream.getReader> | undefined;
  const done = (async () => {
    try {
      const acquired = stream.getReader();
      reader = acquired;
      for (;;) {
        const { done, value } = await acquired.read();
        if (done) return;
        tail.append(value);
      }
    } finally {
      reader?.releaseLock();
    }
  })();
  return {
    done,
    cancel: () => {
      // Cancellation itself can reject or stall on a failed stream. It must not
      // extend the cleanup deadline or become an unhandled rejection.
      void reader?.cancel().catch(() => {});
    },
  };
}

/** Executes argv directly. Timeout includes startup, exit and both pipe EOFs.
 * Even confirmed process cleanup cannot prove an external mutation's outcome. */
export const runCommand: CommandRunner = async (request) => {
  const startedAt = performance.now();
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Owned command process groups require macOS or Linux.");
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > 2_147_483_647 - COMMAND_CLEANUP_GRACE_MS
  )
    throw new Error(
      "Command timeout must fit a positive 32-bit millisecond timer.",
    );

  const stdout = new OutputTail(COMMAND_OUTPUT_LIMITS.stdout);
  const stderr = new OutputTail(COMMAND_OUTPUT_LIMITS.stderr);
  const status = Promise.withResolvers<number>();
  const deadline = Promise.withResolvers<void>();
  let exitCode: number | undefined;
  let timedOut = false;
  let stopping = false;
  let failure: unknown;
  const child = Bun.spawn([process.execPath, "--eval", supervisorSource], {
    // Supervision must not load code/config from the command's working directory
    // or environment. Those belong exclusively to the command, sent over IPC.
    cwd: "/",
    env: {},
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    lazy: true,
    ipc(message, supervisor) {
      try {
        if (message?.ready === supervisor.pid) {
          if (!stopping) supervisor.send(request);
          else supervisor.send("stop");
        } else if (typeof message?.error === "string") {
          status.reject(new Error(message.error));
        } else if (Number.isInteger(message?.exitCode)) {
          exitCode = message.exitCode;
          status.resolve(message.exitCode);
        }
      } catch (cause) {
        status.reject(cause);
      }
    },
  });
  const streams = [
    capture(child.stdout, stdout),
    capture(child.stderr, stderr),
  ];
  const drained = Promise.all(streams.map((stream) => stream.done));
  const finished = Promise.all([status.promise, drained]);
  const exited = child.exited.then(() => {
    if (!stopping)
      throw new Error(
        "Command supervisor exited unexpectedly; subprocess state requires review.",
      );
  });
  const timer = setTimeout(
    () => {
      timedOut = true;
      deadline.resolve();
    },
    Math.max(0, request.timeoutMs - (performance.now() - startedAt)),
  );
  try {
    await Promise.race([finished, deadline.promise, exited]);
  } catch (cause) {
    failure = cause;
  } finally {
    clearTimeout(timer);
    stopping = true;
    try {
      child.send("stop");
    } catch (cause) {
      failure ??= cause;
    }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = await Promise.race([
      Promise.allSettled([exited, drained]).then(() => true),
      new Promise<false>((resolve) => {
        cleanupTimer = setTimeout(
          () => resolve(false),
          COMMAND_CLEANUP_GRACE_MS,
        );
      }),
    ]);
    clearTimeout(cleanupTimer);
    for (const stream of streams) stream.cancel();
    child.disconnect();
    child.unref();
    if (!cleanup)
      failure = new Error(
        "Command cleanup exceeded its grace period; subprocess state requires review.",
        { cause: failure },
      );
  }
  const result = {
    exitCode: exitCode ?? 137,
    stdout: stdout.text("stdout"),
    stderr: stderr.text("stderr"),
    timedOut,
  };
  if (failure)
    throw new CommandRunError(
      `Command execution could not be confirmed: ${failure instanceof Error ? failure.message : String(failure)}`,
      result,
      { cause: failure },
    );
  return result;
};
