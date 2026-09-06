import type {
  EventPage,
  Issue,
  Project,
  Run,
  RunEvent,
  Worker,
} from "@agent-flow/contracts";
import {
  type QueryClient,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";
import {
  type EventNotice,
  filtersToParams,
  type IssueFilters,
  request,
} from "./api";

export const projectsQuery = queryOptions({
  queryKey: ["projects"],
  queryFn: ({ signal }) => request<Project[]>("/projects", { signal }),
});
export const issuesQuery = (filters: IssueFilters = {}) =>
  queryOptions({
    queryKey: ["issues", filters],
    queryFn: ({ signal }) =>
      request<Issue[]>(`/issues?${filtersToParams(filters)}`, { signal }),
  });
export const issueQuery = (id: string) =>
  queryOptions({
    queryKey: ["issue", id],
    queryFn: ({ signal }) =>
      request<Issue>(`/issues/${encodeURIComponent(id)}`, { signal }),
  });
export const runsQuery = (issueId?: string) =>
  queryOptions({
    queryKey: ["runs", issueId ?? "all"],
    queryFn: ({ signal }) =>
      request<Run[]>(
        issueId ? `/issues/${encodeURIComponent(issueId)}/runs` : "/runs",
        { signal },
      ),
    refetchInterval: 15_000,
  });
export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ["run", id],
    queryFn: ({ signal }) =>
      request<Run>(`/runs/${encodeURIComponent(id)}`, { signal }),
    refetchInterval: 10_000,
  });
export const workersQuery = queryOptions({
  queryKey: ["workers"],
  queryFn: ({ signal }) => request<Worker[]>("/workers", { signal }),
  refetchInterval: 10_000,
});
export const EVENT_PAGE_SIZE = 100;
export const EVENT_WINDOW_PAGES = 5;
export interface EventWindow {
  pages: RunEvent[][];
  cursor: number;
  hasMore: boolean;
  revision: number;
}
export class EventReadError extends Error {
  constructor(
    error: unknown,
    readonly revision: number,
  ) {
    super(error instanceof Error ? error.message : "日志读取失败", {
      cause: error,
    });
  }
}
export const eventNoticeOptions = (id: string) =>
  queryOptions<EventNotice>({
    queryKey: ["run-events-notice", id],
    queryFn: skipToken,
    initialData: { sequence: 0, revision: 0 },
    enabled: false,
    gcTime: 0,
  });

/** Each fetch advances one durable cursor, never refetching retained pages. */
export const eventsOptions = (
  id: string,
  client: QueryClient,
  historyAfter: number | null = null,
) =>
  queryOptions({
    queryKey: ["run-events", id],
    queryFn: async ({ signal }): Promise<EventWindow> => {
      const previous =
        historyAfter === null
          ? client.getQueryData<EventWindow>(["run-events", id])
          : undefined;
      const after = historyAfter ?? previous?.cursor ?? 0;
      const notice = client.getQueryData(eventNoticeOptions(id).queryKey);
      const knownSequence = Math.max(
        client.getQueryData<Run>(["run", id])?.lastSequence ?? 0,
        notice?.sequence ?? 0,
      );
      try {
        const page = await request<EventPage>(
          `/runs/${encodeURIComponent(id)}/events?after=${after}&limit=${EVENT_PAGE_SIZE}`,
          { signal },
        );
        // A notification is only a hint. Advance only over contiguous HTTP rows.
        const incoming = [
          ...new Map(
            page.events
              .filter((event) => event.runId === id && event.sequence > after)
              .map((event) => [event.sequence, event]),
          ).values(),
        ].sort((a, b) => a.sequence - b.sequence);
        const cursor = incoming.at(-1)?.sequence ?? after;
        if (
          incoming.length > EVENT_PAGE_SIZE ||
          incoming.some(
            (event, index) => event.sequence !== after + index + 1,
          ) ||
          page.nextCursor !== cursor ||
          (!incoming.length && (page.hasMore || knownSequence > after))
        )
          throw new Error("日志分页存在缺口，请重试补取；已读取的记录仍保留。");
        const retained = [...(previous?.pages.flat() ?? []), ...incoming].slice(
          -EVENT_PAGE_SIZE * EVENT_WINDOW_PAGES,
        );
        const pages: RunEvent[][] = [];
        for (
          let offset = 0;
          offset < retained.length;
          offset += EVENT_PAGE_SIZE
        )
          pages.push(retained.slice(offset, offset + EVENT_PAGE_SIZE));
        return {
          pages,
          cursor,
          hasMore: page.hasMore || knownSequence > cursor,
          revision: notice?.revision ?? 0,
        };
      } catch (error) {
        // Keep the revision actually attempted, even if a newer hint arrived
        // while this request was in flight. That hint still deserves a retry.
        throw new EventReadError(error, notice?.revision ?? 0);
      }
    },
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
