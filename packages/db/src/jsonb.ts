import { type SQL, sql } from "drizzle-orm";

/** Bun SQL serializes parameters inferred as jsonb itself. Bind serialized JSON
 * as text so Drizzle's encoding is not serialized a second time by the driver. */
export function jsonbValue<T>(value: T): SQL<T> {
  return sql`${JSON.stringify(value)}::text::jsonb`;
}
