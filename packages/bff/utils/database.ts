import {
  isMention,
  isTag,
  type Main as Facet,
} from "$lexicon/types/app/bsky/richtext/facet.ts";
import type {
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
} from "@bigmoves/atproto-oauth-client";
import { DatabaseSync } from "node:sqlite";
import type { ApplicationType, BffConfig, Database, FacetIndexTable } from "../types.d.ts";
import { getInstanceInfo } from "./litefs.ts";

export function timedQuery<T = unknown>(
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

export interface SqliteError extends Error {
  code?: string;
}

export function createLock(db: Database, cfg: BffConfig) {
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

export function createStateStore(
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

export function createSessionStore(
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

export function indexFacets(uri: string, facets: Facet[]): FacetIndexTable[] {
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

export function createDb(cfg: BffConfig) {
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