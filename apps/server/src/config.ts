import { isIP } from "node:net";

export function readServerConfig(env: Record<string, string | undefined>) {
  const hostname = env.HOST ?? "127.0.0.1";
  const rawPort = env.PORT ?? "3001";

  const validHostname =
    hostname.length <= 253 &&
    hostname
      .split(".")
      .every((label) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label),
      );

  if (!isIP(hostname) && !validHostname) {
    throw new Error(
      "HOST must be an IP address or hostname, without a URL scheme or port",
    );
  }

  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return { hostname, port };
}
