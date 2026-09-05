import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const sourceRoot = resolve(
  repoRoot,
  process.env.BETTER_TRIGGER_SOURCE ?? "../better-trigger",
);
const packages = [
  {
    directory: resolve(sourceRoot, "packages/sdk"),
    entry: "dist/index.js",
    name: "better-trigger",
  },
  {
    directory: resolve(sourceRoot, "apps/worker"),
    entry: "dist/embedded.js",
    name: "@better-trigger/worker",
  },
  {
    directory: resolve(repoRoot, process.env.MAD_DOM_SOURCE ?? "../mad-dom"),
    entry: "build/mad-dom.node",
    name: "mad-dom",
  },
];

for (const pkg of packages) {
  const directory = pkg.directory;
  if (!(await Bun.file(resolve(directory, pkg.entry)).exists())) {
    throw new Error(
      `${pkg.name} 缺少构建产物：${directory}/${pkg.entry}\n` +
        (pkg.name === "mad-dom"
          ? `请先在 ${directory} 执行 bun install --frozen-lockfile 和 bun run dev:build。\n`
          : `请先在 ${sourceRoot} 执行 bun install --frozen-lockfile 和 bun run build。\n`) +
        "可以使用 BETTER_TRIGGER_SOURCE / MAD_DOM_SOURCE 指定本地源码目录。",
    );
  }
}

// Bun's link: protocol resolves registered package names, not relative paths.
for (const pkg of packages) {
  const child = Bun.spawn(["bun", "link"], {
    cwd: pkg.directory,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`无法注册本地包 ${pkg.name}`);
}

console.info(
  "better-trigger 和 mad-dom 本地依赖已注册。现在可以执行 bun install。",
);
