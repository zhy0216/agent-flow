import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadIdentity,
  pairWorker,
  readWorkerConfig,
  type WorkerConfig,
} from "../src/config";

let directory: string;
const servers: ReturnType<typeof Bun.serve>[] = [];
const fixtureToken = "fixture-token-never-log";
const fixtureCode = "fixture-one-time-code";
const paired = { workerId: "fixture-worker", token: fixtureToken };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "agent-flow-config-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  await rm(directory, { recursive: true, force: true });
});

function fixtureServer(
  fetch: (request: Request) => Response | Promise<Response>,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server.url.origin;
}

function config(apiUrl = "http://127.0.0.1:3001"): WorkerConfig {
  return {
    databaseUrl: "unused-fixture-database",
    apiUrl,
    identityFile: join(directory, "private", "nested", "worker.json"),
    name: "Fixture worker",
    repos: Object.create(null),
    pollMs: 100,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain(fixtureToken);
    expect(message).not.toContain(fixtureCode);
    return message;
  }
  throw new Error("Expected the operation to reject.");
}

async function record(current: WorkerConfig) {
  const contents = await readFile(
    `${current.identityFile}.pairing.lock`,
    "utf8",
  );
  expect(contents).not.toContain(fixtureToken);
  expect(contents).not.toContain(fixtureCode);
  return JSON.parse(contents) as {
    pid: number;
    hostname: string;
    startedAt: string;
    temporary: string;
    identityFile: string;
    apiUrl: string;
    recovery: string;
  };
}

describe("atomic worker pairing", () => {
  test("a concurrent attempt sends no request, publishes once, and uses private modes", async () => {
    const received = deferred();
    const release = deferred();
    let requests = 0;
    const current = config(
      fixtureServer(async (request) => {
        requests++;
        expect(new URL(request.url).pathname).toBe("/api/workers/pair");
        expect(request.method).toBe("POST");
        expect(await request.json()).toEqual({
          code: fixtureCode,
          name: current.name,
        });
        received.resolve();
        if (requests === 1) await release.promise;
        return Response.json({
          ...paired,
          workerId: `fixture-worker-${requests}`,
        });
      }),
    );
    const winner = pairWorker(current, fixtureCode);
    await received.promise;
    try {
      const owner = await record(current);
      expect(owner.pid).toBe(process.pid);
      expect(owner.hostname).toBe(hostname());
      expect(Number.isNaN(Date.parse(owner.startedAt))).toBe(false);
      expect(owner.apiUrl).toBe(current.apiUrl);
      expect(owner.identityFile).toBe(current.identityFile);
      expect((await stat(owner.temporary)).mode & 0o777).toBe(0o600);
      expect(
        (await stat(`${current.identityFile}.pairing.lock`)).mode & 0o777,
      ).toBe(0o600);
      const originalRecord = await readFile(
        `${current.identityFile}.pairing.lock`,
      );
      expect(await rejection(pairWorker(current, fixtureCode))).toContain(
        "pairing attempt already owns",
      );
      expect(await readFile(`${current.identityFile}.pairing.lock`)).toEqual(
        originalRecord,
      );
      expect(requests).toBe(1);
    } finally {
      release.resolve();
    }
    const identity = await winner;
    expect(identity.workerId).toBe("fixture-worker-1");
    expect(await loadIdentity(current)).toEqual(identity);
    expect((await readdir(dirname(current.identityFile))).sort()).toEqual([
      "worker.json",
    ]);
    expect((await stat(current.identityFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(current.identityFile))).mode & 0o777).toBe(
      0o700,
    );
    expect(
      (await stat(dirname(dirname(current.identityFile)))).mode & 0o777,
    ).toBe(0o700);
    expect(await rejection(pairWorker(current, fixtureCode))).toContain(
      "already exists",
    );
    expect(requests).toBe(1);
  });

  test("an existing identity stays byte-for-byte intact and unrelated temporary files survive", async () => {
    let requests = 0;
    const current = config(
      fixtureServer(() => {
        requests++;
        return Response.json(paired);
      }),
    );
    await mkdir(dirname(current.identityFile), {
      recursive: true,
      mode: 0o755,
    });
    const existingMode = (await stat(dirname(current.identityFile))).mode;
    const bytes = new Uint8Array([0, 255, 32, 13, 10, 128]);
    await writeFile(current.identityFile, bytes, { mode: 0o640 });
    const unrelated = `${current.identityFile}.other-attempt.tmp`;
    await writeFile(unrelated, "another attempt");
    expect(await rejection(pairWorker(current, fixtureCode))).toContain(
      "already exists",
    );
    expect(new Uint8Array(await readFile(current.identityFile))).toEqual(bytes);
    expect((await stat(current.identityFile)).mode & 0o777).toBe(0o640);
    expect((await stat(dirname(current.identityFile))).mode).toBe(existingMode);
    expect(await readFile(unrelated, "utf8")).toBe("another attempt");
    expect((await readdir(dirname(current.identityFile))).sort()).toEqual([
      "worker.json",
      "worker.json.other-attempt.tmp",
    ]);
    expect(requests).toBe(0);
  });

  test("an existing dangling symlink is never followed or replaced", async () => {
    let requests = 0;
    const current = config(
      fixtureServer(() => {
        requests++;
        return Response.json(paired);
      }),
    );
    await mkdir(dirname(current.identityFile), { recursive: true });
    const missing = join(directory, "missing");
    await symlink(missing, current.identityFile);
    expect(await rejection(pairWorker(current, fixtureCode))).toContain(
      "already exists",
    );
    expect((await lstat(current.identityFile)).isSymbolicLink()).toBe(true);
    expect(await Bun.file(missing).exists()).toBe(false);
    expect(requests).toBe(0);
  });

  test("a target appearing after dispatch is not overwritten and the paired identity can be recovered without a request", async () => {
    let requests = 0;
    const existing = "another identity\n";
    const current = config(
      fixtureServer(async () => {
        requests++;
        await writeFile(current.identityFile, existing, { flag: "wx" });
        return Response.json(paired);
      }),
    );
    const message = await rejection(pairWorker(current, fixtureCode));
    expect(message).toContain("Remote pairing succeeded");
    expect(message).toContain("was not overwritten");
    expect(message).toContain("Do not retry pairing");
    expect(await readFile(current.identityFile, "utf8")).toBe(existing);
    const owner = await record(current);
    expect(message).toContain(owner.temporary);
    const recoveryConfig = { ...current, identityFile: owner.temporary };
    expect(await loadIdentity(recoveryConfig)).toEqual({
      ...paired,
      apiUrl: current.apiUrl,
    });
    expect((await stat(owner.temporary)).mode & 0o777).toBe(0o600);
    // Follow the recorded recovery procedure at an unused fixture path.
    const recovered = join(directory, "recovered.json");
    await link(owner.temporary, recovered);
    expect(await loadIdentity({ ...current, identityFile: recovered })).toEqual(
      await loadIdentity(recoveryConfig),
    );
    expect(await rejection(pairWorker(current, fixtureCode))).toContain(
      "pairing attempt already owns",
    );
    expect(requests).toBe(1);
  });

  test.each([
    [
      "HTTP failure",
      () => new Response(`${fixtureToken} ${fixtureCode}`, { status: 500 }),
      "HTTP 500",
    ],
    [
      "broken JSON",
      () => new Response(`{"token":"${fixtureToken}",broken`),
      "invalid identity",
    ],
    ["null", () => Response.json(null), "invalid identity"],
    ["array", () => Response.json([paired]), "invalid identity"],
    [
      "empty token",
      () => Response.json({ ...paired, token: " " }),
      "invalid identity",
    ],
    [
      "numeric workerId",
      () => Response.json({ ...paired, workerId: 123 }),
      "invalid identity",
    ],
  ] as const)(
    "%s retains recovery evidence and rejects a retry without exposing credentials",
    async (_label, response, expected) => {
      let requests = 0;
      const current = config(
        fixtureServer(() => {
          requests++;
          return response();
        }),
      );
      const message = await rejection(pairWorker(current, fixtureCode));
      expect(message).toContain(expected);
      const owner = await record(current);
      expect(message).toContain(owner.temporary);
      expect(await Bun.file(current.identityFile).exists()).toBe(false);
      expect(await rejection(pairWorker(current, fixtureCode))).toContain(
        "pairing attempt already owns",
      );
      expect(requests).toBe(1);
    },
  );

  test("preparation failure sends no request and leaves no owned lock", async () => {
    const current = config();
    await writeFile(join(directory, "private"), "blocks mkdir");
    expect(await rejection(pairWorker(current, fixtureCode))).toBeTruthy();
    expect(await readdir(directory)).toEqual(["private"]);
    await rm(join(directory, "private"));
    current.apiUrl = fixtureServer(() => Response.json(paired));
    expect(await pairWorker(current, fixtureCode)).toEqual({
      ...paired,
      apiUrl: current.apiUrl,
    });
  });

  test("a replaced lock is preserved and the response remains recoverable", async () => {
    const current = config(
      fixtureServer(async () => {
        await rename(
          `${current.identityFile}.pairing.lock`,
          `${current.identityFile}.original-lock`,
        );
        await writeFile(
          `${current.identityFile}.pairing.lock`,
          "another owner",
          { flag: "wx" },
        );
        return Response.json(paired);
      }),
    );
    expect(await rejection(pairWorker(current, fixtureCode))).toContain(
      "Remote pairing succeeded",
    );
    expect(await readFile(`${current.identityFile}.pairing.lock`, "utf8")).toBe(
      "another owner",
    );
    const owner = JSON.parse(
      await readFile(`${current.identityFile}.original-lock`, "utf8"),
    ) as { temporary: string };
    expect(
      await loadIdentity({ ...current, identityFile: owner.temporary }),
    ).toEqual({ ...paired, apiUrl: current.apiUrl });
    expect(await Bun.file(current.identityFile).exists()).toBe(false);
  });

  test("SIGKILL during a request leaves a diagnostic lock that a new process cannot steal", async () => {
    const received = deferred();
    const release = deferred();
    let requests = 0;
    const current = config(
      fixtureServer(async () => {
        requests++;
        received.resolve();
        await release.promise;
        return Response.json(paired);
      }),
    );
    const modulePath = new URL("../src/config.ts", import.meta.url).href;
    const script = `import { pairWorker } from ${JSON.stringify(modulePath)};
      try { await pairWorker(${JSON.stringify(current)}, ${JSON.stringify(fixtureCode)}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      await Promise.race([
        received.promise,
        child.exited.then(() => {
          throw new Error("Pairing fixture exited before dispatch.");
        }),
      ]);
      expect((await record(current)).pid).toBe(child.pid);
      // This PID comes directly from the fixture process created by this test.
      child.kill("SIGKILL");
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const savedRecord = await readFile(
        `${current.identityFile}.pairing.lock`,
      );
      expect(await rejection(pairWorker(current, fixtureCode))).toContain(
        "pairing attempt already owns",
      );
      expect(await readFile(`${current.identityFile}.pairing.lock`)).toEqual(
        savedRecord,
      );
      expect(requests).toBe(1);
      expect(await Bun.file(current.identityFile).exists()).toBe(false);
      expect(await stdout).not.toContain(fixtureToken);
      expect(await stderr).not.toContain(fixtureCode);
    } finally {
      release.resolve();
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("two independent processes racing to pair consume only one fixture request", async () => {
    let requests = 0;
    const current = config(
      fixtureServer(() => {
        requests++;
        return Response.json({
          ...paired,
          workerId: `fixture-worker-${requests}`,
        });
      }),
    );
    const modulePath = new URL("../src/config.ts", import.meta.url).href;
    const script = `import { pairWorker } from ${JSON.stringify(modulePath)};
      try { await pairWorker(${JSON.stringify(current)}, ${JSON.stringify(fixtureCode)}); }
      catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const children = [0, 1].map(() =>
      Bun.spawn([process.execPath, "--eval", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = children.map((child) =>
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
    );
    try {
      expect(
        (await Promise.all(children.map((child) => child.exited))).sort(),
      ).toEqual([0, 1]);
      expect(requests).toBe(1);
      expect(await loadIdentity(current)).toEqual({
        ...paired,
        workerId: "fixture-worker-1",
        apiUrl: current.apiUrl,
      });
      expect(await readdir(dirname(current.identityFile))).toEqual([
        "worker.json",
      ]);
      for (const output of await Promise.all(outputs)) {
        expect(output.join("\n")).not.toContain(fixtureToken);
        expect(output.join("\n")).not.toContain(fixtureCode);
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
    }
  });
});

describe("worker identity validation", () => {
  test.each([
    ["null", "null", "object"],
    ["array", JSON.stringify([paired]), "object"],
    ["string", JSON.stringify(fixtureToken), "object"],
    ["missing fields", "{}", "non-empty string"],
    [
      "numeric workerId",
      JSON.stringify({ ...paired, workerId: 1 }),
      "non-empty string",
    ],
    [
      "object token",
      JSON.stringify({ ...paired, token: { secret: fixtureToken } }),
      "non-empty string",
    ],
    [
      "boolean token",
      JSON.stringify({ ...paired, token: true }),
      "non-empty string",
    ],
    [
      "blank token",
      JSON.stringify({ ...paired, token: " \n" }),
      "non-empty string",
    ],
    [
      "empty workerId",
      JSON.stringify({ ...paired, workerId: "" }),
      "non-empty string",
    ],
    ["missing apiUrl", JSON.stringify(paired), "apiUrl"],
    ["numeric apiUrl", JSON.stringify({ ...paired, apiUrl: 1 }), "apiUrl"],
    [
      "other API",
      JSON.stringify({ ...paired, apiUrl: "http://localhost:3001" }),
      "another API",
    ],
    ["invalid JSON", `{"token":"${fixtureToken}",oops`, "invalid JSON"],
  ] as const)(
    "rejects %s without echoing credential contents",
    async (_label, contents, expected) => {
      const current = config();
      await mkdir(dirname(current.identityFile), { recursive: true });
      await writeFile(current.identityFile, contents);
      expect(await rejection(loadIdentity(current))).toContain(expected);
    },
  );

  test("existing valid identity fields remain unchanged", async () => {
    const current = config();
    const identity = { ...paired, apiUrl: current.apiUrl };
    await mkdir(dirname(current.identityFile), { recursive: true });
    await writeFile(
      current.identityFile,
      `${JSON.stringify(identity, null, 2)}\n`,
    );
    expect(await loadIdentity(current)).toEqual(identity);
  });
});

describe("worker repo dictionary and configuration boundaries", () => {
  function env(repos: string = "{}") {
    return {
      DATABASE_URL: "unused-fixture-database",
      AGENT_FLOW_IDENTITY_FILE: join(directory, "unused.json"),
      AGENT_FLOW_REPOS: repos,
    };
  }

  test("prototype-shaped names are own mappings and unconfigured inherited names are absent", async () => {
    const alias = join(directory, "alias");
    const repo = join(directory, "repo");
    await mkdir(repo);
    await symlink(repo, alias);
    const entries = Object.fromEntries(
      [
        "constructor",
        "__proto__",
        "toString",
        "hasOwnProperty",
        "normal.repo-1",
      ].map((key) => [key, alias]),
    );
    const current = await readWorkerConfig(env(JSON.stringify(entries)));
    expect(Object.getPrototypeOf(current.repos)).toBe(null);
    const canonical = await realpath(repo);
    for (const key of Object.keys(entries)) {
      expect(Object.hasOwn(current.repos, key)).toBe(true);
      expect(current.repos[key]).toBe(canonical);
    }
    expect(current.repos.valueOf).toBeUndefined();
    expect(current.repos.unconfigured).toBeUndefined();
    const empty = await readWorkerConfig(env());
    for (const key of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "missing",
    ]) {
      expect(Object.hasOwn(empty.repos, key)).toBe(false);
      expect(empty.repos[key]).toBeUndefined();
    }
  });

  test.each([
    "null",
    "[]",
    '"repo"',
    '{"bad key":"/tmp"}',
    '{"repo":"relative"}',
    '{"repo":1}',
  ])("rejects invalid repo configuration %s", async (repos) => {
    await expect(readWorkerConfig(env(repos))).rejects.toThrow();
  });

  test("a configured repository must exist", async () => {
    await expect(
      readWorkerConfig(
        env(JSON.stringify({ repo: join(directory, "missing") })),
      ),
    ).rejects.toThrow("ENOENT");
  });

  test.each([
    "http://example.com",
    "ftp://127.0.0.1",
    "http://user:pass@localhost",
  ])("keeps API restriction for %s", async (apiUrl) => {
    await expect(
      readWorkerConfig({ ...env(), AGENT_FLOW_API_URL: apiUrl }),
    ).rejects.toThrow();
  });

  test.each(["99", "60001", "100.5", "NaN", "Infinity"])(
    "rejects invalid pollMs %s",
    async (pollMs) => {
      await expect(
        readWorkerConfig({ ...env(), AGENT_FLOW_POLL_MS: pollMs }),
      ).rejects.toThrow("AGENT_FLOW_POLL_MS");
    },
  );

  test("retains loopback origins, poll limits, and required database configuration", async () => {
    for (const apiUrl of [
      "http://127.0.0.1:3001",
      "http://localhost:3001",
      "https://[::1]:3001",
    ]) {
      for (const pollMs of [100, 60_000]) {
        const current = await readWorkerConfig({
          ...env(),
          AGENT_FLOW_API_URL: apiUrl,
          AGENT_FLOW_POLL_MS: String(pollMs),
        });
        expect(current.apiUrl).toBe(apiUrl);
        expect(current.pollMs).toBe(pollMs);
      }
    }
    await expect(
      readWorkerConfig({ ...env(), DATABASE_URL: " " }),
    ).rejects.toThrow("DATABASE_URL");
  });
});
