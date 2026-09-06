import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

// Every fixture has a finite natural lifetime, including deliberately escaped
// descendants. Tests observe their own recorded PIDs and wait for final exit;
// they never clean up by signalling a possibly recycled PID.
const mode = Bun.argv[2];
if (mode === "output") {
  const stdout = Buffer.alloc(16_384, "x");
  const stderr = Buffer.alloc(16_384, "y");
  let remaining = Number(Bun.argv[3]);
  while (remaining > 0) {
    const count = Math.min(remaining, stdout.length);
    writeSync(1, stdout.subarray(0, count));
    writeSync(2, stderr.subarray(0, count));
    remaining -= count;
  }
  writeSync(1, "stdout-end:中文🙂");
  writeSync(2, "stderr-end:中文🙂");
  if (Bun.argv[4] === "hold") await Bun.sleep(1_500);
} else if (mode === "utf8") {
  for (const byte of new TextEncoder().encode("开始，中文🙂结束\n")) {
    writeSync(1, new Uint8Array([byte]));
    writeSync(2, new Uint8Array([byte]));
    await Bun.sleep(2);
  }
} else if (mode === "family") {
  const directory = Bun.argv[3];
  if (!directory) throw new Error("Missing fixture directory");
  const lifetimeMs = Number(Bun.argv[4]);
  const parentExits = Bun.argv[5] === "exit";
  const detached = Bun.argv[6] === "detached";
  const child = Bun.spawn(
    [process.execPath, import.meta.path, "leaf", directory, String(lifetimeMs)],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit", detached },
  );
  writeFileSync(
    join(directory, "family.json"),
    JSON.stringify({
      parent: process.pid,
      supervisor: process.ppid,
      child: child.pid,
      childGroup: detached ? child.pid : process.ppid,
    }),
  );
  writeSync(1, "parent-start\n");
  writeSync(2, "parent-error\n");
  if (parentExits) {
    child.unref();
    process.exit(0);
  }
  await child.exited;
} else if (mode === "leaf") {
  const directory = Bun.argv[3];
  if (!directory) throw new Error("Missing fixture directory");
  writeFileSync(join(directory, "leaf-ready"), "ready");
  // Also proves cleanup does not rely on cooperative SIGTERM handlers.
  process.on("SIGTERM", () => {});
  await Bun.sleep(Number(Bun.argv[4]));
  writeFileSync(join(directory, "natural-exit"), "finished");
} else {
  throw new Error(`Unknown command fixture mode: ${mode}`);
}
