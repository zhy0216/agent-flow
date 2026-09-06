import type { ChangeEvent, HealthResponse } from "@agent-flow/contracts";
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
export type EventNotice = { sequence: number; revision: number };
function logsOnly(event: ChangeEvent) {
  return event.eventType === "log" || event.eventType === "agent.state";
}
/** Only redundant log hints may be dropped; older transitions still refresh snapshots. */
export function acceptsEvent(
  event: ChangeEvent,
  sequences: Map<string, number>,
) {
  if (event.entity !== "run" || !Number.isSafeInteger(event.sequence))
    return true;
  const id = event.runId ?? event.id;
  const previous = sequences.get(id) ?? 0;
  sequences.set(id, Math.max(previous, event.sequence ?? 0));
  return !logsOnly(event) || (event.sequence ?? 0) > previous;
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
    let stream: EventSource | undefined;
    const sequences = new Map<string, number>();
    const pending = new Map<
      string,
      { event: ChangeEvent; sequence: number; snapshots: boolean }
    >();
    let timer: ReturnType<typeof setTimeout> | undefined;
    function flush() {
      timer = undefined;
      const keys = new Map<string, string[]>();
      const refresh = (key: string[]) => keys.set(JSON.stringify(key), key);
      for (const { event, sequence, snapshots } of pending.values()) {
        if (event.entity === "project") {
          refresh(["projects"]);
          refresh(["project", event.id]);
        } else if (event.entity === "issue") {
          refresh(["issues"]);
          refresh(["issue", event.id]);
        } else if (event.entity === "worker") {
          refresh(["workers"]);
        } else {
          const id = event.runId ?? event.id;
          // Only mounted log readers need hints. HTTP owns the durable cursor.
          client.setQueriesData<EventNotice>(
            { queryKey: ["run-events-notice", id] },
            (previous) =>
              previous && {
                sequence: Math.max(previous.sequence, sequence),
                revision: previous.revision + 1,
              },
          );
          if (snapshots) {
            refresh(["runs"]);
            refresh(["run", id]);
            refresh(["issues"]);
            refresh(["issue"]);
          }
        }
      }
      pending.clear();
      // One invalidation per affected query, even when a burst includes both
      // run transitions and their corresponding issue notifications.
      void client.invalidateQueries({
        predicate: ({ queryKey }) =>
          [...keys.values()].some((key) =>
            key.every((part, index) => queryKey[index] === part),
          ),
      });
    }
    function opened() {
      setConnection("connected");
      sequences.clear();
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      client.setQueriesData<EventNotice>(
        { queryKey: ["run-events-notice"] },
        (previous) =>
          previous && { ...previous, revision: previous.revision + 1 },
      );
      // SSE is a notification channel. Fresh snapshots close any reconnect gap.
      void client.invalidateQueries({
        predicate: ({ queryKey }) =>
          !["system", "run-events", "run-events-notice"].includes(
            String(queryKey[0]),
          ),
      });
    }
    function receive(message: MessageEvent) {
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
      const key = `${event.entity}:${event.runId ?? event.id}`;
      const previous = pending.get(key);
      pending.set(key, {
        event,
        sequence: Math.max(
          previous?.sequence ?? 0,
          Number.isSafeInteger(event.sequence) ? (event.sequence ?? 0) : 0,
        ),
        snapshots: (previous?.snapshots ?? false) || !logsOnly(event),
      });
      // A bounded delay also flushes a continuous stream without starvation.
      if (!timer) timer = setTimeout(flush, 100);
    }
    function connect() {
      stream?.close();
      const source = new EventSource(`${apiOrigin}/api/events`);
      stream = source;
      setConnection("connecting");
      source.onopen = () => {
        if (stream === source) opened();
      };
      source.onerror = () => {
        if (stream === source) setConnection("disconnected");
      };
      source.onmessage = (message) => {
        if (stream === source) receive(message);
      };
    }
    function disconnect() {
      stream?.close();
      stream = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
      setConnection("disconnected");
    }
    // Browser network changes are independent of SSE errors. Dispose the old
    // transport explicitly and use a fresh connection when the network returns.
    window.addEventListener("offline", disconnect);
    window.addEventListener("online", connect);
    if (navigator.onLine === false) disconnect();
    else connect();
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("offline", disconnect);
      window.removeEventListener("online", connect);
      stream?.close();
    };
  }, [client]);
  return connection;
}
