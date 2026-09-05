import type {
  EventPage,
  Issue,
  Project,
  Run,
  Worker,
} from "@agent-flow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { filtersToParams, type IssueFilters, request } from "./api";

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
export const eventsOptions = (id: string) => ({
  queryKey: ["run-events", id],
  initialPageParam: 0,
  queryFn: ({
    signal,
    pageParam,
  }: {
    signal: AbortSignal;
    pageParam: number;
  }) =>
    request<EventPage>(
      `/runs/${encodeURIComponent(id)}/events?after=${pageParam}&limit=100`,
      { signal },
    ),
  getNextPageParam: (page: EventPage) =>
    page.hasMore ? page.nextCursor : undefined,
  refetchInterval: 10_000,
});
