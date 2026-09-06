import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  capture?: boolean,
) => Promise<string>;

export function createCommandRunner(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): CommandRunner {
  const env = {
    ...environment,
    // Registrations must belong to the consumer checkout, including setup:local.
    BUN_INSTALL_GLOBAL_DIR: join(root, ".local-deps", "bun-global"),
    BUN_INSTALL_BIN: join(root, ".local-deps", "bin"),
  };
  return async (command, args, cwd, capture = false) => {
    const child = Bun.spawn([command, ...args], {
      cwd,
      env,
      stdin: "ignore",
      stdout: capture ? "pipe" : "inherit",
      stderr: "inherit",
    });
    const output =
      capture && child.stdout
        ? new Response(child.stdout).text()
        : Promise.resolve("");
    const [code, stdout] = await Promise.all([child.exited, output]);
    if (code !== 0)
      throw new Error(
        `${command} ${args.join(" ")} failed (${code}) in ${cwd}.`,
      );
    return stdout;
  };
}

export function under(parent: string, path: string) {
  const target = resolve(parent, path);
  const fromParent = relative(parent, target);
  if (
    isAbsolute(path) ||
    fromParent === ".." ||
    fromParent.startsWith(`..${sep}`)
  )
    throw new Error(`Dependency path escapes its source: ${path}`);
  return target;
}

export async function checkedPath(parent: string, path: string) {
  const target = under(parent, path);
  const [realParent, realTarget] = await Promise.all([
    realpath(parent),
    realpath(target),
  ]);
  under(realParent, relative(realParent, realTarget));
  return target;
}

export async function prepareRegistry(root: string) {
  // Check each existing ancestor before creating anything below it.
  for (const path of [
    ".local-deps",
    ".local-deps/bun-global",
    ".local-deps/bin",
  ]) {
    await mkdir(under(root, path), { recursive: true });
    await checkedPath(root, path);
  }
}

export async function validatePackage(pkg: {
  directory: string;
  name: string;
  artifact: string;
}) {
  const artifact = under(pkg.directory, pkg.artifact);
  if (!(await Bun.file(artifact).exists()))
    throw new Error(`Missing built artifact for ${pkg.name}: ${pkg.artifact}`);
  await checkedPath(pkg.directory, pkg.artifact);
  if (!(await stat(artifact)).isFile())
    throw new Error(`Invalid built artifact for ${pkg.name}: ${pkg.artifact}`);
  const manifestPath = await checkedPath(pkg.directory, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name?: string;
  };
  if (manifest.name !== pkg.name)
    throw new Error(`Unexpected linked package identity in ${pkg.directory}.`);
}
