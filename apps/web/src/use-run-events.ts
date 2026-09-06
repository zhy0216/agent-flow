import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { EventReadError, eventNoticeOptions, eventsOptions } from "./queries";

export function useRunEvents(id: string, lastSequence: number) {
  const client = useQueryClient();
  const [mode, setMode] = useState<{
    follow: boolean;
    historyAfter: number | null;
  }>({ follow: true, historyAfter: null });
  const notice = useQuery(eventNoticeOptions(id));
  const events = useQuery({
    ...eventsOptions(id, client, mode.historyAfter),
    enabled: mode.follow,
    refetchInterval: mode.follow ? 10_000 : false,
  });
  const { data, isFetching, isError, error, refetch } = events;
  useEffect(() => {
    const attemptedRevision =
      error instanceof EventReadError ? error.revision : (data?.revision ?? 0);
    if (
      mode.follow &&
      !isFetching &&
      (!isError || error instanceof EventReadError) &&
      (attemptedRevision < (notice.data?.revision ?? 0) ||
        (!isError &&
          data &&
          (data.hasMore ||
            data.cursor < Math.max(lastSequence, notice.data?.sequence ?? 0))))
    )
      void refetch({ cancelRefetch: false });
  }, [
    mode.follow,
    data,
    isFetching,
    isError,
    error,
    lastSequence,
    notice.data,
    refetch,
  ]);

  useEffect(() => {
    if (mode.historyAfter !== null) void refetch();
  }, [mode.historyAfter, refetch]);

  async function changeMode(follow: boolean, historyAfter: number | null) {
    // Cancel before changing the cursor so a late response cannot replace a
    // paused window or the history explicitly selected by the reader.
    await client.cancelQueries({ queryKey: ["run-events", id], exact: true });
    setMode({ follow, historyAfter });
  }
  return {
    ...events,
    follow: mode.follow,
    historyAfter: mode.historyAfter,
    setFollow: (follow: boolean) => void changeMode(follow, null),
    readHistory: (after: number) => void changeMode(false, after),
    latestSequence: Math.max(
      lastSequence,
      notice.data?.sequence ?? 0,
      data?.cursor ?? 0,
    ),
  };
}
