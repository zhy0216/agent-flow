export interface HerdrContext {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface HerdrDiagnostics {
  context: HerdrContext;
  version: string;
}

type HerdrEnvironment = Record<string, string | undefined>;

/** Keep caller context explicit; a future command must never use UI focus. */
export function requireHerdrContext(
  env: HerdrEnvironment = process.env,
): HerdrContext {
  if (env.HERDR_ENV !== "1") {
    throw new Error(
      "Start the Agent Flow worker inside a Herdr-managed pane (HERDR_ENV=1).",
    );
  }

  const workspaceId = env.HERDR_WORKSPACE_ID;
  const tabId = env.HERDR_TAB_ID;
  const paneId = env.HERDR_PANE_ID;
  if (!workspaceId || !tabId || !paneId) {
    throw new Error(
      "Herdr caller context is incomplete: workspace, tab, and pane IDs are required.",
    );
  }

  return { workspaceId, tabId, paneId };
}

/** Initialization only: this does not inspect or change another pane. */
export async function readHerdrDiagnostics(
  options: { timeoutMs?: number } = {},
): Promise<HerdrDiagnostics> {
  const context = requireHerdrContext();
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      "Herdr command timeout must be a positive integer in milliseconds.",
    );
  }

  let child: ReturnType<typeof spawnVersion>;
  try {
    child = spawnVersion();
  } catch (cause) {
    throw new Error(
      "Could not start herdr --version. Ensure the Herdr CLI is on PATH.",
      { cause },
    );
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) {
      throw new Error(`herdr --version timed out after ${timeoutMs}ms.`);
    }
    if (exitCode !== 0) {
      throw new Error(
        `herdr --version exited with ${exitCode}: ${stderr.trim().slice(0, 1_000)}`,
      );
    }
    const version = stdout.trim();
    if (!version) throw new Error("herdr --version returned an empty version.");
    return { context, version };
  } finally {
    clearTimeout(timer);
  }
}

function spawnVersion() {
  // argv is fixed and never evaluated by a shell. Mutations need a separate,
  // typed command API with owned resource IDs and replay reconciliation.
  return Bun.spawn(["herdr", "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}
