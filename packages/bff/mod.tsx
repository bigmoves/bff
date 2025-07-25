import {
  isMention,
  isTag,
  type Main as Facet,
} from "$lexicon/types/app/bsky/richtext/facet.ts";
import type { Label } from "$lexicon/types/com/atproto/label/defs.ts";
import { Agent } from "@atproto/api";
import { TID } from "@atproto/common";
import { type AtprotoData, DidResolver, MemoryCache } from "@atproto/identity";
import { type BlobRef, Lexicons, stringifyLex } from "@atproto/lexicon";
import { OAuthResolverError } from "@atproto/oauth-client";
import { AtUri } from "@atproto/syntax";
import {
  AtprotoOAuthClient,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  type NodeSavedStateStore,
} from "@bigmoves/atproto-oauth-client";
import { JoseKey } from "@bigmoves/atproto-oauth-client/jose_key.ts";
import { assert } from "@std/assert";
import { TtlCache } from "@std/cache";
import * as colors from "@std/fmt/colors";
import { deleteCookie, getCookies, setCookie } from "@std/http";
import { serveDir } from "@std/http/file-server";
import { join } from "@std/path/join";
import jwt from "jsonwebtoken";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ComponentChildren, VNode } from "preact";
import { render as renderToString } from "preact-render-to-string";
import { Login } from "./components/Login.tsx";
import { RateLimitError, UnauthorizedError } from "./errors.ts";
import { Jetstream } from "./jetstream.ts";
import Labeler from "./labeler.ts";
import { CSS } from "./styles.ts";
import type {
  ActorTable,
  ApplicationType,
  BffConfig,
  BffContext,
  BffMiddleware,
  BffOptions,
  Database,
  FacetIndexTable,
  HttpMethod,
  IndexService,
  LabelerPolicies,
  LabelTable,
  OauthMiddlewareOptions,
  QueryOptions,
  RecordTable,
  RootProps,
  RouteHandler,
  Where,
  WhereCondition,
} from "./types.d.ts";
import { hydrateBlobRefs } from "./utils.ts";

export { RateLimitError, UnauthorizedError } from "./errors.ts";
export { JETSTREAM } from "./jetstream.ts";
export type {
  ActorTable,
  BffContext,
  BffMiddleware,
  BffOptions,
  LabelerPolicies,
  onListenArgs,
  onSignedInArgs,
  QueryOptions,
  RecordTable,
  RootProps,
  RouteHandler,
  WithBffMeta,
} from "./types.d.ts";

export { CSS } from "./styles.ts";

export async function bff(opts: BffOptions) {
  const bffConfig = configureBff(opts);

  const didCache = new MemoryCache();
  const didResolver = new DidResolver({
    plcUrl: bffConfig.plcDirectoryUrl,
    didCache,
  });

  const fileFingerprints = await generateFingerprints(bffConfig);

  const db = createDb(bffConfig);
  const idxService = indexService(db, bffConfig);
  const oauthClient = await createOauthClient(db, bffConfig);
  const oauthClientNative = await createOauthClient(db, bffConfig, "native");
  const handler = createBffHandler({
    db,
    oauthClient,
    oauthClientNative,
    cfg: bffConfig,
    didResolver,
    fileFingerprints,
  });
  const jetstream = createSubscription(idxService, bffConfig);
  const labelerMap = await createLabelerSubscriptions(
    didResolver,
    idxService,
    bffConfig,
  );

  if (
    bffConfig.jetstreamUrl &&
    (bffConfig.collections?.length || bffConfig.externalCollections?.length)
  ) {
    jetstream.connect().catch((err) => {
      console.error("Jetstream connection failed:", err);
    });
  }

  if (labelerMap.size > 0) {
    for (const labeler of labelerMap.values()) {
      labeler.connect().catch((err) => {
        console.error("Labeler connection failed:", err);
      });
    }
  }

  // TODO: maybe should be onBeforeListen
  await bffConfig.onListen?.({
    indexService: idxService,
    cfg: bffConfig,
  });

  Deno.serve({
    port: bffConfig.port,
    onListen({ port, hostname }) {
      if (hostname === "0.0.0.0") {
        hostname = "localhost";
      }
      console.log();
      console.log(
        colors.bgRgb8(colors.rgb8(" ✨ BFF ready ", 0), 75),
      );
      const localLabel = colors.bold("Local:");
      const address = colors.cyan(
        `http://${hostname}:${port}`,
      );
      console.log(`    ${localLabel}  ${address}`);
    },
    onError: (err) => {
      if (bffConfig.onError) {
        return bffConfig.onError(err);
      }
      if (err instanceof UnauthorizedError) {
        return new Response("Unauthorized", {
          status: 401,
        });
      }
      if (err instanceof RateLimitError) {
        return new Response(err.message, {
          status: 429,
          headers: {
            ...err.retryAfter && { "Retry-After": err.retryAfter.toString() },
            "Content-Type": "text/plain",
          },
        });
      }
      console.error("Internal server error:", err);
      return new Response("Internal Server Error", {
        status: 500,
      });
    },
  }, (req, info) => {
    if (bffConfig.notificationsOnly) {
      const wsResponse = handleWebSocketUpgrade(req, bffConfig);
      if (wsResponse) return wsResponse;
    }
    return handler(req, info);
  });

  Deno.addSignalListener("SIGINT", () => {
    console.log("Shutting down server...");
    jetstream.disconnect();
    for (const labeler of labelerMap.values()) {
      labeler.disconnect();
    }
    db.close();
    Deno.exit(0);
  });
}

function configureBff(cfg: BffOptions): BffConfig {
  return {
    ...cfg,
    rootDir: Deno.env.get("BFF_ROOT_DIR") ?? Deno.cwd(),
    publicUrl: Deno.env.get("BFF_PUBLIC_URL") ?? "",
    port: Number(Deno.env.get("BFF_PORT")) || 8080,
    litefsDir: Deno.env.get("BFF_LITEFS_DIR") ?? "/litefs",
    databaseUrl: cfg.databaseUrl ?? Deno.env.get("BFF_DATABASE_URL") ??
      ":memory:",
    cookieSecret: Deno.env.get("BFF_COOKIE_SECRET") ??
      "000000000000000000000000000000000",
    privateKey1: Deno.env.get("BFF_PRIVATE_KEY_1"),
    privateKey2: Deno.env.get("BFF_PRIVATE_KEY_2"),
    privateKey3: Deno.env.get("BFF_PRIVATE_KEY_3"),
    jwtSecret: Deno.env.get("BFF_JWT_SECRET"),
    plcDirectoryUrl: Deno.env.get("BFF_PLC_DIRECTORY_URL") ??
      "https://plc.directory",
    jetstreamUrl: cfg.jetstreamUrl ?? Deno.env.get("BFF_JETSTREAM_URL"),
    lexicons: cfg.lexicons ?? new Lexicons(),
    oauthScope: cfg.oauthScope ?? "atproto transition:generic",
    middlewares: cfg.middlewares ?? [],
    rootElement: cfg.rootElement ?? Root,
    buildDir: cfg.buildDir ?? "build",
  };
}

const wsClients = new Map<string, Set<WebSocket>>();

function handleWebSocketUpgrade(
  req: Request,
  bffConfig: BffConfig,
): Response | undefined {
  const { pathname } = new URL(req.url);
  if (pathname !== "/ws" || req.headers.get("upgrade") !== "websocket") {
    return undefined;
  }
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    // Extract DID from JWT in Authorization header
    const did = parseJwtFromAuthHeader(req, bffConfig);
    if (!did) {
      console.warn("WebSocket connection rejected: missing or invalid DID");
      socket.close();
      return;
    }
    if (!wsClients.has(did)) wsClients.set(did, new Set());
    wsClients.get(did)!.add(socket);
    console.log(`WebSocket connected for DID: ${did}`);

    // Only notify client to refresh notifications
    console.log("About to send refresh-notifications");
    try {
      socket.send(JSON.stringify({ type: "refresh-notifications" }));
      console.log("Sent refresh-notifications");
    } catch (err) {
      console.error("Error sending refresh-notifications:", err);
    }
  };

  socket.onclose = () => {
    let disconnectedDid: string | undefined;
    for (const [did, sockets] of wsClients.entries()) {
      if (sockets.has(socket)) {
        sockets.delete(socket);
        disconnectedDid = did;
        if (sockets.size === 0) wsClients.delete(did);
        break;
      }
    }
    if (disconnectedDid) {
      console.log(`WebSocket disconnected for DID: ${disconnectedDid}`);
    } else {
      console.log("WebSocket disconnected for unknown DID");
    }
  };

  return response;
}

function createDb(cfg: BffConfig) {
  const db = new DatabaseSync(cfg.databaseUrl);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS "auth_session" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "session" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "auth_state" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "state" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "auth_session_native" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "session" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "auth_state_native" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "state" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_token (
      did TEXT PRIMARY KEY NOT NULL,
      refreshToken TEXT NOT NULL,
      issuedAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "actor" (
      "did" TEXT PRIMARY KEY NOT NULL,
      "handle" TEXT,
      "indexedAt" TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS actor_handle_idx ON actor(handle);

    CREATE TABLE IF NOT EXISTS "record" (
      "uri" TEXT PRIMARY KEY NOT NULL,
      "cid" TEXT NOT NULL,
      "did" TEXT NOT NULL,
      "collection" TEXT NOT NULL,
      "json" TEXT NOT NULL,
      "indexedAt" TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_record_did ON record(did);
    CREATE INDEX IF NOT EXISTS idx_record_collection ON record(collection);
    CREATE INDEX IF NOT EXISTS idx_record_did_collection ON record(did, collection);

    CREATE TABLE IF NOT EXISTS record_kv (
      uri TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (uri, key)
    );

    CREATE INDEX IF NOT EXISTS idx_record_kv_uri ON record_kv(uri);
    CREATE INDEX IF NOT EXISTS idx_record_kv_key_value ON record_kv(key, value);

    CREATE TABLE IF NOT EXISTS "rate_limit" (
      "key" TEXT NOT NULL,
      "namespace" TEXT NOT NULL,
      "points" INTEGER NOT NULL,
      "resetAt" TEXT NOT NULL,
      PRIMARY KEY ("key", "namespace")
    );

    CREATE TABLE IF NOT EXISTS locks (
      "key" TEXT PRIMARY KEY,
      "createdAt" DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS labels (
      src TEXT NOT NULL,
      uri TEXT NOT NULL,
      cid TEXT,
      val TEXT NOT NULL,
      neg BOOLEAN DEFAULT FALSE,
      cts DATETIME NOT NULL,
      exp DATETIME,
      PRIMARY KEY (src, uri, cid, val)
    );

    CREATE TABLE IF NOT EXISTS "facet_index" (
      "uri" TEXT NOT NULL,         -- References record.uri
      "type" TEXT NOT NULL,        -- e.g. 'mention', 'tag'
      "value" TEXT NOT NULL,       -- e.g. did for mention, tag string for hashtag
      PRIMARY KEY ("uri", "type", "value"),
      FOREIGN KEY ("uri") REFERENCES record("uri") ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS facet_index_type_value ON facet_index (type, value);
  `);

  // @TODO: Move this to the actor create table statement once there's a built
  // in solution for full sync (don't want to break existing tables)
  const exists = db.prepare(`
    SELECT 1 FROM pragma_table_info('actor') WHERE name = 'lastSeenNotifs'
  `).get();

  if (!exists) {
    db.prepare(`ALTER TABLE actor ADD COLUMN lastSeenNotifs TEXT`).run();
  }

  return db;
}

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

const indexService = (
  db: Database,
  cfg: BffConfig,
): IndexService => {
  return {
    getRecords: <T extends Record<string, unknown>>(
      collection: string,
      options?: QueryOptions,
    ) => {
      const collectionKeyMap = cfg?.collectionKeyMap || {};
      const indexedKeys = collectionKeyMap[collection] || [];
      const tableColumns = ["did", "uri", "indexedAt", "cid"];
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
        db,
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
    },
    getRecord: <T extends Record<string, unknown>>(
      uri: string,
    ): T | undefined => {
      const result = db.prepare(`SELECT * FROM "record" WHERE uri = ?`).get(
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
    },
    insertRecord: (record: RecordTable) => {
      db.prepare(
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
      const collectionKeyMap = cfg?.collectionKeyMap || {};
      const indexedKeys = collectionKeyMap[record.collection] || [];
      for (const key of indexedKeys) {
        const value = json[key];
        if (value !== undefined) {
          db.prepare(
            `INSERT INTO record_kv (uri, key, value) VALUES (?, ?, ?) ON CONFLICT(uri, key) DO UPDATE SET value = excluded.value`,
          ).run(record.uri, key, String(value));
        }
      }
      // Facet indexing
      if (Array.isArray(json.facets)) {
        // Remove old facets for this uri
        db.prepare(`DELETE FROM facet_index WHERE uri = ?`).run(record.uri);
        const facetEntries = indexFacets(record.uri, json.facets);
        for (const entry of facetEntries) {
          db.prepare(
            `INSERT INTO facet_index (uri, type, value) VALUES (?, ?, ?)`,
          ).run(
            entry.uri,
            entry.type,
            entry.value,
          );
        }
      }
    },
    updateRecord: (record: RecordTable) => {
      db.prepare(
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
      const collectionKeyMap = cfg?.collectionKeyMap || {};
      const indexedKeys = collectionKeyMap[record.collection] || [];
      // Remove keys not present anymore
      const existingKvs = db.prepare(`SELECT key FROM record_kv WHERE uri = ?`)
        .all(record.uri) as { key: string }[];
      for (const { key } of existingKvs) {
        if (!indexedKeys.includes(key) || json[key] === undefined) {
          db.prepare(`DELETE FROM record_kv WHERE uri = ? AND key = ?`).run(
            record.uri,
            key,
          );
        }
      }
      // Upsert current keys
      for (const key of indexedKeys) {
        const value = json[key];
        if (value !== undefined) {
          db.prepare(
            `INSERT INTO record_kv (uri, key, value) VALUES (?, ?, ?) ON CONFLICT(uri, key) DO UPDATE SET value = excluded.value`,
          ).run(record.uri, key, String(value));
        }
      }
      // Facet indexing
      if (Array.isArray(json.facets)) {
        // Remove old facets for this uri
        db.prepare(`DELETE FROM facet_index WHERE uri = ?`).run(record.uri);
        const facetEntries = indexFacets(record.uri, json.facets);
        for (const entry of facetEntries) {
          db.prepare(
            `INSERT INTO facet_index (uri, type, value) VALUES (?, ?, ?)`,
          ).run(
            entry.uri,
            entry.type,
            entry.value,
          );
        }
      }
    },
    deleteRecord: (uri: string) => {
      db.prepare(`DELETE FROM "record" WHERE uri = ?`).run(uri);
      db.prepare(`DELETE FROM record_kv WHERE uri = ?`).run(uri);
    },
    insertActor: (actor: ActorTable) => {
      db.prepare(
        `INSERT INTO "actor" (did, handle, "indexedAt") VALUES (?, ?, ?) ON CONFLICT (did) DO UPDATE SET handle = ?, "indexedAt" = ?`,
      ).run(
        actor.did,
        actor.handle,
        actor.indexedAt,
        actor.handle,
        actor.indexedAt,
      );
    },
    getActor: (did: string): ActorTable | undefined => {
      const result = db.prepare(`SELECT * FROM "actor" WHERE did = ?`).get(did);
      return result as ActorTable | undefined;
    },
    getActorByHandle: (handle: string): ActorTable | undefined => {
      const result = db.prepare(`SELECT * FROM "actor" WHERE handle = ?`).get(
        handle,
      );
      return result as ActorTable | undefined;
    },
    searchActors: (
      query: string,
    ): ActorTable[] => {
      const sql = `SELECT * FROM "actor" WHERE handle LIKE ?`;
      const params: string[] = [`%${query}%`];

      const rows = db.prepare(sql).all(...params) as ActorTable[];
      return rows;
    },
    getMentioningUris: (did: string): string[] => {
      const pattern = `%${did}%`;
      const result = db
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
    },
    updateActor: (did: string, lastSeenNotifs: string) => {
      db.prepare(
        `UPDATE actor SET lastSeenNotifs = ? WHERE did = ?`,
      ).run(lastSeenNotifs, did);
    },
    insertLabel: (label: LabelTable) => {
      db.prepare(
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
    },
    queryLabels: (
      options: {
        subjects: string[];
        issuers?: string[];
      },
    ) => {
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
      const rawRows = db.prepare(sql).all(...params) as Record<
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
    },
    clearLabels: () => {
      db.prepare(`DELETE FROM labels`).run();
    },
    countRecords: (
      collection: string,
      options?: QueryOptions,
    ) => {
      const collectionKeyMap = cfg?.collectionKeyMap || {};
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
        db,
        query,
        sqlParams,
        "countRecords",
      );
      return row?.count ?? 0;
    },
    getSession: (key: string, applicationType: "web" | "native" = "web") => {
      const tableName = applicationType === "web"
        ? "auth_session"
        : "auth_session_native";
      const result = db
        .prepare(`SELECT session FROM ${tableName} WHERE key = ?`)
        .get(key) as { session: string } | undefined;
      if (!result?.session) return undefined;
      try {
        return JSON.parse(result.session) as NodeSavedSession;
      } catch {
        return undefined;
      }
    },
    getState: (key: string): NodeSavedState | undefined => {
      // Try web state table first
      let result = db.prepare(`SELECT state FROM auth_state WHERE key = ?`).get(
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
      result = db.prepare(`SELECT state FROM auth_state_native WHERE key = ?`)
        .get(key) as { state?: string } | undefined;
      if (result?.state) {
        try {
          return JSON.parse(result.state) as NodeSavedState;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    insertAuthToken: (
      did: string,
      refreshToken: string,
      issuedAt: string,
      expiresAt: string,
    ) => {
      db.prepare(
        `INSERT INTO auth_token (did, refreshToken, issuedAt, expiresAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(did) DO UPDATE SET refreshToken = excluded.refreshToken, issuedAt = excluded.issuedAt, expiresAt = excluded.expiresAt`,
      ).run(did, refreshToken, issuedAt, expiresAt);
    },
    deleteAuthToken: (did: string) => {
      db.prepare(`DELETE FROM auth_token WHERE did = ?`).run(did);
    },
    getActorByRefreshToken: (refreshToken: string): ActorTable | undefined => {
      const tokenRow = db.prepare(
        `SELECT did FROM auth_token WHERE refreshToken = ?`,
      ).get(refreshToken) as { did?: string } | undefined;
      if (!tokenRow?.did) return undefined;
      return db.prepare(`SELECT * FROM actor WHERE did = ?`).get(
        tokenRow.did,
      ) as ActorTable | undefined;
    },
  };
};

function createBffHandler({
  db,
  oauthClient,
  oauthClientNative,
  cfg,
  didResolver,
  fileFingerprints,
}: {
  db: Database;
  oauthClient: AtprotoOAuthClient;
  oauthClientNative: AtprotoOAuthClient;
  cfg: BffConfig;
  didResolver: DidResolver;
  fileFingerprints: Map<string, string>;
}) {
  const inner = handler;
  const withMiddlewares = composeMiddlewares({
    db,
    oauthClient,
    oauthClientNative,
    cfg,
    didResolver,
    fileFingerprints,
  });
  return function handler(req: Request, connInfo: Deno.ServeHandlerInfo) {
    return withMiddlewares(req, connInfo, inner);
  };
}

function indexFacets(uri: string, facets: Facet[]): FacetIndexTable[] {
  return facets.flatMap((facet) => facet.features)
    .flatMap((feature) => {
      if (isMention(feature)) {
        return {
          uri,
          type: "mention",
          value: feature.did,
        };
      } else if (isTag(feature)) {
        return {
          uri,
          type: "tag",
          value: feature.tag.toLowerCase(),
        };
      }
      return null;
    })
    .filter((entry): entry is FacetIndexTable => entry !== null);
}

function composeMiddlewares({
  db,
  oauthClient,
  oauthClientNative,
  cfg,
  didResolver,
  fileFingerprints,
}: {
  db: Database;
  oauthClient: AtprotoOAuthClient;
  oauthClientNative: AtprotoOAuthClient;
  cfg: BffConfig;
  didResolver: DidResolver;
  fileFingerprints: Map<string, string>;
}) {
  return async (
    req: Request,
    _connInfo: Deno.ServeHandlerInfo,
    inner: (req: Request, ctx: BffContext) => Promise<Response>,
  ) => {
    const idxService = indexService(db, cfg);

    let agent: Agent | undefined;
    let currentUser: ActorTable | undefined;

    const cookie = getCookies(req.headers);
    let sessionDid: string | undefined;

    if (cookie.auth) {
      try {
        sessionDid = await parseCookie(cookie.auth, cfg.cookieSecret);
        if (!sessionDid) {
          throw new Error("Failed to parse cookie");
        }
        const oauthSession = await oauthClient.restore(sessionDid);
        agent = new Agent(oauthSession);
      } catch (err) {
        console.error("failed to restore oauth session", err);
      }
    }

    if (!agent) {
      // Try to parse DID from JWT in Authorization header
      sessionDid = parseJwtFromAuthHeader(req, cfg);
      if (sessionDid) {
        const oauthSession = await oauthClientNative.restore(sessionDid);
        agent = new Agent(oauthSession);
      }
    }

    if (agent && sessionDid) {
      const actor = idxService.getActor(sessionDid);
      currentUser = actor;
    }

    const createRecordFn = createRecord(agent, idxService, cfg);
    const createRecordsFn = createRecords(agent, idxService, cfg);
    const updateRecordFn = updateRecord(agent, idxService, cfg);
    const updateRecordsFn = updateRecords(agent, idxService, cfg);
    const deleteRecordFn = deleteRecord(agent, idxService);
    const backfillCollectionsFn = backfillCollections(idxService, cfg);
    const backfillUrisFn = backfillUris(idxService, cfg);
    const uploadBlobFn = uploadBlob(agent);
    const rateLimitFn = rateLimit(req, currentUser, db);
    const getNotificationsFn = getNotifications(currentUser, idxService);
    const updateSeenFn = updateSeen(currentUser, idxService);
    const getLabelerDefinitionsFn = getLabelerDefinitions(didResolver, cfg);

    const ctx: BffContext = {
      state: {},
      oauthClient,
      oauthClientNative,
      indexService: idxService,
      currentUser,
      agent,
      createRecord: createRecordFn,
      createRecords: createRecordsFn,
      updateRecord: updateRecordFn,
      updateRecords: updateRecordsFn,
      deleteRecord: deleteRecordFn,
      backfillCollections: backfillCollectionsFn,
      backfillUris: backfillUrisFn,
      uploadBlob: uploadBlobFn,
      didResolver,
      render: () => new Response(),
      html: html(),
      json: json(),
      redirect: redirect(req.headers),
      cfg,
      next: async () => new Response(),
      rateLimit: rateLimitFn,
      requireAuth: function () {
        return requireAuth(this);
      },
      getNotifications: getNotificationsFn,
      updateSeen: updateSeenFn,
      getLabelerDefinitions: getLabelerDefinitionsFn,
      fileFingerprints,
    };

    ctx.render = render(ctx, cfg);

    const middlewares = cfg.middlewares || [];

    const composedHandler = composeHandlers([...middlewares, inner]);

    return composedHandler(req, ctx);
  };

  function composeHandlers(
    handlers: Array<(req: Request, ctx: BffContext) => Promise<Response>>,
  ) {
    return (
      request: Request,
      context: BffContext,
    ): Promise<Response> => {
      const handlersToRun = [...handlers];

      async function runNext(): Promise<Response> {
        if (handlersToRun.length === 0) {
          return new Response();
        }

        const currentHandler = handlersToRun.shift()!;
        context.next = runNext;

        return currentHandler(request, context);
      }

      context.next = runNext;
      return runNext();
    };
  }
}

function parseJwtFromAuthHeader(
  req: Request,
  cfg: BffConfig,
): string | undefined {
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!bearerToken) {
    return undefined;
  }

  let did: string | undefined;

  if (!cfg.jwtSecret) {
    console.error("BFF_JWT_SECRET secret is not configured");
    return undefined;
  }

  try {
    const decoded = jwt.verify(bearerToken, cfg.jwtSecret);
    did = decoded.did as string;
  } catch (_err) {
    console.error("JWT verification failed:", _err);
    return undefined;
  }
  return did;
}

async function handler(req: Request, ctx: BffContext) {
  const { pathname } = new URL(req.url);

  if (pathname.startsWith(`/${ctx.cfg.buildDir}/`)) {
    return serveDir(req, {
      fsRoot: ctx.cfg.rootDir,
    });
  }

  return new Response("Not found", {
    status: 404,
  });
}

function notifyMentionedDids(
  did: string,
  record: unknown,
) {
  // Find all DIDs mentioned in the record JSON
  const jsonStr = stringifyLex(record);
  const didRegex = /did:[a-z0-9]+:[a-zA-Z0-9._-]+/g;
  const mentionedDids = Array.from(new Set(jsonStr.match(didRegex) || []));
  for (const mentionedDid of mentionedDids) {
    if (mentionedDid === did) continue;
    if (wsClients.has(mentionedDid)) {
      for (const ws of wsClients.get(mentionedDid) ?? []) {
        ws.send(JSON.stringify({ type: "refresh-notifications" }));
      }
    }
  }
}

function notifyAllConnectedClients() {
  for (const sockets of wsClients.values()) {
    for (const ws of sockets) {
      ws.send(JSON.stringify({ type: "refresh-notifications" }));
    }
  }
}

function createSubscription(
  indexService: IndexService,
  cfg: BffConfig,
) {
  const jetstream = new Jetstream({
    instanceUrl: cfg.jetstreamUrl,
    wantedCollections: [
      ...(cfg.collections || []),
      ...(cfg.externalCollections || []),
    ],
    handleEvent: async (event) => {
      if (event.kind !== "commit" || !event.commit) return;

      const { currentIsPrimary } = await getInstanceInfo(cfg);
      if (!currentIsPrimary) return;

      const { did, commit } = event;
      const { collection, operation, rkey, cid, record } = commit;
      const uri = `at://${did}/${collection}/${rkey}`;

      // For external collections, verify the actor exists in the database
      if (cfg.externalCollections?.includes(collection)) {
        const actor = indexService.getActor(did);
        if (!actor) return;
      }

      console.log(`Received ${operation} event for ${uri}`);

      // Notifications-only mode: skip DB ops, just push notifications
      if (cfg.notificationsOnly) {
        if (operation === "create" || operation === "update") {
          try {
            cfg.lexicons.assertValidRecord(
              collection,
              hydrateBlobRefs(record),
            );
          } catch (err) {
            console.error(`Invalid record for ${uri}:`, err);
            return;
          }
          notifyMentionedDids(did, record);
        } else if (operation === "delete") {
          notifyAllConnectedClients();
        }
        return;
      }

      if (operation === "create" || operation === "update") {
        try {
          cfg.lexicons.assertValidRecord(
            collection,
            hydrateBlobRefs(record),
          );
        } catch (err) {
          console.error(`Invalid record for ${uri}:`, err);
          return;
        }

        try {
          indexService.insertRecord({
            uri,
            cid,
            did,
            collection,
            json: stringifyLex(record),
            indexedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`Failed to insert record for ${uri}:`, err);
          return;
        }
      } else if (operation === "delete") {
        try {
          indexService.deleteRecord(uri);
        } catch (err) {
          console.error(`Failed to delete record for ${uri}:`, err);
          return;
        }
      }
    },
  });

  return jetstream;
}

async function createOauthClient(
  db: Database,
  cfg: BffConfig,
  applicationType: ApplicationType = "web",
) {
  const publicUrl = cfg.publicUrl;
  const url = publicUrl || `http://127.0.0.1:${cfg.port}`;
  const enc = encodeURIComponent;
  const scope = cfg.oauthScope;

  const hasPrivateKeys =
    !!(cfg.privateKey1 && cfg.privateKey2 && cfg.privateKey3);

  // const requestLock = createLock(db, cfg);

  return new AtprotoOAuthClient({
    plcDirectoryUrl: cfg.plcDirectoryUrl,
    responseMode: "query",
    clientMetadata: {
      client_name: cfg.appName,
      client_id: publicUrl
        ? `${url}${OAUTH_ROUTES.clientMetadata}`
        : `http://localhost?redirect_uri=${
          enc(
            `${url}/oauth/callback`,
          )
        }&scope=${enc(scope)}`,
      client_uri: url,
      jwks_uri: `${url}${OAUTH_ROUTES.jwks}`,
      redirect_uris: [`${url}${OAUTH_ROUTES.callback}`],
      scope,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: hasPrivateKeys ? "private_key_jwt" : "none",
      dpop_bound_access_tokens: true,
      ...hasPrivateKeys && { token_endpoint_auth_signing_alg: "ES256" },
    },
    stateStore: createStateStore(db, applicationType),
    sessionStore: createSessionStore(db, applicationType),
    ...hasPrivateKeys && {
      // @TODO: fix this type assertion
      keyset: (await Promise.all([
        JoseKey.fromImportable(cfg.privateKey1 ?? "{}"),
        JoseKey.fromImportable(cfg.privateKey2 ?? "{}"),
        JoseKey.fromImportable(cfg.privateKey3 ?? "{}"),
      ])) as unknown as ConstructorParameters<
        typeof AtprotoOAuthClient
      >[0]["keyset"],
    },
  });
}

function createStateStore(
  db: Database,
  applicationType: ApplicationType,
): NodeSavedStateStore {
  const tableName = applicationType === "web"
    ? "auth_state"
    : "auth_state_native";
  return {
    get(key: string): NodeSavedState | undefined {
      const result = db
        .prepare(`SELECT state FROM ${tableName} WHERE key = ?`)
        .get(key) as { state: string };
      if (!result.state) return;
      return JSON.parse(result.state) as NodeSavedState;
    },
    set(key: string, val: NodeSavedState) {
      const state = JSON.stringify(val);
      db.prepare(
        `INSERT INTO ${tableName} (key, state) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET state = ?`,
      ).run(key, state, state);
    },
    del(key: string) {
      db.prepare(`DELETE FROM ${tableName} WHERE key = ?`).run(key);
    },
  };
}

interface SqliteError extends Error {
  code?: string;
}

function createLock(db: Database, cfg: BffConfig) {
  return async <T,>(key: string, fn: () => T | PromiseLike<T>): Promise<T> => {
    const { currentIsPrimary } = await getInstanceInfo(cfg);
    if (!currentIsPrimary) {
      return Promise.resolve(fn());
    }

    const acquireLock = () => {
      try {
        db.prepare("INSERT INTO locks (key) VALUES (?)").run(key);
        return true;
      } catch (err) {
        const sqliteErr = err as SqliteError;
        if (sqliteErr.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
          return false; // lock already held
        }
        throw err;
      }
    };

    const releaseLock = () => {
      db.prepare("DELETE FROM locks WHERE key = ?").run(key);
    };

    const waitForLock = async () => {
      const start = Date.now();
      const timeout = 30000; // 30s
      while (Date.now() - start < timeout) {
        if (acquireLock()) return;
        await new Promise((resolve) => setTimeout(resolve, 100)); // retry every 100ms
      }
      throw new Error("Timeout acquiring SQLite lock");
    };

    await waitForLock();
    try {
      return await fn();
    } finally {
      releaseLock();
    }
  };
}

function createSessionStore(
  db: Database,
  applicationType: ApplicationType = "web",
): NodeSavedSessionStore {
  const tableName = applicationType === "web"
    ? "auth_session"
    : "auth_session_native";
  return {
    get(key: string): NodeSavedSession | undefined {
      const result = db
        .prepare(`SELECT session FROM ${tableName} WHERE key = ?`)
        .get(key) as { session: string } | undefined;
      if (!result) return;
      return JSON.parse(result.session) as NodeSavedSession;
    },
    set(key: string, val: NodeSavedSession) {
      const session = JSON.stringify(val);
      db.prepare(
        `INSERT INTO ${tableName} (key, session) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET session = ?`,
      ).run(key, session, session);
    },
    del(key: string) {
      db.prepare(`DELETE FROM ${tableName} WHERE key = ?`).run(key);
    },
  };
}

function createRecord(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (
    collection: string,
    data: { [_ in string]: unknown },
    self: boolean = false,
  ) => {
    const did = agent?.assertDid;
    const rkey = self ? "self" : TID.nextStr();

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const record = {
      $type: collection,
      ...data,
    };

    assert(cfg.lexicons.assertValidRecord(collection, record));

    const response = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection,
      rkey,
      record,
      validate: false,
    });

    const uri = `at://${did}/${collection}/${rkey}`;
    indexService.insertRecord({
      uri,
      cid: response.data.cid.toString(),
      did,
      collection,
      json: stringifyLex(record),
      indexedAt: new Date().toISOString(),
    });
    return uri;
  };
}

function createRecords(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (creates: {
    collection: string;
    rkey?: string;
    data: { [_ in string]: unknown };
  }[]) => {
    const did = agent?.assertDid;
    if (!did) throw new Error("Agent is not authenticated");

    const records = creates.map(({ collection, data }) => ({
      $type: collection,
      ...data,
    }));

    creates = creates.map((c) => ({
      ...c,
      rkey: c.rkey || TID.nextStr(),
    }));

    creates.forEach(({ collection }, i) => {
      assert(cfg.lexicons.assertValidRecord(collection, records[i]));
    });

    const results: string[] = [];

    try {
      const response = await agent.com.atproto.repo.applyWrites({
        repo: did,
        validate: false,
        writes: creates.map(({ collection, rkey, data }) => ({
          $type: "com.atproto.repo.applyWrites#create",
          collection,
          rkey,
          value: data,
        })),
      });

      const cidMap = new Map<string, string>();
      for (const result of response?.data?.results ?? []) {
        if (result.$type === "com.atproto.repo.applyWrites#createResult") {
          cidMap.set(result.uri, result.cid);
        }
      }

      for (let i = 0; i < creates.length; i++) {
        const { collection, rkey } = creates[i];
        const record = records[i];

        const uri = `at://${did}/${collection}/${rkey}`;

        indexService.insertRecord({
          uri,
          cid: cidMap.get(uri) ?? "",
          did,
          collection,
          json: stringifyLex(record),
          indexedAt: new Date().toISOString(),
        });

        results.push(uri);
      }
    } catch (error) {
      console.error("Error creating records:", error);
      throw new Error("Failed to create records");
    }
    return results;
  };
}

function updateRecord(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (
    collection: string,
    rkey: string,
    data: { [_ in string]: unknown },
  ) => {
    const did = agent?.assertDid;

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const record = {
      $type: collection,
      ...data,
    };

    assert(cfg.lexicons.assertValidRecord(collection, record));

    const response = await agent.com.atproto.repo.putRecord({
      repo: agent.assertDid,
      collection,
      rkey,
      record,
      validate: false,
    });

    const uri = `at://${did}/${collection}/${rkey}`;
    indexService.updateRecord({
      uri,
      cid: response.data.cid.toString(),
      did,
      collection,
      json: stringifyLex(record),
      indexedAt: new Date().toISOString(),
    });
    return uri;
  };
}

function updateRecords(
  agent: Agent | undefined,
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (updates: {
    collection: string;
    rkey: string;
    data: { [_ in string]: unknown };
  }[]) => {
    const did = agent?.assertDid;
    if (!did) throw new Error("Agent is not authenticated");

    const records = updates.map(({ collection, data }) => ({
      $type: collection,
      ...data,
    }));

    updates.forEach(({ collection }, i) => {
      assert(cfg.lexicons.assertValidRecord(collection, records[i]));
    });

    const results: string[] = [];

    try {
      const response = await agent.com.atproto.repo.applyWrites({
        repo: did,
        validate: false,
        writes: updates.map(({ collection, rkey, data }) => ({
          $type: "com.atproto.repo.applyWrites#update",
          collection,
          rkey,
          value: data,
        })),
      });

      const cidMap = new Map<string, string>();
      for (const result of response?.data?.results ?? []) {
        if (result.$type === "com.atproto.repo.applyWrites#updateResult") {
          cidMap.set(result.uri, result.cid);
        }
      }

      for (let i = 0; i < updates.length; i++) {
        const { collection, rkey } = updates[i];
        const record = records[i];

        const uri = `at://${did}/${collection}/${rkey}`;

        indexService.updateRecord({
          uri,
          cid: cidMap.get(uri) ?? "",
          did,
          collection,
          json: stringifyLex(record),
          indexedAt: new Date().toISOString(),
        });

        results.push(uri);
      }
    } catch (error) {
      console.error("Error updating records:", error);
      throw new Error("Failed to update records");
    }
    return results;
  };
}

function deleteRecord(
  agent: Agent | undefined,
  indexService: IndexService,
) {
  return async (uri: string) => {
    const did = agent?.assertDid;

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const atUri = new AtUri(uri);
    await agent.com.atproto.repo.deleteRecord({
      repo: agent.assertDid,
      collection: atUri.collection,
      rkey: atUri.rkey,
    });
    indexService.deleteRecord(atUri.toString());
  };
}

function render(ctx: BffContext, cfg: BffConfig) {
  return (children: ComponentChildren, headers?: Record<string, string>) => {
    const RootElement = cfg.rootElement;
    const str = renderToString(<RootElement ctx={ctx}>{children}</RootElement>);
    return new Response(
      `<!DOCTYPE html>${str}`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...headers,
        },
      },
    );
  };
}

function html() {
  return (vnode: VNode, headers?: Record<string, string>) => {
    const str = renderToString(vnode);
    return new Response(
      `<!DOCTYPE html>${str}`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          ...headers,
        },
      },
    );
  };
}

function redirect(headers: Headers) {
  return (url: string) => {
    if (headers.get("HX-Request") !== "true") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: url,
        },
      });
    }
    return new Response(null, {
      status: 200,
      headers: {
        "HX-Redirect": url,
      },
    });
  };
}

function json() {
  return (
    data: unknown,
    status = 200,
    headers?: Record<string, string>,
  ): Response => {
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", ...headers },
      status,
    });
  };
}

function Root(props: Readonly<RootProps>) {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://unpkg.com/htmx.org@1.9.10"></script>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>{props.children}</body>
    </html>
  );
}

export const OAUTH_ROUTES = {
  loginPage: "/login",
  login: "/oauth/login",
  callback: "/oauth/callback",
  signup: "/signup",
  logout: "/logout",
  clientMetadata: "/oauth-client-metadata.json",
  jwks: "/oauth/jwks.json",
  session: "/api/session",
  refreshToken: "/api/token/refresh",
  revokeToken: "/api/token/revoke",
};

export function oauth(opts?: OauthMiddlewareOptions): BffMiddleware {
  return async (req, ctx) => {
    const headers = new Headers(req.headers);
    const cookie = getCookies(req.headers);
    const { pathname, searchParams, hostname } = new URL(req.url);
    const LoginComponent = opts?.LoginComponent ?? Login;

    if (pathname === OAUTH_ROUTES.login) {
      let handle: string | undefined;
      const clientType = searchParams.get("client");
      const oauthClient = clientType === "native"
        ? ctx.oauthClientNative
        : ctx.oauthClient;

      if (clientType === "native") {
        handle = searchParams.get("handle") ?? undefined;

        if (typeof handle !== "string") {
          return ctx.json(
            { error: "invalid handle" },
            400,
          );
        }
      } else if (req.method === "POST") {
        const formData = await req.formData();
        handle = formData.get("handle") as string ?? undefined;

        if (typeof handle !== "string") {
          return ctx.html(<LoginComponent error="invalid handle" />);
        }
      }

      if (!handle) {
        throw new Error("Handle is required for login");
      }

      try {
        const url = await oauthClient.authorize(handle, {
          signal: req.signal,
          state: clientType ?? undefined,
        });
        return ctx.redirect(url.toString());
      } catch (err) {
        console.error("oauth authorize failed:", err);
        const error = err instanceof OAuthResolverError
          ? err.message
          : "couldn't initiate login";

        if (clientType === "native") {
          return ctx.json({ error }, 400);
        }

        return ctx.html(<LoginComponent error={error} />);
      }
    }

    if (pathname === OAUTH_ROUTES.callback) {
      try {
        const { currentIsPrimary, primaryInstance } = await getInstanceInfo(
          ctx.cfg,
        );

        if (!currentIsPrimary) {
          return new Response(null, {
            status: 409,
            headers: {
              "fly-replay": `instance=${primaryInstance}`,
            },
          });
        }

        const stateKey = searchParams.get("state");
        const stateData = ctx.indexService.getState(stateKey ?? "");
        const state = stateData?.appState;

        const oauthClient = state === "native"
          ? ctx.oauthClientNative
          : ctx.oauthClient;

        const { session } = await oauthClient.callback(searchParams);

        const agent = new Agent(session);

        ctx.agent = agent;
        ctx.createRecord = createRecord(
          agent,
          ctx.indexService,
          ctx.cfg,
        );

        const atpData = await ctx.didResolver.resolveAtprotoData(
          session.did,
        );
        if (!atpData) {
          throw new Error("Failed to resolve Atproto data");
        }

        const actor: ActorTable = {
          did: session.did,
          handle: atpData.handle,
          indexedAt: new Date().toISOString(),
        };

        ctx.indexService.insertActor(actor);

        if (state) {
          if (state !== "native") {
            throw new Error("Unexpected state in OAuth callback");
          }

          if (!ctx.cfg.jwtSecret) {
            throw new Error("BFF_JWT_SECRET secret is not configured");
          }

          const expiresIn = 60 * 15; // 15 minutes
          const now = Math.floor(Date.now() / 1000);
          const expiresAt = now + expiresIn;
          const expiresAtStr = new Date(expiresAt * 1000).toISOString();
          const token = jwt.sign(
            { did: session.did },
            ctx.cfg.jwtSecret,
            {
              expiresIn,
            },
          );
          const refreshToken = randomBytes(32).toString("hex");
          ctx.indexService.insertAuthToken(
            session.did,
            refreshToken,
            new Date().toISOString(),
            expiresAtStr,
          );
          let url =
            `${ctx.cfg.tokenCallbackUrl}?token=${encodeURIComponent(token)}` +
            `&refreshToken=${encodeURIComponent(refreshToken)}` +
            `&expiresAt=${expiresAtStr}` +
            `&did=${encodeURIComponent(session.did)}`;
          const redirectPath = await opts?.onSignedIn?.({ actor, ctx });
          if (redirectPath) {
            url += `&redirect=${encodeURIComponent(redirectPath)}`;
          }
          return ctx.redirect(url);
        }

        const redirectPath = await opts?.onSignedIn?.({ actor, ctx });

        const value = btoa(session.did);
        const signature = await signCookie(value, ctx.cfg.cookieSecret);
        const signedCookie = `${value}|${signature}`;

        const headers = new Headers();
        setCookie(headers, {
          name: "auth",
          value: signedCookie,
          maxAge: 604800, // 7 days
          sameSite: "Lax",
          domain: hostname,
          path: "/",
          secure: true,
        });

        headers.set("location", redirectPath ?? "/");
        return new Response(null, {
          status: 303, // "See Other"
          headers,
        });
      } catch (err) {
        console.error(err);
        return new Response(null, {
          status: 303, // "See Other"
          headers: {
            location: "/",
          },
        });
      }
    }

    if (pathname === OAUTH_ROUTES.signup) {
      const formData = await req.formData();
      let pdsHostUrl = formData.get("pdsHostUrl") as string;

      if (typeof pdsHostUrl !== "string" || !pdsHostUrl) {
        pdsHostUrl = opts?.createAccountPdsHost || "https://bsky.social";
      }

      try {
        const url = await ctx.oauthClient.authorize(
          pdsHostUrl,
          {
            signal: req.signal,
          },
        );
        return ctx.redirect(url.toString());
      } catch (err) {
        console.error("oauth authorize failed:", err);
        return ctx.redirect("/");
      }
    }

    if (pathname === OAUTH_ROUTES.loginPage) {
      return ctx.render(<LoginComponent />);
    }

    if (pathname === OAUTH_ROUTES.logout) {
      if (cookie.auth) {
        const value = await parseCookie(cookie.auth, ctx.cfg.cookieSecret);
        if (!value) {
          throw new Error("Failed to parse cookie");
        }
        await ctx.oauthClient.revoke(value);
      }

      deleteCookie(headers, "auth", { path: "/", domain: hostname });
      ctx.agent = undefined;

      headers.set("HX-Redirect", "/");
      return new Response(null, {
        status: 302,
        headers,
      });
    }

    if (pathname === OAUTH_ROUTES.clientMetadata) {
      return new Response(JSON.stringify(ctx.oauthClient.clientMetadata), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === OAUTH_ROUTES.jwks) {
      return new Response(JSON.stringify(ctx.oauthClient.jwks), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === OAUTH_ROUTES.session) {
      if (!ctx.currentUser) {
        return ctx.json({ message: "Unauthorized" }, 401);
      }
      const did = ctx.currentUser.did;
      try {
        if (!ctx.cfg.jwtSecret) {
          throw new Error("BFF_JWT_SECRET secret is not configured");
        }
        const expiresIn = 60 * 15; // 15 minutes
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + expiresIn;
        const expiresAtStr = new Date(expiresAt * 1000).toISOString();
        const token = jwt.sign({ did }, ctx.cfg.jwtSecret, {
          expiresIn,
        });
        const refreshToken = randomBytes(32).toString("hex");
        return ctx.json({
          token,
          refreshToken,
          did,
          expiresAt: expiresAtStr,
        });
      } catch (err) {
        console.error("Failed to refresh token:", err);
        return ctx.json({ message: "Failed to refresh token" }, 500);
      }
    }

    if (pathname === OAUTH_ROUTES.refreshToken && req.method === "POST") {
      const { refreshToken } = await req.json();
      const actor = ctx.indexService.getActorByRefreshToken(refreshToken);
      if (!actor) {
        return ctx.json({ message: "Invalid refresh token" }, 401);
      }
      const expiresIn = 60 * 15; // 15 minutes
      const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
      const expiresAtStr = new Date(expiresAt * 1000).toISOString();
      const token = jwt.sign(
        { did: actor.did },
        ctx.cfg.jwtSecret,
        {
          expiresIn,
        },
      );
      const newRefreshToken = randomBytes(32).toString("hex");
      ctx.indexService.insertAuthToken(
        actor.did,
        newRefreshToken,
        new Date().toISOString(),
        expiresAtStr,
      );
      return ctx.json({
        token,
        refreshToken: newRefreshToken,
        did: actor.did,
        expiresAt: expiresAtStr,
      });
    }

    if (pathname === OAUTH_ROUTES.revokeToken && req.method === "POST") {
      const { refreshToken } = await req.json();
      const actor = ctx.indexService.getActorByRefreshToken(refreshToken);
      if (!actor) {
        return ctx.json({ message: "Invalid refresh token" }, 401);
      }
      ctx.indexService.deleteAuthToken(actor.did);
      await ctx.oauthClientNative.revoke(actor.did);
      return ctx.json({ message: "Token revoked successfully" });
    }

    return ctx.next();
  };
}

async function signCookie(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function verifyCookie(
  signedValue: string,
  secret: string,
): Promise<boolean> {
  const [value, signature] = signedValue.split("|");
  const expectedSignature = await signCookie(value, secret);
  return signature === expectedSignature;
}

async function parseCookie(
  signedValue: string,
  secret: string,
): Promise<string | undefined> {
  const [value, _signature] = signedValue.split("|");
  if (await verifyCookie(signedValue, secret)) {
    return atob(value);
  }
  return undefined;
}

type RecordTableWithoutIndexedAt = Omit<
  RecordTable,
  "indexedAt"
>;

async function getRecordsForRepos(
  repos: string[],
  collections: string[],
  atpMap: Map<string, AtprotoData>,
): Promise<RecordTableWithoutIndexedAt[]> {
  async function fetchRecordsForRepoCollection(
    repo: string,
    collection: string,
  ): Promise<RecordTableWithoutIndexedAt[]> {
    const repoRecords: RecordTableWithoutIndexedAt[] = [];
    const atpData = atpMap.get(repo);

    if (!atpData) {
      console.error(`No Atproto data found for repo: ${repo}`);
      return [];
    }

    const agent = new Agent(new URL(atpData.pds));
    let cursor: string | undefined = undefined;

    try {
      do {
        const response = await agent.com.atproto.repo.listRecords({
          repo,
          collection,
          cursor,
          limit: 100,
        });

        response.data.records.forEach((r) => {
          repoRecords.push({
            uri: r.uri,
            cid: r.cid.toString(),
            did: repo,
            collection,
            json: stringifyLex(r.value),
          } as RecordTableWithoutIndexedAt);
        });

        cursor = response.data.cursor ?? undefined;
      } while (cursor);

      return repoRecords;
    } catch (_error) {
      console.error(`Error fetching records for ${repo}/${collection}`);
      return [];
    }
  }

  const fetchPromises = repos.flatMap((repo) =>
    collections.map((collection) =>
      fetchRecordsForRepoCollection(repo, collection)
    )
  );

  const results = await Promise.all(fetchPromises);

  return results.flat();
}

const atpCache = new MemoryCache();

async function getAtpMapForRepos(
  repos: string[],
  cfg: BffConfig,
): Promise<Map<string, AtprotoData>> {
  const didResolver = new DidResolver({
    plcUrl: cfg.plcDirectoryUrl,
    didCache: atpCache,
  });
  const atpMap = new Map<string, AtprotoData>();
  for (const repo of repos) {
    const atpData = await didResolver.resolveAtprotoData(repo);
    if (!atpMap.has(atpData.did)) {
      atpMap.set(atpData.did, atpData);
    }
  }
  return atpMap;
}

async function getRecordsForUris(
  uris: string[],
  atpMap: Map<string, AtprotoData>,
  indexService: IndexService,
): Promise<RecordTableWithoutIndexedAt[]> {
  const urisToFetch = uris.filter((uri) => !indexService.getRecord(uri));

  if (urisToFetch.length === 0) {
    return [];
  }

  const urisByDid = new Map<string, string[]>();
  urisToFetch.forEach((uri) => {
    const did = new AtUri(uri).hostname;
    if (!urisByDid.has(did)) {
      urisByDid.set(did, []);
    }
    urisByDid.get(did)!.push(uri);
  });

  const fetchPromises = Array.from(urisByDid.entries()).map(
    async ([did, didUris]): Promise<RecordTableWithoutIndexedAt[]> => {
      const atpData = atpMap.get(did);
      if (!atpData) {
        console.error(`No Atproto data found for repo: ${did}`);
        return [];
      }

      const agent = new Agent(new URL(atpData.pds));

      const uriPromises = didUris.map(async (uri) => {
        try {
          const atUri = new AtUri(uri);
          console.log(`Fetching record for ${uri}`);
          const response = await agent.com.atproto.repo.getRecord({
            repo: did,
            collection: atUri.collection,
            rkey: atUri.rkey,
          });

          return {
            uri: response.data.uri,
            cid: response.data.cid,
            did,
            collection: atUri.collection,
            json: stringifyLex(response.data.value),
          } as RecordTableWithoutIndexedAt;
        } catch (error) {
          console.error(`Failed to fetch record from ${uri}:`, error);
          return null;
        }
      });

      const results = await Promise.all(uriPromises);
      return results.filter((record): record is RecordTableWithoutIndexedAt =>
        record !== null
      );
    },
  );

  const resultsArrays = await Promise.all(fetchPromises);
  return resultsArrays.flat();
}

function indexRecords(
  records: RecordTableWithoutIndexedAt[],
  indexService: IndexService,
) {
  for (const record of records) {
    indexService.insertRecord({
      uri: record.uri,
      cid: record.cid.toString(),
      did: record.did,
      collection: record.collection,
      json: record.json,
      indexedAt: new Date().toISOString(),
    });
  }
}

function indexActors(
  repos: string[],
  atpMap: Map<string, AtprotoData>,
  indexService: IndexService,
) {
  for (const repo of repos) {
    const atpData = atpMap.get(repo);
    if (!atpData) continue;
    indexService.insertActor({
      did: repo,
      handle: atpData.handle,
      indexedAt: new Date().toISOString(),
    });
  }
}

export function backfillUris(
  indexService: IndexService,
  cfg: BffConfig,
): (uris: string[]) => Promise<void> {
  return async (uris: string[]) => {
    const repos = uris.map((uri) => new AtUri(uri).hostname);
    const atpMap = await getAtpMapForRepos(repos, cfg);
    const records = await getRecordsForUris(uris, atpMap, indexService);
    indexActors(repos, atpMap, indexService);
    indexRecords(records, indexService);
  };
}

export function backfillCollections(
  indexService: IndexService,
  cfg: BffConfig,
): (
  params: {
    collections?: string[];
    externalCollections?: string[];
    repos?: string[];
  },
) => Promise<void> {
  return async (
    { collections, externalCollections, repos }: {
      collections?: string[];
      externalCollections?: string[];
      repos?: string[];
    },
  ) => {
    const originalConsoleError = console.error;

    // append error logging to a file
    console.error = (...args: unknown[]) => {
      const message = `[ERROR] ${new Date().toISOString()} ${
        args.map(String).join(" ")
      }\n`;

      try {
        Deno.writeTextFileSync("./sync.log", message, { append: true });
      } catch (e) {
        originalConsoleError("Failed to write to error log:", e);
      }
    };

    console.log();
    console.log("🔄 Starting backfill operation");

    if (!collections || collections.length === 0) {
      console.log("⚠️ No collections specified for backfill");
    } else {
      console.log(
        `📚 Processing ${collections.length} collections: ${
          collections.join(", ")
        }`,
      );
    }

    if (externalCollections && externalCollections.length > 0) {
      console.log(
        `🌐 Including ${externalCollections.length} external collections: ${
          externalCollections.join(", ")
        }`,
      );
    }

    const agent = new Agent("https://relay1.us-west.bsky.network");

    let allRepos: string[] = [];
    if (repos && repos.length > 0) {
      console.log(`📋 Using ${repos.length} provided repositories`);
      allRepos = repos;
    } else {
      // Fetch repos for all collections concurrently
      console.log("📊 Fetching repositories for collections...");
      const collectionResults = await Promise.all(
        (collections || []).map(async (collection) => {
          const response = await agent.com.atproto.sync.listReposByCollection({
            collection,
          });
          console.log(
            `✓ Found ${response.data.repos.length} repositories for collection "${collection}"`,
          );
          return {
            collection,
            repos: response.data.repos.map((repo) => repo.did),
          };
        }),
      );

      // Aggregate unique repos across all collections
      allRepos = [
        ...new Set(collectionResults.flatMap((result) => result.repos)),
      ];
      console.log(`📋 Processing ${allRepos.length} unique repositories`);
    }

    // Get ATP data for all repos at once
    console.log("🔍 Resolving ATP data for repositories...");
    const atpMap = await getAtpMapForRepos(allRepos, cfg);
    console.log(
      `✓ Resolved ATP data for ${atpMap.size}/${allRepos.length} repositories`,
    );

    // Get all records for all repos and collections at once
    console.log("📥 Fetching records for repositories and collections...");
    let totalRecords = 0;

    const records = await getRecordsForRepos(
      allRepos,
      (collections || []).concat(externalCollections || []),
      atpMap,
    );
    totalRecords = records.length;
    console.log(`✓ Fetched ${totalRecords} total records`);

    // Index the actors and records
    console.log("📝 Indexing actors...");
    indexActors(allRepos, atpMap, indexService);
    console.log(`✓ Indexed ${allRepos.length} actors`);

    console.log(`📝 Indexing ${totalRecords} records...`);
    indexRecords(records, indexService);
    console.log("✅ Backfill complete!");
  };
}

export function route(
  path: string,
  methodOrHandler?: HttpMethod | HttpMethod[] | RouteHandler,
  handler?: RouteHandler,
): BffMiddleware {
  let routeMethod: HttpMethod | HttpMethod[] = ["GET"];
  let routeHandler: RouteHandler;

  if (typeof methodOrHandler === "function") {
    routeHandler = methodOrHandler;
  } else if (methodOrHandler) {
    routeMethod = methodOrHandler;
    if (handler) {
      routeHandler = handler;
    } else {
      throw new Error("Handler function is required");
    }
  } else {
    throw new Error("Handler function is required");
  }

  const pattern = new URLPattern({ pathname: path });

  return async (req: Request, ctx: BffContext) => {
    const match = pattern.exec(req.url);

    if (match) {
      const methods = Array.isArray(routeMethod) ? routeMethod : [routeMethod];
      if (methods.includes(req.method as HttpMethod)) {
        const params = Object.fromEntries(
          Object.entries(match.pathname.groups || {})
            .map(([key, value]) => [key, value ?? ""]),
        );

        return await routeHandler(req, params, ctx);
      }
    }

    return await ctx.next();
  };
}

function uploadBlob(
  agent: Agent | undefined,
) {
  return async (file: File): Promise<BlobRef> => {
    if (!agent) {
      throw new Error("Agent is not authenticated");
    }

    try {
      const response = await agent.uploadBlob(file);
      return response.data.blob;
    } catch (error) {
      console.error("Error uploading blob:", error);
      throw new Error("Failed to upload blob");
    }
  };
}

function requireAuth(ctx: BffContext): ActorTable {
  if (!ctx.currentUser) {
    throw new UnauthorizedError("User not authenticated", ctx);
  }
  return ctx.currentUser;
}

export async function getInstanceInfo(
  cfg: BffConfig,
): Promise<{
  primaryInstance: string;
  currentInstance: string;
  currentIsPrimary: boolean;
}> {
  const currentInstance = Deno.hostname();
  let primaryInstance;

  try {
    primaryInstance = await Deno.readTextFile(
      join(cfg.litefsDir, ".primary"),
    );
    primaryInstance = primaryInstance.trim();
  } catch {
    primaryInstance = currentInstance;
  }

  return {
    primaryInstance,
    currentInstance,
    currentIsPrimary: currentInstance === primaryInstance,
  };
}

/** Rate limiter function with points system to handle multiple rate limits across different endpoints */
function rateLimit(
  req: Request,
  currentUser: ActorTable | undefined,
  db: Database,
) {
  return (
    options: {
      namespace: string;
      points?: number;
      limit: number;
      window: number;
      key?: string;
    },
  ): boolean => {
    const {
      namespace,
      points = 1,
      limit,
      window: windowMs,
      key: customKey,
    } = options;

    const did = currentUser?.did;
    const limitKey = customKey || did || req.headers.get("x-forwarded-for") ||
      "anonymous";
    const now = new Date();
    const resetAt = new Date(now.getTime() + windowMs);

    let inTransaction = false;

    try {
      db.exec("BEGIN TRANSACTION");
      inTransaction = true;

      const result = db.prepare(
        `SELECT points, resetAt FROM rate_limit WHERE key = ? AND namespace = ?`,
      ).get(limitKey, namespace) as
        | { points: number; resetAt: string }
        | undefined;

      if (!result) {
        db.prepare(
          `INSERT INTO rate_limit (key, namespace, points, resetAt) VALUES (?, ?, ?, ?)`,
        ).run(limitKey, namespace, points, resetAt.toISOString());

        db.exec("COMMIT");
        inTransaction = false;
        return true;
      }

      const resetTime = new Date(result.resetAt);

      if (now > resetTime) {
        db.prepare(
          `UPDATE rate_limit SET points = ?, resetAt = ? WHERE key = ? AND namespace = ?`,
        ).run(points, resetAt.toISOString(), limitKey, namespace);

        db.exec("COMMIT");
        inTransaction = false;
        return true;
      }

      if (result.points + points > limit) {
        const retryAfter = Math.ceil(
          (resetTime.getTime() - now.getTime()) / 1000,
        );
        throw new RateLimitError(
          `Rate limit exceeded for ${namespace}. Try again in ${
            Math.ceil(
              (resetTime.getTime() - now.getTime()) / 1000,
            )
          } seconds`,
          retryAfter,
        );
      }

      db.prepare(
        `UPDATE rate_limit SET points = points + ? WHERE key = ? AND namespace = ?`,
      ).run(points, limitKey, namespace);

      db.exec("COMMIT");
      inTransaction = false;
      return true;
    } catch (error) {
      if (inTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackError) {
          console.error("Rollback failed:", rollbackError);
        }
      }

      if (error instanceof RateLimitError) {
        throw error;
      }

      console.error("Rate limit error:", error);
      throw new Error(`Failed to check rate limit for ${namespace}`);
    }
  };
}

function getNotifications(
  currentUser: ActorTable | undefined,
  indexService: IndexService,
): <T extends Record<string, unknown>>() => T[] {
  return function <T extends Record<string, unknown>>(): T[] {
    if (!currentUser) {
      return [];
    }

    const mentions = indexService.getMentioningUris(currentUser.did);
    const notifications: T[] = [];

    for (const uri of mentions) {
      const record = indexService.getRecord(uri);
      if (record) {
        notifications.push(record as T);
      }
    }

    return notifications;
  };
}

function updateSeen(
  currentUser: ActorTable | undefined,
  indexService: IndexService,
) {
  return (seenAt: string) => {
    if (!currentUser) {
      return;
    }
    indexService.updateActor(
      currentUser.did,
      seenAt,
    );
  };
}

function getLabelerDefinitions(
  didResolver: DidResolver,
  cfg: BffConfig,
) {
  const cache = new TtlCache<string, Record<string, LabelerPolicies>>(
    6 * 60 * 60 * 1000,
  ); // 6 hours TTL

  return async (): Promise<Record<string, LabelerPolicies>> => {
    if (cfg.appLabelerCollection === undefined) {
      throw new Error("App labeler collection is not defined");
    }

    if (!cfg.appLabelers) {
      throw new Error("App labelers are not defined");
    }

    const cacheKey = "definitions";
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const definitionsByDid: Record<string, LabelerPolicies> = {};

    for (const did of cfg.appLabelers) {
      let atpData: AtprotoData | undefined;
      try {
        atpData = await didResolver.resolveAtprotoData(did);
      } catch (error) {
        console.error(`Failed to resolve Atproto data for ${did}`, error);
        continue;
      }

      const agent = new Agent(new URL(atpData.pds));

      try {
        const response = await agent.com.atproto.repo.getRecord({
          collection: cfg.appLabelerCollection,
          rkey: "self",
          repo: did,
        });
        const policies = response.data?.value?.policies ??
          { labelValues: [], labelValueDefinitions: [] };
        definitionsByDid[did] = policies as LabelerPolicies;
      } catch (error) {
        console.error("Error fetching labeler definitions:", error);
        // continue to next labeler
      }
    }

    cache.set(cacheKey, definitionsByDid);
    return definitionsByDid;
  };
}

async function createLabelerSubscriptions(
  didResolver: DidResolver,
  indexService: IndexService,
  cfg: BffConfig,
) {
  const labelerMap = new Map<string, Labeler>();
  for (const did of cfg.appLabelers || []) {
    const doc = await didResolver.resolve(did);
    const modServiceEndpoint = doc?.service?.find((s) =>
      s.type === "AtprotoLabeler"
    )?.serviceEndpoint;

    if (typeof modServiceEndpoint !== "string") {
      console.warn(`No AtprotoLabeler service found for DID: ${did}`);
      continue;
    }

    const wsUrl = modServiceEndpoint.replace(/^https:\/\//, "wss://");

    let isFirstEvent = true;

    const labeler = new Labeler({
      instanceUrl: wsUrl,
      handleEvent: (event) => {
        // On the first event, clear the cache (assuming full backfill)
        if (isFirstEvent) {
          try {
            indexService.clearLabels();
          } catch (error) {
            console.error("Error clearing labels cache:", error);
          }
          isFirstEvent = false;
        }
        // @TODO: validate label
        if (event.labels && event.labels.length > 0) {
          for (const label of event.labels) {
            try {
              indexService.insertLabel(label);
            } catch (error) {
              console.error("Error inserting label:", error);
            }
          }
        }
      },
    });
    labelerMap.set(did, labeler);
  }
  return labelerMap;
}

async function generateFingerprints(
  cfg: BffConfig,
): Promise<Map<string, string>> {
  const staticFilesHash = new Map<string, string>();

  const buildDirPath = join(Deno.cwd(), cfg.buildDir);
  try {
    await Deno.stat(buildDirPath);
  } catch (_err) {
    await Deno.mkdir(buildDirPath, { recursive: true });
  }

  for (const entry of Deno.readDirSync(join(Deno.cwd(), cfg.buildDir))) {
    if (
      entry.isFile &&
      (entry.name.endsWith(".js") || entry.name.endsWith(".css"))
    ) {
      const fileContent = await Deno.readFile(
        join(Deno.cwd(), cfg.buildDir, entry.name),
      );
      const hashBuffer = await crypto.subtle.digest("SHA-256", fileContent);
      const hash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      staticFilesHash.set(entry.name, hash);
    }
  }

  return staticFilesHash;
}

function timedQuery<T = unknown>(
  db: Database,
  sql: string,
  params: (string | number)[] = [],
  label?: string,
): T {
  const debugMode = Deno.env.get("DEBUG") === "true";
  const start = typeof performance !== "undefined"
    ? performance.now()
    : Date.now();
  // Use .all for array results, .get for single row
  let result: unknown;
  if (label === "getRecords") {
    result = db.prepare(sql).all(...params);
  } else {
    result = db.prepare(sql).get(...params);
  }
  const end = typeof performance !== "undefined"
    ? performance.now()
    : Date.now();
  const elapsed = end - start;
  if (debugMode) {
    if (label) {
      console.log(`[timedQuery] ${label} took ${elapsed.toFixed(2)}ms`);
    } else {
      console.log(`[timedQuery] Query took ${elapsed.toFixed(2)}ms`);
    }
  }
  return result as T;
}
