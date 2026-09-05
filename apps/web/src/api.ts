import type { HealthResponse } from "@agent-flow/contracts";
import { queryOptions } from "@tanstack/react-query";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/$/, "");

export const healthQueryOptions = queryOptions({
  queryKey: ["system", "health"],
  queryFn: async ({ signal }): Promise<HealthResponse> => {
    const response = await fetch(`${apiOrigin}/api/health`, { signal });
    if (!response.ok) throw new Error(`API 请求失败 (${response.status})`);
    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      data === null ||
      !("status" in data) ||
      data.status !== "ok" ||
      !("service" in data) ||
      data.service !== "agent-flow-server"
    ) {
      throw new Error("API 返回了无法识别的健康状态");
    }
    return { status: data.status, service: data.service };
  },
  retry: 1,
  staleTime: 10_000,
  refetchInterval: 30_000,
});
