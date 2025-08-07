import type { RecordTable } from "../types.d.ts";

export type RecordTableWithoutIndexedAt = Omit<
  RecordTable,
  "indexedAt"
>;