import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRequest, runCommand } from "../src/adapter";
import {
  COMMAND_CLEANUP_GRACE_MS,
  COMMAND_OUTPUT_LIMITS,
  CommandRunError,
  OutputTail,
} from "../src/command-runner";

const fixturePath = join(import.meta.dir, "fixtures/command-process.ts");
const request = (args: string[], timeoutMs = 5_000): CommandRequest => ({
  command: "bun",
  args,
  cwd: process.cwd(),
  env: process.env,
  timeoutMs,
});
const encode = (value: string) => new TextEncoder().encode(value);

describe("bounded output tails", () => {
  test("empty, exact-limit, wrapping and a chunk larger than the budget", () => {
    const tail = new OutputTail(8);
    expect(tail.text("stdout")).toBe("");
    tail.append(encode("12345678"));
    expect(tail.text("stdout")).toBe("12345678");
    tail.append(encode("90"));
    expect(tail.text("stdout")).toBe(
      "[stdout truncated: 2 bytes omitted; retained 8 bytes, limit 8 UTF-8 bytes]\n34567890",
    );
    tail.append(encode("abcdefghijklmnopqrstuvwxyz"));
    expect(tail.text("stderr")).toBe(
      "[stderr truncated: 28 bytes omitted; retained 8 bytes, limit 8 UTF-8 bytes]\nstuvwxyz",
    );
  });

  test("UTF-8 chunks and eviction never split a retained character", () => {
    const tail = new OutputTail(8);
    for (const byte of encode("中🙂中文")) tail.append(new Uint8Array([byte]));
    expect(tail.text("stdout")).toBe(
      "[stdout truncated: 7 bytes omitted; retained 6 bytes, limit 8 UTF-8 bytes]\n中文",
    );
    const invalid = new OutputTail(20);
    invalid.append(new Uint8Array([0xff, 0xe4, 0xb8]));
    expect(invalid.text("stdout")).toBe("��");
  });
});

type Family = {
  parent: number;
  supervisor: number;
  child: number;
  childGroup: number;
};
async function familyAt(directory: string): Promise<Family | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, "family.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function requiredFamily(directory: string) {
  const family = await familyAt(directory);
  if (!family) throw new Error("Fixture did not record its processes");
  return family;
}

function alive(pid: number, group: number) {
  const observed = Bun.spawnSync(
    ["/bin/ps", "-o", "pgid=,stat=", "-p", String(pid)],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [pgid, state] = observed.stdout.toString().trim().split(/\s+/);
  // An adopted zombie is already exited; PID reuse in another group is not
  // evidence that our fixture survived. No signal is sent in either case.
  return Number(pgid) === group && !!state && !state.startsWith("Z");
}

async function expectExited(
  family: Family,
  graceMs = COMMAND_CLEANUP_GRACE_MS,
) {
  const resources = [
    [family.supervisor, family.supervisor],
    [family.parent, family.supervisor],
    [family.child, family.childGroup],
  ] as const;
  const deadline = performance.now() + graceMs;
  while (
    resources.some(([pid, group]) => alive(pid, group)) &&
    performance.now() < deadline
  )
    await Bun.sleep(20);
  for (const [pid, group] of resources) expect(alive(pid, group)).toBe(false);
}

async function withFamily(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "agent-flow-command-"));
  try {
    await run(directory);
  } finally {
    const family = await familyAt(directory);
    // Failed assertions also reclaim resources: finite fixtures naturally exit
    // in <= 2.5 seconds even when the very cleanup under test is broken.
    if (family) await expectExited(family, 5_000);
    await rm(directory, { recursive: true, force: true });
  }
}

describe("owned command runner", () => {
  test("small/empty output, nonzero exit, argv, cwd and environment", async () => {
    expect(await runCommand(request(["-e", "void 0"]))).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    const literal = '中文 "quote" $(false) ; `false`';
    const result = await runCommand({
      ...request([
        "-e",
        "console.log(JSON.stringify({cwd:process.cwd(),value:process.env.COMMAND_LITERAL})); console.error('failure'); process.exit(7)",
      ]),
      env: { ...process.env, COMMAND_LITERAL: literal },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: process.cwd(),
      value: literal,
    });
    expect(result).toMatchObject({
      exitCode: 7,
      stderr: "failure\n",
      timedOut: false,
    });
    const argv = await runCommand(
      request([
        "-e",
        "console.log(JSON.stringify(process.argv.slice(1)))",
        "--",
        literal,
        "",
      ]),
    );
    expect(JSON.parse(argv.stdout)).toEqual([literal, ""]);
  });

  test("simultaneously drains 12 MB from each stream and retains exact byte tails", async () => {
    const result = await runCommand(
      request([fixturePath, "output", "12000000"]),
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    for (const [stream, fill] of [
      ["stdout", "x"],
      ["stderr", "y"],
    ] as const) {
      const limit = COMMAND_OUTPUT_LIMITS[stream];
      const end = `${stream}-end:中文🙂`;
      const omitted = 12_000_000 + encode(end).length - limit;
      expect(result[stream]).toBe(
        `[${stream} truncated: ${omitted} bytes omitted; retained ${limit} bytes, limit ${limit} UTF-8 bytes]\n` +
          fill.repeat(limit - encode(end).length) +
          end,
      );
    }
  });

  test("real pipe reads preserve Chinese and emoji split across byte writes", async () => {
    expect(await runCommand(request([fixturePath, "utf8"]))).toEqual({
      exitCode: 0,
      stdout: "开始，中文🙂结束\n",
      stderr: "开始，中文🙂结束\n",
      timedOut: false,
    });
  });

  test("large output is still bounded when the command times out", async () => {
    const result = await runCommand(
      request([fixturePath, "output", "12000000", "hold"], 200),
    );
    expect(result).toMatchObject({ exitCode: 137, timedOut: true });
    for (const stream of ["stdout", "stderr"] as const) {
      expect(result[stream]).toStartWith(`[${stream} truncated:`);
      expect(result[stream]).toEndWith(`${stream}-end:中文🙂`);
      expect(encode(result[stream]).length).toBeLessThan(
        COMMAND_OUTPUT_LIMITS[stream] + 150,
      );
    }
  });

  test("detached supervision owns a distinct process group on macOS/Linux", async () => {
    const result = await runCommand(
      request([
        "-e",
        `
      const p = Bun.spawnSync(["/bin/ps", "-o", "pgid=", "-p", String(process.pid)], {stdout:"pipe"});
      console.log(JSON.stringify({supervisor:process.ppid, group:Number(p.stdout.toString().trim()), ipc:typeof process.send}));
    `,
      ]),
    );
    const { supervisor, group, ipc } = JSON.parse(result.stdout);
    expect(group).toBe(supervisor);
    expect(group).not.toBe(process.pid);
    expect(ipc).toBe("undefined");
    expect(alive(supervisor, group)).toBe(false);
  });

  for (const parentMode of ["wait", "exit"]) {
    test(`100ms timeout ends a 1500ms inherited-pipe child (parent ${parentMode})`, async () => {
      await withFamily(async (directory) => {
        const start = performance.now();
        const result = await runCommand(
          request([fixturePath, "family", directory, "1500", parentMode], 100),
        );
        // 500ms cleanup budget plus 500ms scheduling headroom, well before the
        // child's natural exit. This is not a machine-specific latency target.
        expect(performance.now() - start).toBeLessThan(
          100 + COMMAND_CLEANUP_GRACE_MS + 500,
        );
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(parentMode === "exit" ? 0 : 137);
        expect(result.stdout).toBe("parent-start\n");
        expect(result.stderr).toBe("parent-error\n");
        expect(await Bun.file(join(directory, "leaf-ready")).exists()).toBe(
          true,
        );
        expect(await Bun.file(join(directory, "natural-exit")).exists()).toBe(
          false,
        );
        await expectExited(await requiredFamily(directory));
      });
    });
  }

  test("a descendant can finish normally before the deadline after its parent exits", async () => {
    await withFamily(async (directory) => {
      const result = await runCommand(
        request([fixturePath, "family", directory, "80", "exit"]),
      );
      expect(result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(await Bun.file(join(directory, "natural-exit")).exists()).toBe(
        true,
      );
      await expectExited(await requiredFamily(directory));
    });
  });

  test("escaping the owned group cannot make pipe cleanup wait indefinitely", async () => {
    await withFamily(async (directory) => {
      const start = performance.now();
      let error: unknown;
      try {
        await runCommand(
          request(
            [fixturePath, "family", directory, "2500", "exit", "detached"],
            200,
          ),
        );
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(CommandRunError);
      expect(error).toMatchObject({ result: { timedOut: true, exitCode: 0 } });
      expect((error as Error).message).toContain("cleanup exceeded its grace");
      expect(performance.now() - start).toBeLessThan(
        200 + COMMAND_CLEANUP_GRACE_MS + 1_000,
      );
      const family = await requiredFamily(directory);
      expect(alive(family.child, family.childGroup)).toBe(true);
      // Finally waits for this finite escaped fixture; the runner never signals
      // this different group using a stale leader PID or process-name matching.
    });
  });

  for (const stream of ["stdout", "stderr"] as const) {
    test(`${stream} read failure cleans up the real process group and rejects`, async () => {
      await withFamily(async (directory) => {
        const spawn = Bun.spawn;
        const intercepted = spyOn(Bun, "spawn").mockImplementationOnce(((
          ...args: Parameters<typeof Bun.spawn>
        ) => {
          const child = spawn(...args);
          const reader = (
            child[stream] as ReadableStream<Uint8Array>
          ).getReader();
          const broken = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const chunk = await reader.read();
              if (chunk.value) controller.enqueue(chunk.value);
              controller.error(new Error(`${stream} fixture read failed`));
              await reader.cancel();
            },
          });
          Object.defineProperty(child, stream, { value: broken });
          return child;
        }) as typeof Bun.spawn);
        let pending: ReturnType<typeof runCommand>;
        try {
          pending = runCommand(
            request([fixturePath, "family", directory, "1500", "wait"]),
          );
        } finally {
          intercepted.mockRestore();
        }
        await expect(pending).rejects.toThrow(`${stream} fixture read failed`);
        await expectExited(await requiredFamily(directory));
      });
    });
  }

  test("spawn failure rejects and unsupported timeout values do not start a command", async () => {
    await expect(
      runCommand({ ...request([]), env: { PATH: "/does-not-exist" } }),
    ).rejects.toThrow("Could not start command");
    for (const timeoutMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2_147_483_647,
    ])
      await expect(runCommand(request([], timeoutMs))).rejects.toThrow(
        "timeout must fit",
      );
  });
});
