import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

interface Dependency {
  name: "better-trigger" | "mad-dom";
  repository: string;
  revision: string;
  patches: { file: string; sha256: string }[];
  packages: { directory: string; name: string; artifact: string }[];
}
interface DependencyLock {
  version: 1;
  tools: { bun: string; node: string; rust: string };
  dependencies: Dependency[];
}
interface SourceReceipt {
  revision: string;
  patchDigest: string;
  fingerprint: string;
}

const root = resolve(import.meta.dir, "..");
const dependencyRoot = join(root, ".local-deps");
const lock = (await Bun.file(
  join(root, "dependencies.lock.json"),
).json()) as DependencyLock;
if (lock.version !== 1) throw new Error("Unsupported dependency lock version.");
if (Bun.version !== lock.tools.bun)
  throw new Error(`Use Bun ${lock.tools.bun}; found ${Bun.version}.`);
const env = {
  ...process.env,
  // Keep link registrations local to this checkout. Installing in a second
  // checkout must not redirect another project's registered development links.
  BUN_INSTALL_GLOBAL_DIR: join(dependencyRoot, "bun-global"),
  BUN_INSTALL_BIN: join(dependencyRoot, "bin"),
};

async function run(
  command: string,
  args: string[],
  cwd = root,
  capture = false,
) {
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
    throw new Error(`${command} ${args.join(" ")} failed (${code}) in ${cwd}.`);
  return stdout;
}
function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
function under(parent: string, path: string) {
  const target = resolve(parent, path);
  const pathFromParent = relative(parent, target);
  if (
    isAbsolute(path) ||
    pathFromParent === ".." ||
    pathFromParent.startsWith("../")
  )
    throw new Error(`Dependency path escapes its source: ${path}`);
  return target;
}
async function fingerprint(source: string) {
  const changes = await run("git", ["diff", "--binary", "HEAD"], source, true);
  const untracked = (
    await run(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      source,
      true,
    )
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const files: { path: string; sha256: string }[] = [];
  for (const path of untracked)
    files.push({ path, sha256: hash(await readFile(under(source, path))) });
  return hash(JSON.stringify({ changes, files }));
}
async function assertReceipt(
  source: string,
  expected: Pick<SourceReceipt, "revision" | "patchDigest">,
) {
  const receiptFile = Bun.file(join(source, ".git", "agent-flow-source.json"));
  if (!(await receiptFile.exists()))
    throw new Error(
      `${source} has no setup receipt. Move it aside before rebuilding dependencies.`,
    );
  const receipt = (await receiptFile.json()) as SourceReceipt;
  const revision = (
    await run("git", ["rev-parse", "HEAD"], source, true)
  ).trim();
  if (
    revision !== expected.revision ||
    receipt.revision !== expected.revision ||
    receipt.patchDigest !== expected.patchDigest ||
    receipt.fingerprint !== (await fingerprint(source))
  ) {
    throw new Error(
      `${source} differs from its pinned source and patch. Preserve any local edits, then remove that generated checkout and rerun setup.`,
    );
  }
}
async function prepareSource(dependency: Dependency) {
  if (
    !/^(better-trigger|mad-dom)$/.test(dependency.name) ||
    !/^https:\/\/github\.com\/zhy0216\/[a-z-]+\.git$/.test(
      dependency.repository,
    ) ||
    !/^[a-f0-9]{40}$/.test(dependency.revision)
  )
    throw new Error("Invalid pinned dependency identity.");
  const patches: string[] = [];
  for (const patch of dependency.patches) {
    const path = under(root, patch.file);
    if (hash(await readFile(path)) !== patch.sha256)
      throw new Error(`Patch checksum mismatch: ${patch.file}`);
    patches.push(path);
  }
  const patchDigest = hash(JSON.stringify(dependency.patches));
  const source = join(
    dependencyRoot,
    "sources",
    `${dependency.name}-${dependency.revision.slice(0, 12)}-${patchDigest.slice(0, 12)}`,
  );
  const identity = { revision: dependency.revision, patchDigest };
  if (await Bun.file(join(source, "package.json")).exists()) {
    await assertReceipt(source, identity);
    return { source, identity };
  }
  const staging = `${source}.partial-${randomUUID()}`;
  await mkdir(staging, { recursive: true });
  try {
    await run("git", ["init", "--quiet"], staging);
    await run(
      "git",
      ["remote", "add", "origin", dependency.repository],
      staging,
    );
    await run(
      "git",
      ["fetch", "--depth=1", "origin", dependency.revision],
      staging,
    );
    await run(
      "git",
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
      staging,
    );
    const revision = (
      await run("git", ["rev-parse", "HEAD"], staging, true)
    ).trim();
    if (revision !== dependency.revision)
      throw new Error(`Fetched revision mismatch for ${dependency.name}.`);
    for (const patch of patches)
      await run("git", ["apply", "--check", patch], staging);
    for (const patch of patches) await run("git", ["apply", patch], staging);
    await Bun.write(
      join(staging, ".git", "agent-flow-source.json"),
      JSON.stringify({ ...identity, fingerprint: await fingerprint(staging) }),
    );
    await rename(staging, source);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
  return { source, identity };
}

const nodeVersion = (await run("node", ["--version"], root, true)).trim();
if (nodeVersion !== `v${lock.tools.node}`)
  throw new Error(`Use Node ${lock.tools.node}; found ${nodeVersion}.`);
await mkdir(join(dependencyRoot, "bun-global"), { recursive: true });
await mkdir(join(dependencyRoot, "bin"), { recursive: true });
const registrations: { directory: string; name: string }[] = [];

for (const dependency of lock.dependencies) {
  console.info(`Preparing ${dependency.name} at ${dependency.revision}...`);
  const { source, identity } = await prepareSource(dependency);
  await run("bun", ["install", "--frozen-lockfile"], source);
  if (dependency.name === "better-trigger") {
    // The worker's Turbo graph includes the SDK, internal libraries, and its
    // embedded dashboard. Keep its single shared SDK AsyncLocalStorage intact.
    await run(
      "bun",
      [
        "run",
        "--bun",
        "turbo",
        "run",
        "build",
        "--filter=@better-trigger/worker",
        "--filter=better-trigger",
      ],
      source,
    );
  } else {
    await run(
      "rustup",
      [
        "run",
        lock.tools.rust,
        "cargo",
        "build",
        "--locked",
        "--release",
        "-p",
        "mad-dom-bun",
      ],
      source,
    );
    const native =
      process.platform === "darwin"
        ? "libmad_dom_bun.dylib"
        : process.platform === "linux"
          ? "libmad_dom_bun.so"
          : process.platform === "win32"
            ? "mad_dom_bun.dll"
            : undefined;
    if (!native)
      throw new Error(`Unsupported native build platform: ${process.platform}`);
    await mkdir(join(source, "build"), { recursive: true });
    await copyFile(
      join(source, "target", "release", native),
      join(source, "build", "mad-dom.node"),
    );
    await run(
      "bun",
      [
        "test",
        "tests/bun/html-element-constructors.test.js",
        "tests/bun/react19.test.js",
      ],
      source,
    );
  }
  await assertReceipt(source, identity);
  for (const pkg of dependency.packages) {
    const directory = under(source, pkg.directory);
    if (!(await Bun.file(under(directory, pkg.artifact)).exists()))
      throw new Error(
        `Missing built artifact for ${pkg.name}: ${pkg.artifact}`,
      );
    const manifest = (await Bun.file(
      join(directory, "package.json"),
    ).json()) as { name?: string };
    if (manifest.name !== pkg.name)
      throw new Error(`Unexpected linked package identity in ${directory}.`);
    await run("bun", ["link"], directory);
    registrations.push({ directory, name: pkg.name });
  }
}

await run("bun", ["install", "--frozen-lockfile"]);
const workspaceManifests = await Array.fromAsync(
  new Bun.Glob("{apps,packages}/*/package.json").scan({
    cwd: root,
    absolute: true,
  }),
);
for (const registration of registrations) {
  // Both hoisted and isolated Bun layouts are supported. Resolve from each
  // actual consumer, not from the repository root's incidental node_modules.
  let consumers = 0;
  for (const manifestPath of workspaceManifests) {
    const manifest = (await Bun.file(manifestPath).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (
      { ...manifest.dependencies, ...manifest.devDependencies }[
        registration.name
      ] !== `link:${registration.name}`
    )
      continue;
    consumers += 1;
    const installedEntry = await realpath(
      Bun.resolveSync(registration.name, dirname(manifestPath)),
    );
    const sourcePath = await realpath(registration.directory);
    const fromSource = relative(sourcePath, installedEntry);
    if (
      fromSource === ".." ||
      fromSource.startsWith("../") ||
      isAbsolute(fromSource)
    )
      throw new Error(
        `${registration.name} resolved outside the pinned checkout from ${manifestPath}. Remove node_modules and rerun setup:deps.`,
      );
  }
  if (!consumers)
    throw new Error(
      `No workspace consumes the pinned ${registration.name} package.`,
    );
}
console.info(
  "Pinned dependencies built, verified and installed. Run bun run check.",
);
