import { expect, test } from "bun:test";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  type CommandRunner,
  createCommandRunner,
} from "../lib/dependency-setup";
import { linkLocal } from "../link-local";
import { setupDependencies } from "../setup-deps";

async function withFixture(work: (base: string) => Promise<void>) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agent-flow-setup-")),
  );
  try {
    await work(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function fixtureTest(name: string, work: (base: string) => Promise<void>) {
  test(name, () => withFixture(work));
}

async function write(path: string, contents: string) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
}

async function json(path: string, value: unknown) {
  await write(path, JSON.stringify(value));
}

// Record actual bytes and symlink targets without following links outside a fixture.
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(path: string) {
    const info = await lstat(path);
    const key = relative(directory, path);
    if (info.isSymbolicLink()) files[key] = `link:${await readlink(path)}`;
    else if (info.isDirectory()) {
      files[key] = "directory";
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child));
    } else files[key] = (await readFile(path)).toString("base64");
  }
  await visit(directory);
  return files;
}

function fixtureRunner(root: string, base: string) {
  // Even a regression in registry overrides remains inside the disposable sandbox.
  return createCommandRunner(root, {
    ...process.env,
    HOME: join(base, "home"),
    BUN_INSTALL_GLOBAL_DIR: join(base, "global-sentinel"),
    BUN_INSTALL_BIN: join(base, "bin-sentinel"),
    BUN_INSTALL_CACHE_DIR: join(base, "cache"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
}

async function pinnedFixture(base: string) {
  const root = join(base, "checkout");
  const upstream = join(base, "upstream");
  const actual = fixtureRunner(root, base);
  await json(join(root, "package.json"), {
    name: "fixture-checkout",
    private: true,
    workspaces: ["apps/*"],
  });
  await json(join(root, "apps/consumer/package.json"), {
    name: "fixture-consumer",
    dependencies: { "better-trigger": "link:better-trigger" },
  });
  await write(
    join(root, "bunfig.toml"),
    '[install]\nglobalDir = "./.local-deps/bun-global"\n',
  );
  await json(join(upstream, "package.json"), {
    name: "fixture-upstream",
    private: true,
  });
  await json(join(upstream, "packages/sdk/package.json"), {
    name: "better-trigger",
    version: "1.0.0",
    main: "dist/index.js",
  });
  await write(join(upstream, ".gitignore"), "dist/\nnode_modules/\n");
  await write(join(upstream, "source.txt"), "original source\n");
  await actual("git", ["init", "--quiet"], upstream, true);
  await actual("git", ["add", "."], upstream, true);
  await actual(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    upstream,
    true,
  );
  const revision = (
    await actual("git", ["rev-parse", "HEAD"], upstream, true)
  ).trim();
  const pkg = {
    directory: "packages/sdk",
    name: "better-trigger",
    artifact: "dist/index.js",
  };
  const dependency = {
    name: "better-trigger",
    repository: "https://github.com/zhy0216/better-trigger.git",
    revision,
    patches: [],
    packages: [pkg],
  };
  const lock = {
    version: 1,
    tools: {
      bun: Bun.version,
      node: (await actual("node", ["--version"], root, true)).trim().slice(1),
      rust: "unused",
    },
    dependencies: [dependency],
  };
  const saveLock = () => json(join(root, "dependencies.lock.json"), lock);
  await saveLock();
  let source = "";
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const hooks: {
    build?: (directory: string) => Promise<void>;
    fail?: (command: string, args: string[]) => boolean;
    wrongRevision?: boolean;
  } = {};
  const run: CommandRunner = async (command, args, cwd) => {
    expect(cwd.startsWith(`${base}/`)).toBe(true);
    calls.push({ command, args, cwd });
    if (hooks.fail?.(command, args)) throw new Error("fixture command failure");
    if (command === "git") {
      if (args[0] === "remote")
        return actual(
          command,
          ["remote", "add", "origin", upstream],
          cwd,
          true,
        );
      if (hooks.wrongRevision && args[0] === "rev-parse") return "0".repeat(40);
      return actual(command, args, cwd, true);
    }
    if (command === "node") return actual(command, args, cwd, true);
    if (command === "bun" && args[0] === "install") {
      if (cwd !== root) {
        source = cwd;
        return "";
      }
      // This fixture has only local workspace/link dependencies. Freeze after its
      // first lock creation; never resolve a registry package or run install hooks.
      return actual(
        command,
        [
          "install",
          "--offline",
          "--ignore-scripts",
          ...((await Bun.file(join(root, "bun.lock")).exists())
            ? ["--frozen-lockfile"]
            : []),
        ],
        cwd,
        true,
      );
    }
    if (command === "bun" && args[0] === "run") {
      if (hooks.build) await hooks.build(cwd);
      else
        await write(
          join(cwd, "packages/sdk/dist/index.js"),
          'export default "fixture";\n',
        );
      return "";
    }
    if (command === "bun" && args[0] === "link")
      return actual(command, args, cwd, true);
    throw new Error(`Unexpected fixture command: ${command} ${args.join(" ")}`);
  };
  return {
    root,
    upstream,
    actual,
    dependency,
    pkg,
    lock,
    saveLock,
    hooks,
    calls,
    run,
    source: () => source,
    setup: () => setupDependencies({ root, run }),
  };
}

fixtureTest(
  "importing either CLI has no filesystem or command side effects",
  async (base) => {
    const root = join(base, "checkout");
    const copied = join(root, "scripts");
    await mkdir(copied, { recursive: true });
    for (const file of [
      "setup-deps.ts",
      "link-local.ts",
      "lib/dependency-setup.ts",
    ]) {
      await mkdir(dirname(join(copied, file)), { recursive: true });
      await cp(resolve(import.meta.dir, "..", file), join(copied, file));
    }
    const entry = join(root, "import.ts");
    await write(
      entry,
      `Bun.spawn = () => { throw new Error("unexpected command during import"); };\nawait import("./scripts/setup-deps.ts");\nawait import("./scripts/link-local.ts");\n`,
    );
    const before = await snapshot(root);
    await fixtureRunner(root, base)(process.execPath, [entry], root, true);
    expect(await snapshot(root)).toEqual(before);
  },
);

for (const [name, mutate, error] of [
  [
    "lock version",
    (f) => {
      f.lock.version = 2;
    },
    "Unsupported dependency lock",
  ],
  [
    "Bun version",
    (f) => {
      f.lock.tools.bun = "0.0.0";
    },
    "Use Bun",
  ],
  [
    "dependency name",
    (f) => {
      f.dependency.name = "../outside";
    },
    "Invalid pinned dependency",
  ],
  [
    "repository identity",
    (f) => {
      f.dependency.repository = "https://github.com/zhy0216/mad-dom.git";
    },
    "Invalid pinned dependency",
  ],
  [
    "unpinned revision",
    (f) => {
      f.dependency.revision = "main";
    },
    "Invalid pinned dependency",
  ],
  [
    "empty dependency list",
    (f) => {
      f.lock.dependencies = [];
    },
    "Invalid pinned dependency",
  ],
  [
    "package directory traversal",
    (f) => {
      f.pkg.directory = "../outside";
    },
    "escapes its source",
  ],
  [
    "absolute package directory",
    (f) => {
      f.pkg.directory = f.upstream;
    },
    "escapes its source",
  ],
  [
    "artifact traversal",
    (f) => {
      f.pkg.artifact = "../outside.js";
    },
    "escapes its source",
  ],
] satisfies [
  string,
  (fixture: Awaited<ReturnType<typeof pinnedFixture>>) => void,
  string,
][]) {
  fixtureTest(
    `rejects ${name} before running commands or writing generated sources`,
    async (base) => {
      const f = await pinnedFixture(base);
      mutate(f);
      await f.saveLock();
      const before = await snapshot(base);
      await expect(f.setup()).rejects.toThrow(error);
      expect(f.calls).toEqual([]);
      expect(await snapshot(base)).toEqual(before);
    },
  );
}

fixtureTest(
  "rejects Node version before fetching or registering",
  async (base) => {
    const f = await pinnedFixture(base);
    f.lock.tools.node = "0.0.0";
    await f.saveLock();
    const before = await snapshot(base);
    await expect(f.setup()).rejects.toThrow("Use Node");
    expect(f.calls.map((call) => call.command)).toEqual(["node"]);
    expect(await snapshot(base)).toEqual(before);
  },
);

for (const kind of [
  "tracked",
  "staged",
  "untracked",
  "receipt",
  "missing receipt",
  "missing manifest",
] as const) {
  fixtureTest(
    `preserves every source byte when rejecting ${kind} changes`,
    async (base) => {
      const f = await pinnedFixture(base);
      await f.setup();
      const source = f.source();
      if (kind === "tracked" || kind === "staged") {
        await write(join(source, "source.txt"), "local edit\0\xff\n");
        if (kind === "staged")
          await f.actual("git", ["add", "source.txt"], source, true);
      } else if (kind === "untracked")
        await write(join(source, "notes.txt"), "keep this untracked work\n");
      else if (kind === "receipt") {
        const path = join(source, ".git/agent-flow-source.json");
        await json(path, {
          ...(await Bun.file(path).json()),
          fingerprint: "changed",
        });
      } else
        await rm(
          join(
            source,
            kind === "missing receipt"
              ? ".git/agent-flow-source.json"
              : "package.json",
          ),
        );
      const before = await snapshot(source);
      f.calls.length = 0;
      await expect(f.setup()).rejects.toThrow(
        kind === "missing receipt"
          ? "no setup receipt"
          : "differs from its pinned source",
      );
      expect(await snapshot(source)).toEqual(before);
      expect(
        f.calls.some(
          (call) => call.command === "bun" || call.args[0] === "fetch",
        ),
      ).toBe(false);
    },
  );
}

for (const stage of ["fetch", "checkout", "revision"] as const) {
  fixtureTest(
    `a ${stage} failure removes only its own staging directory`,
    async (base) => {
      const f = await pinnedFixture(base);
      const sources = join(f.root, ".local-deps/sources");
      await write(
        join(sources, "unrelated.partial-owned-elsewhere/keep.txt"),
        "existing staging\n",
      );
      await write(
        join(sources, "existing-source/keep.txt"),
        "existing source\n",
      );
      const before = await snapshot(sources);
      if (stage === "revision") f.hooks.wrongRevision = true;
      else
        f.hooks.fail = (command, args) =>
          command === "git" && args[0] === stage;
      await expect(f.setup()).rejects.toThrow(
        stage === "revision"
          ? "Fetched revision mismatch"
          : "fixture command failure",
      );
      expect(await snapshot(sources)).toEqual(before);
      expect(f.calls.some((call) => call.command === "bun")).toBe(false);
    },
  );
}

for (const kind of [
  "identity",
  "missing artifact",
  "directory symlink",
  "artifact symlink",
  "build failure",
  "build edits source",
] as const) {
  fixtureTest(
    `rejects ${kind} without registering a package or deleting published source`,
    async (base) => {
      const f = await pinnedFixture(base);
      if (kind === "identity") {
        f.pkg.name = "wrong-package";
        await f.saveLock();
      }
      f.hooks.build = async (source) => {
        if (kind === "build failure") throw new Error("fixture build failure");
        if (kind === "missing artifact") return;
        const directory = join(source, "packages/sdk");
        if (kind === "directory symlink") {
          await rm(directory, { recursive: true });
          await write(
            join(f.upstream, "packages/sdk/dist/index.js"),
            "outside\n",
          );
          await symlink(join(f.upstream, "packages/sdk"), directory);
        } else if (kind === "artifact symlink") {
          await mkdir(join(directory, "dist"), { recursive: true });
          await symlink(
            join(f.upstream, "source.txt"),
            join(directory, "dist/index.js"),
          );
        } else {
          await write(join(directory, "dist/index.js"), "fixture\n");
          if (kind === "build edits source")
            await write(
              join(source, "source.txt"),
              "build changed tracked source\n",
            );
        }
      };
      const error =
        kind === "identity"
          ? "Unexpected linked package identity"
          : kind === "missing artifact"
            ? "Missing built artifact"
            : kind === "build failure"
              ? "fixture build failure"
              : kind === "artifact symlink" || kind === "directory symlink"
                ? "escapes its source"
                : "differs from its pinned source";
      await expect(f.setup()).rejects.toThrow(error);
      expect(
        await Bun.file(
          join(f.source(), ".git/agent-flow-source.json"),
        ).exists(),
      ).toBe(true);
      expect(
        f.calls.some(
          (call) =>
            call.command === "bun" &&
            (call.args[0] === "link" || call.cwd === f.root),
        ),
      ).toBe(false);
      expect(
        (await readdir(join(f.root, ".local-deps/sources"))).filter((name) =>
          name.includes(".partial-"),
        ),
      ).toEqual([]);
    },
  );
}

fixtureTest(
  "a successful pinned fixture is reusable and resolves from the consumer",
  async (base) => {
    const f = await pinnedFixture(base);
    await f.setup();
    const before = await snapshot(f.source());
    f.calls.length = 0;
    await f.setup();
    expect(await snapshot(f.source())).toEqual(before);
    expect(f.calls.some((call) => call.args[0] === "fetch")).toBe(false);
    expect(
      await realpath(
        Bun.resolveSync("better-trigger", join(f.root, "apps/consumer")),
      ),
    ).toBe(join(f.source(), "packages/sdk/dist/index.js"));
    expect(
      await Bun.file(join(base, "global-sentinel/package.json")).exists(),
    ).toBe(false);
  },
);

async function localPackages(base: string, label: string) {
  const source = join(base, label);
  for (const [directory, name, artifact] of [
    ["better-trigger/packages/sdk", "better-trigger", "dist/index.js"],
    [
      "better-trigger/apps/worker",
      "@better-trigger/worker",
      "dist/embedded.js",
    ],
    ["mad-dom", "mad-dom", "build/mad-dom.node"],
  ] as const) {
    const path = join(source, directory);
    await json(join(path, "package.json"), {
      name,
      version: "1.0.0",
      main: artifact,
    });
    await write(
      join(path, artifact),
      `export default ${JSON.stringify(label)};\n`,
    );
  }
  return {
    betterTriggerSource: join(source, "better-trigger"),
    madDomSource: join(source, "mad-dom"),
  };
}

fixtureTest(
  "two local checkouts retain their own Bun registrations after reinstalling",
  async (base) => {
    const checkouts = [];
    for (const label of ["a", "b"]) {
      const root = join(base, `checkout-${label}`);
      const sources = await localPackages(base, `upstream-${label}`);
      const before = await snapshot(join(base, `upstream-${label}`));
      await json(join(root, "package.json"), {
        name: `checkout-${label}`,
        dependencies: {
          "better-trigger": "link:better-trigger",
          "@better-trigger/worker": "link:@better-trigger/worker",
          "mad-dom": "link:mad-dom",
        },
      });
      await write(
        join(root, "bunfig.toml"),
        '[install]\nglobalDir = "./.local-deps/bun-global"\n',
      );
      const run = fixtureRunner(root, base);
      await linkLocal({ root, ...sources, run });
      await run(
        "bun",
        ["install", "--offline", "--ignore-scripts"],
        root,
        true,
      );
      checkouts.push({ root, sources, run });
      expect(await snapshot(join(base, `upstream-${label}`))).toEqual(before);
    }
    for (const { root, sources, run } of checkouts) {
      await rm(join(root, "node_modules"), { recursive: true });
      await run(
        "bun",
        ["install", "--offline", "--ignore-scripts", "--frozen-lockfile"],
        root,
        true,
      );
      for (const [name, path] of [
        [
          "better-trigger",
          join(sources.betterTriggerSource, "packages/sdk/dist/index.js"),
        ],
        [
          "@better-trigger/worker",
          join(sources.betterTriggerSource, "apps/worker/dist/embedded.js"),
        ],
        ["mad-dom", join(sources.madDomSource, "build/mad-dom.node")],
      ] as const)
        expect(await realpath(Bun.resolveSync(name, root))).toBe(path);
    }
    expect(await readdir(base)).not.toContain("global-sentinel");
    expect(await readdir(base)).not.toContain("bin-sentinel");
  },
);

fixtureTest(
  "setup:local validates every package before registering any of them",
  async (base) => {
    const root = join(base, "checkout");
    const sources = await localPackages(base, "upstream");
    await mkdir(root);
    await json(join(sources.madDomSource, "package.json"), {
      name: "unexpected",
    });
    const before = await snapshot(base);
    await expect(
      linkLocal({
        root,
        ...sources,
        run: async () => {
          throw new Error("registration must not run");
        },
      }),
    ).rejects.toThrow("Unexpected linked package identity");
    expect(await snapshot(base)).toEqual(before);
  },
);

fixtureTest(
  "fixture cleanup also runs when the test body fails",
  async (base) => {
    let owned = "";
    await write(join(base, "keep.txt"), "other fixture\n");
    await expect(
      withFixture(async (directory) => {
        owned = directory;
        await write(join(directory, "partial/file.txt"), "temporary\n");
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(await Bun.file(join(owned, "partial/file.txt")).exists()).toBe(
      false,
    );
    expect(await readFile(join(base, "keep.txt"), "utf8")).toBe(
      "other fixture\n",
    );
  },
);

for (const path of [
  ".local-deps",
  ".local-deps/bun-global",
  ".local-deps/bin",
  ".local-deps/sources",
]) {
  fixtureTest(
    `refuses an escaping ${path} symlink without writing its target`,
    async (base) => {
      const f = await pinnedFixture(base);
      const target = join(base, "outside");
      await write(join(target, "keep.txt"), "existing files\n");
      await mkdir(dirname(join(f.root, path)), { recursive: true });
      await symlink(target, join(f.root, path));
      const before = await snapshot(target);
      await expect(f.setup()).rejects.toThrow("escapes its source");
      expect(await snapshot(target)).toEqual(before);
      expect(f.calls.every((call) => call.command === "node")).toBe(true);
    },
  );
}

fixtureTest(
  "local development registration cannot redirect another checkout's pinned install",
  async (base) => {
    const f = await pinnedFixture(base);
    await f.setup();
    const root = join(base, "development-checkout");
    await mkdir(root);
    const sources = await localPackages(base, "development-sources");
    await linkLocal({ root, ...sources, run: fixtureRunner(root, base) });
    await rm(join(f.root, "node_modules"), { recursive: true });
    await f.setup();
    expect(
      await realpath(
        Bun.resolveSync("better-trigger", join(f.root, "apps/consumer")),
      ),
    ).toBe(join(f.source(), "packages/sdk/dist/index.js"));
    expect(await readdir(base)).not.toContain("global-sentinel");
  },
);

fixtureTest("command failures retain their nonzero status", async (base) => {
  await expect(
    fixtureRunner(base, base)(
      process.execPath,
      ["-e", "process.exit(17)"],
      base,
      true,
    ),
  ).rejects.toThrow("failed (17)");
});

fixtureTest(
  "a competing publish is preserved when staging rename fails",
  async (base) => {
    const f = await pinnedFixture(base);
    let winner = "";
    const run: CommandRunner = async (command, args, cwd, capture) => {
      const result = await f.run(command, args, cwd, capture);
      if (command === "git" && args[0] === "ls-files") {
        winner = cwd.slice(0, cwd.lastIndexOf(".partial-"));
        await write(join(winner, "keep.txt"), "another setup published this\n");
      }
      return result;
    };
    await expect(setupDependencies({ root: f.root, run })).rejects.toThrow();
    expect(await readFile(join(winner, "keep.txt"), "utf8")).toBe(
      "another setup published this\n",
    );
    expect(await readdir(join(f.root, ".local-deps/sources"))).toEqual([
      relative(join(f.root, ".local-deps/sources"), winner),
    ]);
    expect(f.calls.some((call) => call.command === "bun")).toBe(false);
  },
);

fixtureTest(
  "post-install verification rejects a consumer redirected outside pinned source",
  async (base) => {
    const f = await pinnedFixture(base);
    await write(
      join(f.upstream, "packages/sdk/dist/index.js"),
      "outside entry\n",
    );
    const before = await snapshot(f.upstream);
    const run: CommandRunner = async (command, args, cwd, capture) => {
      const result = await f.run(command, args, cwd, capture);
      if (command === "bun" && args[0] === "install" && cwd === f.root) {
        const modules = join(f.root, "apps/consumer/node_modules");
        await mkdir(modules, { recursive: true });
        await rm(join(modules, "better-trigger"), {
          recursive: true,
          force: true,
        });
        await symlink(
          join(f.upstream, "packages/sdk"),
          join(modules, "better-trigger"),
        );
      }
      return result;
    };
    await expect(setupDependencies({ root: f.root, run })).rejects.toThrow(
      "resolved outside the pinned checkout",
    );
    expect(await snapshot(f.upstream)).toEqual(before);
  },
);

fixtureTest(
  "setup:local rejects missing native output before any registration",
  async (base) => {
    const root = join(base, "checkout");
    const sources = await localPackages(base, "upstream");
    await mkdir(root);
    await rm(join(sources.madDomSource, "build/mad-dom.node"));
    const before = await snapshot(base);
    await expect(
      linkLocal({
        root,
        ...sources,
        run: async () => {
          throw new Error("registration must not run");
        },
      }),
    ).rejects.toThrow("缺少构建产物");
    expect(await snapshot(base)).toEqual(before);
  },
);
