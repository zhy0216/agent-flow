import { resolve } from "node:path";
import {
  type CommandRunner,
  createCommandRunner,
  prepareRegistry,
  validatePackage,
} from "./lib/dependency-setup";

export async function linkLocal(
  options: {
    root?: string;
    betterTriggerSource?: string;
    madDomSource?: string;
    run?: CommandRunner;
  } = {},
) {
  const repoRoot = resolve(options.root ?? resolve(import.meta.dir, ".."));
  const run = options.run ?? createCommandRunner(repoRoot);
  const sourceRoot = resolve(
    repoRoot,
    options.betterTriggerSource ??
      process.env.BETTER_TRIGGER_SOURCE ??
      "../better-trigger",
  );
  const packages = [
    {
      directory: resolve(sourceRoot, "packages/sdk"),
      artifact: "dist/index.js",
      name: "better-trigger",
    },
    {
      directory: resolve(sourceRoot, "apps/worker"),
      artifact: "dist/embedded.js",
      name: "@better-trigger/worker",
    },
    {
      directory: resolve(
        repoRoot,
        options.madDomSource ?? process.env.MAD_DOM_SOURCE ?? "../mad-dom",
      ),
      artifact: "build/mad-dom.node",
      name: "mad-dom",
    },
  ];

  for (const pkg of packages) {
    const directory = pkg.directory;
    if (!(await Bun.file(resolve(directory, pkg.artifact)).exists())) {
      throw new Error(
        `${pkg.name} 缺少构建产物：${directory}/${pkg.artifact}\n` +
          (pkg.name === "mad-dom"
            ? `请先在 ${directory} 执行 bun install --frozen-lockfile 和 bun run dev:build。\n`
            : `请先在 ${sourceRoot} 执行 bun install --frozen-lockfile 和 bun run build。\n`) +
          "可以使用 BETTER_TRIGGER_SOURCE / MAD_DOM_SOURCE 指定本地源码目录。",
      );
    }
    await validatePackage(pkg);
  }

  // This command deliberately opts into mutable upstream development sources.
  // Keep its registrations in this checkout, matching setup:deps and bunfig.toml.
  await prepareRegistry(repoRoot);
  // Bun's link: protocol resolves registered package names, not relative paths.
  for (const pkg of packages) {
    await run("bun", ["link"], pkg.directory);
  }

  console.info(
    "better-trigger 和 mad-dom 本地依赖已注册。现在可以执行 bun install。",
  );
}

if (import.meta.main) await linkLocal();
