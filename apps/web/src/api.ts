import type { HealthResponse } from "@agent-flow/contracts";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export const apiOrigin = (import.meta.env.VITE_API_ORIGIN ?? "").replace(
  /\/$/,
  "",
);
export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiOrigin}/api${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const data = (await response.json()) as { error?: { message?: string } };
      if (data.error?.message) message = data.error.message;
    } catch {
      /* An unavailable proxy can return plain text. */
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export function jsonBody(value: unknown) {
  return JSON.stringify(value);
}
export const healthQueryOptions = queryOptions({
  queryKey: ["system", "health"],
  queryFn: async ({ signal }): Promise<HealthResponse> => {
    const data = await request<HealthResponse>("/health", { signal });
    if (data?.status !== "ok" || data?.service !== "agent-flow-server")
      throw new Error("API 返回了无法识别的健康状态");
    return data;
  },
  retry: 1,
  staleTime: 10_000,
  refetchInterval: 30_000,
});
export type IssueFilters = {
  projectId?: string;
  status?: string;
  priority?: string;
  q?: string;
};
export function filtersToParams(filters: IssueFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value) params.set(key, value);
  return params.toString();
}
export type ChangeEvent = {
  entity: "project" | "issue" | "run" | "worker";
  id: string;
  runId?: string;
  sequence?: number;
};
/** Per-run sequence tracking tolerates duplicate delivery without mixing run cursors. */
export function acceptsEvent(
  event: ChangeEvent,
  sequences: Map<string, number>,
) {
  if (!event.runId || !Number.isSafeInteger(event.sequence)) return true;
  const previous = sequences.get(event.runId) ?? 0;
  if ((event.sequence ?? 0) <= previous) return false;
  sequences.set(event.runId, event.sequence ?? 0);
  return true;
}
export function useRealtime() {
  const client = useQueryClient();
  const [connection, setConnection] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setConnection("disconnected");
      return;
    }
    const stream = new EventSource(`${apiOrigin}/api/events`);
    const sequences = new Map<string, number>();
    stream.onopen = () => {
      setConnection("connected");
      sequences.clear();
      // SSE is a notification channel. Fresh snapshots close any reconnect gap.
      void client.invalidateQueries({
        predicate: ({ queryKey }) => queryKey[0] !== "system",
      });
    };
    stream.onerror = () => setConnection("disconnected");
    stream.onmessage = (message) => {
      let event: ChangeEvent;
      try {
        event = JSON.parse(message.data) as ChangeEvent;
      } catch {
        return;
      }
      if (
        !event ||
        !["project", "issue", "run", "worker"].includes(event.entity) ||
        typeof event.id !== "string" ||
        !acceptsEvent(event, sequences)
      )
        return;
      if (event.entity === "project") {
        void client.invalidateQueries({ queryKey: ["projects"] });
        void client.invalidateQueries({ queryKey: ["project", event.id] });
      } else if (event.entity === "issue") {
        void client.invalidateQueries({ queryKey: ["issues"] });
        void client.invalidateQueries({ queryKey: ["issue", event.id] });
      } else if (event.entity === "worker") {
        void client.invalidateQueries({ queryKey: ["workers"] });
      } else {
        void client.invalidateQueries({ queryKey: ["runs"] });
        void client.invalidateQueries({
          queryKey: ["run", event.runId ?? event.id],
        });
        void client.invalidateQueries({
          queryKey: ["run-events", event.runId ?? event.id],
        });
        // A run transition can also change its issue's management status.
        void client.invalidateQueries({ queryKey: ["issues"] });
        void client.invalidateQueries({ queryKey: ["issue"], type: "active" });
      }
    };
    return () => stream.close();
  }, [client]);
  return connection;
}
