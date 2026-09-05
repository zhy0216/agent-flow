/** better-trigger currently uses unqualified internal table names. PostgreSQL's
 * default "$user",public search path would select our business schema when the
 * DB role is named agent_flow. Pin the runtime pool AND its listener to public. */
export function runtimeDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    `${options ? `${options} ` : ""}-c search_path=public`,
  );
  return url.toString();
}
