import type { Label } from "$lexicon/types/com/atproto/label/defs.ts";
import type {
  NodeSavedSession,
  NodeSavedState,
} from "@bigmoves/atproto-oauth-client";
import { Buffer } from "node:buffer";
import type {
  ActorTable,
  BffConfig,
  Database,
  LabelTable,
  QueryOptions,
  RecordTable,
  Where,
  WhereCondition,
} from "../types.d.ts";
import { hydrateBlobRefs } from "../utils.ts";
import { indexFacets, timedQuery } from "../utils/database.ts";

function buildWhereClause(
  condition: Where,
  tableColumns: string[],
  indexedKeys: Set<string>,
  params: Array<string | number | boolean>,
  kvAliasMap?: Record<string, string>,
): string {
  if (Array.isArray(condition)) {
    return condition.map((c) =>
      buildWhereClause(c, tableColumns, indexedKeys, params, kvAliasMap)
    ).join(
      " AND ",
    );
  }
  if ("AND" in condition) {
    const parts = condition.AND!.map((c) =>
      `(${buildWhereClause(c, tableColumns, indexedKeys, params, kvAliasMap)})`
    );
    return parts.join(" AND ");
  }
  if ("OR" in condition) {
    const parts = condition.OR!.map((c) =>
      `(${buildWhereClause(c, tableColumns, indexedKeys, params, kvAliasMap)})`
    );
    return parts.join(" OR ");
  }
  if ("NOT" in condition) {
    return `NOT (${
      buildWhereClause(
        condition.NOT!,
        tableColumns,
        indexedKeys,
        params,
        kvAliasMap,
      )
    })`;
  }
  const { field, equals, contains, in: inArray } = condition as WhereCondition;
  if (!field) throw new Error("Missing 'field' in condition");
  const isDirect = tableColumns.includes(field);
  const isIndexed = indexedKeys.has(field);
  let columnExpr;
  if (isDirect) {
    columnExpr = `record.${field}`;
  } else if (isIndexed && kvAliasMap && kvAliasMap[field]) {
    columnExpr = `${kvAliasMap[field]}.value`;
  } else {
    columnExpr = `JSON_EXTRACT(json, '$.${field}')`;
  }
  if (equals !== undefined) {
    params.push(equals);
    return `${columnExpr} = ?`;
  }
  if (inArray) {
    const placeholders = inArray.map(() => "?").join(", ");
    params.push(...inArray);
    return `${columnExpr} IN (${placeholders})`;
  }
  if (contains !== undefined) {
    params.push(`%${contains}%`);
    return `${columnExpr} LIKE ?`;
  }
  throw new Error("Unsupported condition format");
}

export class IndexService {
  constructor(
    private db: Database,
    private cfg: BffConfig,
  ) {}

  private get collectionKeyMap() {
    return this.cfg?.collectionKeyMap || {};
  }

  private get tableColumns() {
    return ["did", "uri", "indexedAt", "cid"];
  }

  getRecords<T extends Record<string, unknown>>(
    collection: string,
    options?: QueryOptions,
  ) {
    const collectionKeyMap = this.collectionKeyMap;
    const indexedKeys = collectionKeyMap[collection] || [];
    const tableColumns = this.tableColumns;
    let query: string;
    let params: (string | number | boolean)[] = [];
    const kvAliasMap: Record<string, string> = {};

    let joinClauses = "";
    let i = 0;
    for (const key of indexedKeys) {
      const alias = `kv${i}`;
      kvAliasMap[key] = alias;
      joinClauses +=
        ` LEFT JOIN record_kv AS ${alias} ON ${alias}.uri = record.uri AND ${alias}.key = ?`;
      params.push(key);
      i++;
    }

    // Facet join
    if (options?.facet) {
      joinClauses += ` JOIN facet_index ON record.uri = facet_index.uri`;
    }

    query =
      `SELECT record.* FROM record${joinClauses} WHERE record.collection = ?`;
    params.push(collection);

    // Facet filter
    if (options?.facet) {
      query += ` AND facet_index.type = ? AND facet_index.value = ?`;
      params.push(options.facet.type, options.facet.value);
    }

    // Only add kvN.value = ? for indexed keys present in the where clause
    const normalizedWhere = Array.isArray(options?.where)
      ? { AND: options.where }
      : options?.where;
    const extraKvClauses: string[] = [];
    if (normalizedWhere && typeof normalizedWhere === "object") {
      for (const key of indexedKeys) {
        let value: string | undefined;
        if (
          "field" in normalizedWhere && normalizedWhere.field === key &&
          normalizedWhere.equals !== undefined
        ) {
          value = String(normalizedWhere.equals);
        }
        // TODO: handle nested/AND/OR if needed
        if (value !== undefined) {
          extraKvClauses.push(`${kvAliasMap[key]}.value = ?`);
          params.push(value);
        }
      }
    }
    if (extraKvClauses.length > 0) {
      query += ` AND ` + extraKvClauses.join(" AND ");
    }

    // Now add the rest of the where clause (for non-indexed keys)
    if (normalizedWhere) {
      try {
        const whereClause = buildWhereClause(
          normalizedWhere,
          tableColumns,
          new Set(indexedKeys),
          params,
          kvAliasMap,
        );
        if (whereClause) query += ` AND (${whereClause})`;
      } catch (err) {
        console.warn("Invalid where clause", err);
      }
    }

    if (options?.cursor) {
      try {
        const orderByClauses = options?.orderBy ||
          [{ field: "indexedAt", direction: "asc" }];

        const decoded = Buffer.from(options.cursor, "base64").toString(
          "utf-8",
        );
        const cursorParts = decoded.split("|");

        // The last part is always the CID
        const cursorCid = cursorParts[cursorParts.length - 1];

        if (cursorParts.length - 1 !== orderByClauses.length) {
          console.warn("Cursor format doesn't match orderBy fields count");
          throw new Error("Invalid cursor format");
        }

        // Build the WHERE condition for pagination with multiple fields
        let cursorCondition = "(";
        const clauses: string[] = [];

        for (let i = 0; i < orderByClauses.length; i++) {
          const { field, direction = "asc" } = orderByClauses[i];
          const cursorValue = cursorParts[i];
          const comparisonOp = direction === "desc" ? "<" : ">";

          // Build progressive equality checks for earlier columns
          if (i > 0) {
            let equalityCheck = "(";
            for (let j = 0; j < i; j++) {
              const equalField = orderByClauses[j].field;
              const equalValue = cursorParts[j];

              if (j > 0) equalityCheck += " AND ";

              if (tableColumns.includes(equalField)) {
                equalityCheck += `${equalField} = ?`;
              } else {
                equalityCheck += `JSON_EXTRACT(json, '$.${equalField}') = ?`;
              }
              params.push(equalValue);
            }
            equalityCheck += " AND ";

            // Add the comparison for the current field
            if (tableColumns.includes(field)) {
              equalityCheck += `${field} ${comparisonOp} ?`;
            } else {
              equalityCheck +=
                `JSON_EXTRACT(json, '$.${field}') ${comparisonOp} ?`;
            }
            params.push(cursorValue);
            equalityCheck += ")";

            clauses.push(equalityCheck);
          } else {
            // First column is simpler
            if (tableColumns.includes(field)) {
              clauses.push(`${field} ${comparisonOp} ?`);
            } else {
              clauses.push(
                `JSON_EXTRACT(json, '$.${field}') ${comparisonOp} ?`,
              );
            }
            params.push(cursorValue);
          }
        }

        // Add final equality check on all columns with CID comparison
        let finalClause = "(";
        for (let i = 0; i < orderByClauses.length; i++) {
          const { field } = orderByClauses[i];
          const cursorValue = cursorParts[i];

          if (i > 0) finalClause += " AND ";

          if (tableColumns.includes(field)) {
            finalClause += `${field} = ?`;
          } else {
            finalClause += `JSON_EXTRACT(json, '$.${field}') = ?`;
          }
          params.push(cursorValue);
        }

        const lastDirection =
          orderByClauses[orderByClauses.length - 1]?.direction || "asc";
        const cidComparisonOp = lastDirection === "desc" ? "<" : ">";
        finalClause += ` AND cid ${cidComparisonOp} ?`;
        params.push(cursorCid);
        finalClause += ")";

        clauses.push(finalClause);

        cursorCondition += clauses.join(" OR ") + ")";
        query += ` AND ${cursorCondition}`;
      } catch (error) {
        console.warn("Invalid cursor format", error);
      }
    }

    const orderByClauses = options?.orderBy ||
      [{ field: "indexedAt", direction: "asc" }];

    if (orderByClauses.length > 0) {
      const orderParts: string[] = [];

      for (const { field, direction = "asc" } of orderByClauses) {
        if (tableColumns.includes(field)) {
          orderParts.push(`${field} ${direction}`);
        } else {
          orderParts.push(`JSON_EXTRACT(json, '$.${field}') ${direction}`);
        }
      }

      // Always include cid in the ORDER BY to ensure consistent ordering
      const lastDirection =
        orderByClauses[orderByClauses.length - 1]?.direction || "asc";
      orderParts.push(`cid ${lastDirection}`);

      query += ` ORDER BY ${orderParts.join(", ")}`;
    }

    if (options?.limit && options.limit > 0) {
      query += ` LIMIT ?`;
      params.push(options.limit.toString());
    }

    // Convert boolean params to 0/1 for SQL compatibility
    const sqlParams = params.map((p) =>
      typeof p === "boolean" ? (p ? 1 : 0) : p
    );
    const rows = timedQuery<RecordTable[]>(
      this.db,
      query,
      sqlParams,
      "getRecords",
    );

    let nextCursor: string | undefined;
    if (rows.length > 0) {
      const lastRow = rows[rows.length - 1];
      // Convert single item to array if needed for backward compatibility
      const orderByClauses = options?.orderBy ||
        [{ field: "indexedAt", direction: "asc" }];

      // Extract all values needed for the cursor
      const cursorParts: string[] = [];

      for (const { field } of orderByClauses) {
        if (tableColumns.includes(field)) {
          // Direct column access
          cursorParts.push(String(lastRow[field as keyof RecordTable]));
        } else {
          // JSON field access
          const parsedJson = JSON.parse(lastRow.json);
          const fieldPath = field.split(".");
          let value = parsedJson;

          // Navigate nested fields
          for (const key of fieldPath) {
            if (value === undefined || value === null) break;
            value = value[key];
          }

          cursorParts.push(String(value));
        }
      }

      // Always add CID as the final part
      cursorParts.push(lastRow.cid);

      // Join all parts and encode
      const rawCursor = cursorParts.join("|");
      nextCursor = Buffer.from(rawCursor, "utf-8").toString("base64");
    }

    return {
      items: rows.map(
        (r) => ({
          uri: r.uri,
          cid: r.cid,
          did: r.did,
          indexedAt: r.indexedAt,
          ...hydrateBlobRefs(JSON.parse(r.json)),
        } as T),
      ),
      cursor: nextCursor,
    };
  }

  getRecord<T extends Record<string, unknown>>(
    uri: string,
  ): T | undefined {
    const result = this.db.prepare(`SELECT * FROM "record" WHERE uri = ?`).get(
      uri,
    ) as RecordTable | undefined;
    if (!result) return;
    return {
      uri: result.uri,
      cid: result.cid,
      did: result.did,
      indexedAt: result.indexedAt,
      ...hydrateBlobRefs(JSON.parse(result.json)),
    } as T;
  }

  insertRecord(record: RecordTable) {
    this.db.prepare(
      `INSERT INTO "record" (uri, cid, did, collection, json, "indexedAt") VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (uri) DO UPDATE SET cid = excluded.cid, collection = excluded.collection, json = excluded.json, "indexedAt" = excluded."indexedAt"`,
    ).run(
      record.uri,
      record.cid,
      record.did,
      record.collection,
      record.json,
      record.indexedAt,
    );

    const json = JSON.parse(record.json);

    // Sync record_kv
    const collectionKeyMap = this.cfg?.collectionKeyMap || {};
    const indexedKeys = collectionKeyMap[record.collection] || [];
    for (const key of indexedKeys) {
      const value = json[key];
      if (value !== undefined) {
        this.db.prepare(
          `INSERT INTO record_kv (uri, key, value) VALUES (?, ?, ?) ON CONFLICT(uri, key) DO UPDATE SET value = excluded.value`,
        ).run(record.uri, key, String(value));
      }
    }
    // Facet indexing
    if (Array.isArray(json.facets)) {
      // Remove old facets for this uri
      this.db.prepare(`DELETE FROM facet_index WHERE uri = ?`).run(record.uri);
      const facetEntries = indexFacets(record.uri, json.facets);
      for (const entry of facetEntries) {
        this.db.prepare(
          `INSERT INTO facet_index (uri, type, value) VALUES (?, ?, ?)`,
        ).run(
          entry.uri,
          entry.type,
          entry.value,
        );
      }
    }
  }
  updateRecord(record: RecordTable) {
    this.db.prepare(
      `UPDATE "record" SET cid = ?, collection = ?, json = ?, "indexedAt" = ? WHERE uri = ?`,
    ).run(
      record.cid,
      record.collection,
      record.json,
      record.indexedAt,
      record.uri,
    );

    const json = JSON.parse(record.json);

    // Sync record_kv
    const collectionKeyMap = this.cfg?.collectionKeyMap || {};
    const indexedKeys = collectionKeyMap[record.collection] || [];
    // Remove keys not present anymore
    const existingKvs = this.db.prepare(
      `SELECT key FROM record_kv WHERE uri = ?`,
    )
      .all(record.uri) as { key: string }[];
    for (const { key } of existingKvs) {
      if (!indexedKeys.includes(key) || json[key] === undefined) {
        this.db.prepare(`DELETE FROM record_kv WHERE uri = ? AND key = ?`).run(
          record.uri,
          key,
        );
      }
    }
    // Upsert current keys
    for (const key of indexedKeys) {
      const value = json[key];
      if (value !== undefined) {
        this.db.prepare(
          `INSERT INTO record_kv (uri, key, value) VALUES (?, ?, ?) ON CONFLICT(uri, key) DO UPDATE SET value = excluded.value`,
        ).run(record.uri, key, String(value));
      }
    }
    // Facet indexing
    if (Array.isArray(json.facets)) {
      // Remove old facets for this uri
      this.db.prepare(`DELETE FROM facet_index WHERE uri = ?`).run(record.uri);
      const facetEntries = indexFacets(record.uri, json.facets);
      for (const entry of facetEntries) {
        this.db.prepare(
          `INSERT INTO facet_index (uri, type, value) VALUES (?, ?, ?)`,
        ).run(
          entry.uri,
          entry.type,
          entry.value,
        );
      }
    }
  }
  deleteRecord(uri: string) {
    this.db.prepare(`DELETE FROM "record" WHERE uri = ?`).run(uri);
    this.db.prepare(`DELETE FROM record_kv WHERE uri = ?`).run(uri);
  }
  insertActor(actor: ActorTable) {
    this.db.prepare(
      `INSERT INTO "actor" (did, handle, "indexedAt") VALUES (?, ?, ?) ON CONFLICT (did) DO UPDATE SET handle = ?, "indexedAt" = ?`,
    ).run(
      actor.did,
      actor.handle,
      actor.indexedAt,
      actor.handle,
      actor.indexedAt,
    );
  }
  getActor(did: string): ActorTable | undefined {
    const result = this.db.prepare(`SELECT * FROM "actor" WHERE did = ?`).get(
      did,
    );
    return result as ActorTable | undefined;
  }
  getActorByHandle(handle: string): ActorTable | undefined {
    const result = this.db.prepare(`SELECT * FROM "actor" WHERE handle = ?`)
      .get(
        handle,
      );
    return result as ActorTable | undefined;
  }
  searchActors(
    query: string,
  ): ActorTable[] {
    const sql = `SELECT * FROM "actor" WHERE handle LIKE ?`;
    const params: string[] = [`%${query}%`];

    const rows = this.db.prepare(sql).all(...params) as ActorTable[];
    return rows;
  }
  getMentioningUris(did: string): string[] {
    const pattern = `%${did}%`;
    const result = this.db
      .prepare(`
        SELECT uri
        FROM record
        WHERE json LIKE ? AND did != ?
        ORDER BY COALESCE(
          json_extract(json, '$.updatedAt'),
          json_extract(json, '$.createdAt')
        ) DESC
      `)
      .all(pattern, did) as { uri: string }[];
    return result.map((r) => r.uri);
  }
  updateActor(did: string, lastSeenNotifs: string) {
    this.db.prepare(
      `UPDATE actor SET lastSeenNotifs = ? WHERE did = ?`,
    ).run(lastSeenNotifs, did);
  }
  insertLabel(label: LabelTable) {
    this.db.prepare(
      `INSERT INTO labels (src, uri, cid, val, neg, cts, exp)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src, uri, cid, val) DO UPDATE SET
         neg = excluded.neg,
         cts = excluded.cts,
         exp = excluded.exp
       WHERE excluded.cts > labels.cts`,
    ).run(
      label.src,
      label.uri,
      label.cid ?? "",
      label.val,
      label.neg ? 1 : 0,
      label.cts,
      label.exp ?? null,
    );
  }
  queryLabels(
    options: {
      subjects: string[];
      issuers?: string[];
    },
  ) {
    const { subjects, issuers } = options;
    if (!subjects || subjects.length === 0) {
      return [];
    }

    const subjectConds = subjects.map(() => "l1.uri = ?").join(" OR ");
    const issuerConds = issuers && issuers.length > 0
      ? "AND (" + issuers.map(() => "l1.src = ?").join(" OR ") + ")"
      : "";

    const sql = `
      SELECT *
      FROM labels l1
      WHERE (${subjectConds})
        ${issuerConds}
        AND (l1.exp IS NULL OR l1.exp > CURRENT_TIMESTAMP)
        AND l1.cts = (
      SELECT MAX(l2.cts)
      FROM labels l2
      WHERE l2.src = l1.src AND l2.uri = l1.uri AND l2.val = l1.val
        )
        AND l1.neg = 0
    `.replace(/\s+/g, " ").trim();
    const params = [...subjects, ...(issuers ?? [])];
    const rawRows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];

    // Map rawRows to Label[]
    const labels: Label[] = rawRows.map((row) => ({
      src: String(row.src),
      uri: String(row.uri),
      cid: typeof row.cid === "string"
        ? row.cid
        : row.cid === null
        ? undefined
        : String(row.cid),
      val: String(row.val),
      neg: Boolean(row.neg),
      cts: String(row.cts),
      exp: row.exp === null || row.exp === undefined
        ? undefined
        : String(row.exp),
    }));

    return labels;
  }
  clearLabels() {
    this.db.prepare(`DELETE FROM labels`).run();
  }
  countRecords(
    collection: string,
    options?: QueryOptions,
  ) {
    const collectionKeyMap = this.cfg?.collectionKeyMap || {};
    const indexedKeys = collectionKeyMap[collection] || [];
    const tableColumns = ["did", "uri", "indexedAt", "cid"];
    let query: string;
    const params: (string | number | boolean)[] = [];
    const kvAliasMap: Record<string, string> = {};

    let joinClauses = "";
    let i = 0;
    for (const key of indexedKeys) {
      const alias = `kv${i}`;
      kvAliasMap[key] = alias;
      joinClauses +=
        `\nLEFT JOIN record_kv AS ${alias} ON ${alias}.uri = record.uri AND ${alias}.key = ?`;
      params.push(key);
      i++;
    }
    query =
      `SELECT COUNT(*) as count FROM record${joinClauses} WHERE record.collection = ?`;
    params.push(collection);

    // Only add kvN.value = ? if the key is present in the where clause
    const normalizedWhere = Array.isArray(options?.where)
      ? { AND: options.where }
      : options?.where;
    const extraKvClauses: string[] = [];
    if (normalizedWhere && typeof normalizedWhere === "object") {
      for (const key of indexedKeys) {
        let value: string | undefined;
        if (
          "field" in normalizedWhere && normalizedWhere.field === key &&
          normalizedWhere.equals !== undefined
        ) {
          value = String(normalizedWhere.equals);
        }
        // TODO: handle nested/AND/OR if needed
        if (value !== undefined) {
          extraKvClauses.push(`${kvAliasMap[key]}.value = ?`);
          params.push(value);
        }
      }
    }
    if (extraKvClauses.length > 0) {
      query += ` AND ` + extraKvClauses.join(" AND ");
    }

    // Now add the rest of the where clause (for non-indexed keys)
    if (normalizedWhere) {
      try {
        const whereClause = buildWhereClause(
          normalizedWhere,
          tableColumns,
          new Set(indexedKeys),
          params,
          kvAliasMap,
        );
        if (whereClause) query += ` AND (${whereClause})`;
      } catch (err) {
        console.warn("Invalid where clause", err);
      }
    }
    // Convert boolean params to 0/1 for SQL compatibility
    const sqlParams = params.map((p) =>
      typeof p === "boolean" ? (p ? 1 : 0) : p
    );
    const row = timedQuery<{ count: number }>(
      this.db,
      query,
      sqlParams,
      "countRecords",
    );
    return row?.count ?? 0;
  }
  getSession(key: string, applicationType: "web" | "native" = "web") {
    const tableName = applicationType === "web"
      ? "auth_session"
      : "auth_session_native";
    const result = this.db
      .prepare(`SELECT session FROM ${tableName} WHERE key = ?`)
      .get(key) as { session: string } | undefined;
    if (!result?.session) return undefined;
    try {
      return JSON.parse(result.session) as NodeSavedSession;
    } catch {
      return undefined;
    }
  }
  getState(key: string): NodeSavedState | undefined {
    // Try web state table first
    let result = this.db.prepare(`SELECT state FROM auth_state WHERE key = ?`)
      .get(
        key,
      ) as { state?: string } | undefined;
    if (result?.state) {
      try {
        return JSON.parse(result.state) as NodeSavedState;
      } catch {
        return undefined;
      }
    }
    // Try native state table if not found in web
    result = this.db.prepare(
      `SELECT state FROM auth_state_native WHERE key = ?`,
    )
      .get(key) as { state?: string } | undefined;
    if (result?.state) {
      try {
        return JSON.parse(result.state) as NodeSavedState;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  insertAuthToken(
    did: string,
    refreshToken: string,
    issuedAt: string,
    expiresAt: string,
  ) {
    this.db.prepare(
      `INSERT INTO auth_token (did, refreshToken, issuedAt, expiresAt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(did) DO UPDATE SET refreshToken = excluded.refreshToken, issuedAt = excluded.issuedAt, expiresAt = excluded.expiresAt`,
    ).run(did, refreshToken, issuedAt, expiresAt);
  }
  deleteAuthToken(did: string) {
    this.db.prepare(`DELETE FROM auth_token WHERE did = ?`).run(did);
  }
  getActorByRefreshToken(refreshToken: string): ActorTable | undefined {
    const tokenRow = this.db.prepare(
      `SELECT did FROM auth_token WHERE refreshToken = ?`,
    ).get(refreshToken) as { did?: string } | undefined;
    if (!tokenRow?.did) return undefined;
    return this.db.prepare(`SELECT * FROM actor WHERE did = ?`).get(
      tokenRow.did,
    ) as ActorTable | undefined;
  }
}

export const createIndexService = (
  db: Database,
  cfg: BffConfig,
) => {
  return new IndexService(db, cfg);
};
