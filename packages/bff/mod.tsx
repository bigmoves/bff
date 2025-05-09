import { Agent } from "@atproto/api";
import { TID } from "@atproto/common";
import { type AtprotoData, DidResolver, MemoryCache } from "@atproto/identity";
import { Lexicons, stringifyLex } from "@atproto/lexicon";
import { OAuthResolverError } from "@atproto/oauth-client";
import { AtUri, isValidHandle } from "@atproto/syntax";
import {
  AtprotoOAuthClient,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  type NodeSavedStateStore,
} from "@bigmoves/atproto-oauth-client";
import { assert } from "@std/assert";
import { TtlCache } from "@std/cache";
import { deleteCookie, getCookies, setCookie } from "@std/http";
import { serveDir } from "@std/http/file-server";
import { join } from "@std/path/join";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import type { ComponentChildren, VNode } from "preact";
import { render as renderToString } from "preact-render-to-string";
import { Login } from "./components/Login.tsx";
import { UnauthorizedError } from "./errors.ts";
import { Jetstream } from "./jetstream.ts";
import { CSS } from "./styles.ts";
import type {
  ActorTable,
  BffConfig,
  BffContext,
  BffMiddleware,
  BffOptions,
  BlobMeta,
  Database,
  HttpMethod,
  IndexService,
  OauthMiddlewareOptions,
  ProcessImageQueuePayload,
  QueryOptions,
  Queue,
  QueueItem,
  QueueItemResult,
  QueuePayloads,
  RecordTable,
  RootProps,
  RouteHandler,
  UploadBlobArgs,
} from "./types.d.ts";
import { hydrateBlobRefs } from "./utils.ts";

export { UnauthorizedError } from "./errors.ts";
export { JETSTREAM } from "./jetstream.ts";
export type {
  ActorTable,
  BffContext,
  BffMiddleware,
  BffOptions,
  BlobMeta,
  onListenArgs,
  onSignedInArgs,
  RecordTable,
  RootProps,
  RouteHandler,
  WithBffMeta,
} from "./types.d.ts";

export { CSS } from "./styles.ts";

const TEMP_IMAGE_STORAGE = "./image_storage";

const blobMetaCache = new TtlCache<string, BlobMeta>(1000 * 60 * 5); // 5 min

export async function bff(opts: BffOptions) {
  const bffConfig = configureBff(opts);
  const db = createDb(bffConfig);
  const idxService = indexService(db);
  const oauthClient = createOauthClient(db, bffConfig);
  const queue = await createQueue(oauthClient, blobMetaCache, bffConfig);
  const handler = createBffHandler(db, oauthClient, queue, bffConfig);
  const jetstream = createSubscription(idxService, bffConfig);

  if (bffConfig.jetstreamUrl && bffConfig.collections?.length) {
    jetstream.connect();
  }

  // TODO: maybe should be onBeforeListen
  await bffConfig.onListen?.({
    indexService: idxService,
  });

  Deno.serve({
    port: bffConfig.port,
    onListen({ port, hostname }) {
      console.log(`Server started at http://${hostname}:${port}`);
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
      return new Response("Internal Server Error", {
        status: 500,
      });
    },
  }, handler);

  Deno.addSignalListener("SIGINT", () => {
    console.log("Shutting down...");
    jetstream.disconnect();
    queue.close();
    Deno.exit(0);
  });
}

function configureBff(cfg: BffOptions): BffConfig {
  return {
    ...cfg,
    rootDir: Deno.env.get("BFF_ROOT_DIR") ?? Deno.cwd(),
    publicUrl: Deno.env.get("BFF_PUBLIC_URL") ?? "",
    port: Number(Deno.env.get("BFF_PORT")) || 8080,
    databaseUrl: cfg.databaseUrl ?? Deno.env.get("BFF_DATABASE_URL") ??
      ":memory:",
    queueDatabaseUrl: Deno.env.get("BFF_QUEUE_DATABASE_URL") ??
      "file::memory:?cache=shared",
    lexicons: cfg.lexicons ?? new Lexicons(),
    oauthScope: cfg.oauthScope ?? "atproto transition:generic",
    middlewares: cfg.middlewares ?? [],
    rootElement: cfg.rootElement ?? Root,
  };
}

function createDb(cfg: BffConfig) {
  const db = new DatabaseSync(cfg.databaseUrl);

  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS "auth_session" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "session" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "auth_state" (
      "key" TEXT PRIMARY KEY NOT NULL,
      "state" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "actor" (
      "did" TEXT PRIMARY KEY NOT NULL,
      "handle" TEXT,
      "indexedAt" TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "record" (
      "uri" TEXT PRIMARY KEY NOT NULL,
      "cid" TEXT NOT NULL,
      "did" TEXT NOT NULL,
      "collection" TEXT NOT NULL,
      "json" TEXT NOT NULL,
      "indexedAt" TEXT NOT NULL
    );
  `);

  return db;
}

const indexService = (db: Database): IndexService => {
  return {
    getRecords: <T extends Record<string, unknown>>(
      collection: string,
      options?: QueryOptions,
    ) => {
      let query = `SELECT * FROM "record" WHERE collection = ?`;
      const params: string[] = [collection];
      const tableColumns = ["did", "uri", "indexedAt", "cid"];

      if (options?.where && options.where.length > 0) {
        options.where.forEach((condition) => {
          const field = condition.field;
          if (tableColumns.includes(field)) {
            if (condition.equals !== undefined) {
              query += ` AND ${field} = ?`;
              params.push(condition.equals);
            } else if (condition.contains !== undefined) {
              query += ` AND LOWER(${field}) LIKE LOWER(?)`;
              params.push(`%${condition.contains}%`);
            } else if (
              condition.in !== undefined && Array.isArray(condition.in)
            ) {
              if (condition.in.length === 0) {
                query += ` AND 0 = 1`; // Empty array means no matches
              } else {
                const placeholders = condition.in.map(() => "?").join(", ");
                query += ` AND ${field} IN (${placeholders})`;
                params.push(...condition.in);
              }
            }
          } else {
            if (condition.equals !== undefined) {
              query += ` AND JSON_EXTRACT(json, '$.${field}') = ?`;
              params.push(condition.equals);
            } else if (condition.contains !== undefined) {
              query +=
                ` AND INSTR(LOWER(JSON_EXTRACT(json, '$.${field}')), LOWER(?)) > 0`;
              params.push(condition.contains);
            } else if (
              condition.in !== undefined && Array.isArray(condition.in)
            ) {
              if (condition.in.length === 0) {
                query += ` AND 0 = 1`; // Empty array means no matches
              } else {
                const placeholders = condition.in.map(() => "?").join(", ");
                query +=
                  ` AND JSON_EXTRACT(json, '$.${field}') IN (${placeholders})`;
                params.push(...condition.in);
              }
            }
          }
        });
      }

      if (options?.cursor) {
        try {
          const decoded = Buffer.from(options.cursor, "base64").toString(
            "utf-8",
          );
          const [cursorIndexedAt, cursorCid] = decoded.split("|");

          const cursorDirection = options?.orderBy?.direction === "desc"
            ? "<"
            : ">";

          query +=
            ` AND (indexedAt ${cursorDirection} ? OR (indexedAt = ? AND cid ${cursorDirection} ?))`;
          params.push(cursorIndexedAt, cursorIndexedAt, cursorCid);
        } catch (error) {
          console.warn("Invalid cursor format", error);
        }
      }

      const orderField = options?.orderBy?.field || "indexedAt";
      const orderDirection = options?.orderBy?.direction || "asc";

      if (tableColumns.includes(orderField)) {
        query += ` ORDER BY ${orderField} ${orderDirection}`;
        query += `, cid ${orderDirection}`;
      } else {
        query +=
          ` ORDER BY JSON_EXTRACT(json, '$.${orderField}') ${orderDirection}`;
        query += `, cid ${orderDirection}`;
      }

      if (options?.limit && options.limit > 0) {
        query += ` LIMIT ?`;
        params.push(options.limit.toString());
      }

      const rows = db.prepare(query).all(...params) as RecordTable[];

      let nextCursor: string | undefined;
      if (rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        const rawCursor = `${lastRow.indexedAt}|${lastRow.cid}`;
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
    },
    deleteRecord: (uri: string) => {
      db.prepare(`DELETE FROM "record" WHERE uri = ?`).run(uri);
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
  };
};

function createBffHandler(
  db: Database,
  oauthClient: AtprotoOAuthClient,
  queue: Queue,
  cfg: BffConfig,
) {
  const inner = handler;
  const withMiddlewares = composeMiddlewares(db, oauthClient, queue, cfg);
  return function handler(req: Request, connInfo: Deno.ServeHandlerInfo) {
    return withMiddlewares(req, connInfo, inner);
  };
}

function composeMiddlewares(
  db: Database,
  oauthClient: AtprotoOAuthClient,
  queue: Queue,
  cfg: BffConfig,
) {
  return async (
    req: Request,
    _connInfo: Deno.ServeHandlerInfo,
    inner: (req: Request, ctx: BffContext) => Promise<Response>,
  ) => {
    const didCache = new MemoryCache();
    const didResolver = new DidResolver({
      didCache,
    });
    const idxService = indexService(db);

    let agent: Agent | undefined;
    let currentUser: ActorTable | undefined;
    const cookies = getCookies(req.headers);

    if (cookies.auth) {
      try {
        const oauthSession = await oauthClient.restore(cookies.auth);
        agent = new Agent(oauthSession);
      } catch (err) {
        console.error("failed to restore oauth session", err);
      }
    }

    if (agent) {
      const actor = idxService.getActor(cookies.auth);
      currentUser = actor;
    }

    const createRecordFn = createRecord(agent, idxService, cfg);
    const updateRecordFn = updateRecord(agent, idxService, cfg);
    const deleteRecordFn = deleteRecord(agent, idxService);
    const backfillCollectionsFn = backfillCollections(idxService);
    const backfillUrisFn = backfillUris(idxService);
    const uploadBlobFn = uploadBlob(queue, agent, blobMetaCache);

    const ctx: BffContext = {
      state: {},
      oauthClient,
      indexService: idxService,
      currentUser,
      agent,
      createRecord: createRecordFn,
      updateRecord: updateRecordFn,
      deleteRecord: deleteRecordFn,
      backfillCollections: backfillCollectionsFn,
      backfillUris: backfillUrisFn,
      uploadBlob: uploadBlobFn,
      didResolver,
      render: () => new Response(),
      html: html(),
      redirect: redirect(req.headers),
      cfg,
      next: async () => new Response(),
      blobMetaCache,
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

async function handler(req: Request, ctx: BffContext) {
  const { pathname } = new URL(req.url);

  if (pathname.startsWith("/static/")) {
    return serveDir(req, {
      fsRoot: ctx.cfg.rootDir,
    });
  }

  return new Response("Not found", {
    status: 404,
  });
}

function createSubscription(
  indexService: IndexService,
  cfg: BffConfig,
) {
  const jetstream = new Jetstream({
    instanceUrl: cfg.jetstreamUrl,
    wantedCollections: cfg.collections ?? [],
    handleEvent: (event) => {
      if (event.kind !== "commit") return;
      if (!event.commit) return;

      console.log("Received event:", event);

      const uri =
        `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;

      if (
        (
          event.commit.operation === "create" ||
          event.commit.operation === "update"
        )
      ) {
        cfg.lexicons.assertValidRecord(
          event.commit.collection,
          hydrateBlobRefs(event.commit.record),
        );

        indexService.insertRecord({
          uri: uri,
          cid: event.commit.cid,
          did: event.did,
          collection: event.commit.collection,
          json: stringifyLex(event.commit.record),
          indexedAt: new Date().toISOString(),
        });
      } else if (event.commit?.operation === "delete") {
        indexService.deleteRecord(uri);
      }
    },
  });

  return jetstream;
}

function createOauthClient(db: Database, cfg: BffConfig) {
  const publicUrl = cfg.publicUrl;
  const url = publicUrl || `http://127.0.0.1:${cfg.port}`;
  const enc = encodeURIComponent;
  const scope = cfg.oauthScope;

  return new AtprotoOAuthClient({
    responseMode: "query",
    clientMetadata: {
      client_name: cfg.appName,
      client_id: publicUrl
        ? `${url}/client-metadata.json`
        : `http://localhost?redirect_uri=${
          enc(
            `${url}/oauth/callback`,
          )
        }&scope=${enc(scope)}`,
      client_uri: url,
      redirect_uris: [`${url}/oauth/callback`],
      scope,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: "none",
      dpop_bound_access_tokens: true,
    },
    stateStore: createStateStore(db),
    sessionStore: createSessionStore(db),
  });
}

function createStateStore(db: Database): NodeSavedStateStore {
  return {
    get(key: string): NodeSavedState | undefined {
      const result = db
        .prepare(`SELECT state FROM auth_state WHERE key = ?`)
        .get(key) as { state: string };
      if (!result.state) return;
      return JSON.parse(result.state) as NodeSavedState;
    },
    set(key: string, val: NodeSavedState) {
      const state = JSON.stringify(val);
      db.prepare(
        `INSERT INTO auth_state (key, state) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET state = ?`,
      ).run(key, state, state);
    },
    del(key: string) {
      db.prepare(`DELETE FROM auth_state WHERE key = ?`).run(key);
    },
  };
}

function createSessionStore(db: Database): NodeSavedSessionStore {
  return {
    get(key: string): NodeSavedSession | undefined {
      const result = db
        .prepare(`SELECT session FROM auth_session WHERE key = ?`)
        .get(key) as { session: string } | undefined;
      if (!result) return;
      return JSON.parse(result.session) as NodeSavedSession;
    },
    set(key: string, val: NodeSavedSession) {
      const session = JSON.stringify(val);
      db.prepare(
        `INSERT INTO auth_session (key, session) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET session = ?`,
      ).run(key, session, session);
    },
    del(key: string) {
      db.prepare(`DELETE FROM auth_session WHERE key = ?`).run(key);
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
  return (children: ComponentChildren) => {
    const RootElement = cfg.rootElement;
    const str = renderToString(<RootElement ctx={ctx}>{children}</RootElement>);
    return new Response(
      `<!DOCTYPE html>${str}`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
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
  clientMetadata: "/client-metadata.json",
};

export function oauth(opts?: OauthMiddlewareOptions): BffMiddleware {
  return async (req, ctx) => {
    const headers = new Headers(req.headers);
    const cookie = getCookies(req.headers);
    const { pathname, searchParams, hostname } = new URL(req.url);
    const LoginComponent = opts?.LoginComponent ?? Login;

    if (pathname === OAUTH_ROUTES.login) {
      const formData = await req.formData();
      const handle = formData.get("handle") as string;

      if (typeof handle !== "string" || !isValidHandle(handle)) {
        return ctx.html(<LoginComponent error="invalid handle" />);
      }

      try {
        const url = await ctx.oauthClient.authorize(handle, {
          signal: req.signal,
        });
        return ctx.redirect(url.toString());
      } catch (err) {
        console.error("oauth authorize failed:", err);
        const error = err instanceof OAuthResolverError
          ? err.message
          : "couldn't initiate login";
        return new Response(error, { status: 400 });
      }
    }

    if (pathname === OAUTH_ROUTES.callback) {
      try {
        const { session } = await ctx.oauthClient.callback(searchParams);

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

        const redirectPath = await opts?.onSignedIn?.({ actor, ctx });

        const headers = new Headers();
        setCookie(headers, {
          name: "auth",
          value: session.did,
          maxAge: 3600,
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
      try {
        const url = await ctx.oauthClient.authorize(
          // TODO: add to config
          "https://bsky.social",
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
        ctx.oauthClient.revoke(cookie.auth);
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

    return ctx.next();
  };
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
  const records: RecordTableWithoutIndexedAt[] = [];

  for (const repo of repos) {
    for (const collection of collections) {
      let cursor: string | undefined = undefined;

      const atpData = atpMap.get(repo);
      if (!atpData) {
        console.error(`No Atproto data found for repo: ${repo}`);
        continue;
      }

      const agent = new Agent(new URL(atpData.pds));

      do {
        const response = await agent.com.atproto.repo.listRecords({
          repo,
          collection,
          cursor,
          limit: 100,
        });
        response.data.records.forEach((r) => {
          records.push({
            uri: r.uri,
            cid: r.cid.toString(),
            did: repo,
            collection,
            json: stringifyLex(r.value),
          } as RecordTableWithoutIndexedAt);
        });
        cursor = response.data.cursor ?? undefined; // Continue fetching if there's more data
      } while (cursor);
    }
  }
  return records;
}

async function getAtpMapForRepos(
  repos: string[],
): Promise<Map<string, AtprotoData>> {
  const didResolver = new DidResolver({
    didCache: new MemoryCache(),
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
  indexService: IndexService,
): Promise<RecordTableWithoutIndexedAt[]> {
  const records: RecordTableWithoutIndexedAt[] = [];

  uris = uris.filter((uri) => {
    const record = indexService.getRecord(uri);
    return !record;
  });
  if (uris.length === 0) {
    return records;
  }

  const dids = uris.map((uri) => new AtUri(uri).hostname);
  const atpMap = await getAtpMapForRepos(dids);

  for (const uri of uris) {
    const did = new AtUri(uri).hostname;
    const atpData = atpMap.get(did);
    if (!atpData) {
      console.error(`No Atproto data found for repo: ${did}`);
      continue;
    }
    const agent = new Agent(new URL(atpData.pds));
    try {
      console.log(`Fetching record for ${uri}`);
      const collection = new AtUri(uri).collection;
      const response = await agent.com.atproto.repo.getRecord({
        repo: did,
        collection: collection,
        rkey: new AtUri(uri).rkey,
      });
      records.push({
        uri: response.data.uri,
        cid: response.data.cid,
        did,
        collection,
        json: stringifyLex(response.data.value),
      } as RecordTableWithoutIndexedAt);
    } catch (error) {
      console.error(`Failed to fetch record from ${uri}:`, error);
      continue;
    }
  }
  return records;
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

export function backfillUris(
  indexService: IndexService,
): (uris: string[]) => Promise<void> {
  return async (uris: string[]) => {
    const records = await getRecordsForUris(uris, indexService);
    indexRecords(records, indexService);
  };
}

export function backfillCollections(
  indexService: IndexService,
): (repos: string[], collections: string[]) => Promise<void> {
  return async (
    repos: string[],
    collections: string[],
  ) => {
    const atpMap = await getAtpMapForRepos(repos);
    const records = await getRecordsForRepos(repos, collections, atpMap);
    for (const repo of repos) {
      const atpData = atpMap.get(repo);
      if (!atpData) continue;
      indexService.insertActor({
        did: repo,
        handle: atpData.handle,
        indexedAt: new Date().toISOString(),
      });
    }
    indexRecords(records, indexService);
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

const uploadBlob = (
  queue: Queue,
  agent: Agent | undefined,
  blobMetaCache: TtlCache<string, BlobMeta>,
) => {
  return ({ file, dataUrl, opts }: UploadBlobArgs): string => {
    const uploadId = crypto.randomUUID();

    blobMetaCache.set(uploadId, {
      dataUrl,
    });

    if (!agent) {
      throw new Error("Agent not initialized");
    }

    if (!file) {
      throw new Error("No files provided");
    }

    enqueueImage({
      queue,
      did: agent.assertDid,
      file,
      uploadId,
      opts,
    });

    return uploadId.toString();
  };
};

async function enqueueImage({
  queue,
  did,
  file,
  uploadId,
  opts,
}: {
  queue: Queue;
  did: string;
  file: File;
  uploadId: string;
  opts?: {
    compress?: boolean;
  };
}) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log(
    "Input buffer size:",
    (buffer.byteLength / 1024 / 1024).toFixed(2) + " Mb",
  );

  const tempImagePath = join(
    Deno.cwd(),
    TEMP_IMAGE_STORAGE,
  );
  const imagePath = join(tempImagePath, uploadId);
  await Deno.mkdir(tempImagePath, { recursive: true });
  await Deno.writeFile(
    imagePath,
    buffer,
  );

  const payload: ProcessImageQueuePayload = {
    type: "process_image",
    data: {
      uploadId,
      did,
      imagePath,
      opts,
    },
  };

  await queue.enqueue(payload);

  return {
    uploadId,
    imagePath,
  };
}

async function handleBlobAfterProcessing(
  oauthClient: AtprotoOAuthClient,
  blobMetaCache: TtlCache<string, BlobMeta>,
  result: QueueItemResult,
) {
  const oauthSession = await oauthClient.restore(result.did);
  const agent = new Agent(oauthSession);

  const buffer = await Deno.readFile(result.imagePath);

  console.log(
    "Output buffer size:",
    (buffer.byteLength / 1024 / 1024).toFixed(2) + " MB",
  );

  const blobResponse = await agent.uploadBlob(buffer);

  if (!blobResponse) {
    throw new Error("Failed to upload blob");
  }

  await Deno.remove(result.imagePath);

  const cid = blobResponse.data.blob.ref.toString();

  const existingBlobMeta = blobMetaCache.get(result.uploadId);
  const newBlobMeta = {
    ...existingBlobMeta,
    blobRef: blobResponse.data.blob,
    dimensions: result.dimensions,
  };

  // Adding two entries to the cache
  // 1. One for the uploadId to be used to track the upload
  // 2. One for the cid to be used when creating/updating a record
  blobMetaCache.set(result.uploadId, newBlobMeta);
  blobMetaCache.set(cid, newBlobMeta);
}

function createWorker() {
  const worker = new Worker(
    new URL("./worker.ts", import.meta.url).href,
    {
      type: "module",
    },
  );
  return worker;
}

async function createQueue(
  oauthClient: AtprotoOAuthClient,
  blobMetaCache: TtlCache<string, BlobMeta>,
  cfg: BffConfig,
) {
  const kv = await Deno.openKv(cfg.queueDatabaseUrl);
  let workerProcessing = false;

  kv.listenQueue(async (message: QueuePayloads) => {
    if (message.type !== "process_image") return;
    const now = new Date();
    const { data } = message;

    const queueItem: QueueItem = {
      id: data.uploadId,
      did: data.did,
      imagePath: data.imagePath,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    await kv.set(["imageQueue", queueItem.id], queueItem);
    await kv.set([
      "imageQueueIndex",
      "pending",
      now.toISOString(),
      queueItem.id,
    ], queueItem.id);

    console.log(`Image enqueued with ID: ${queueItem.id}`);

    ensureWorkerIsRunning();
  });

  const ensureWorkerIsRunning = () => {
    if (workerProcessing) return;
    workerProcessing = true;

    const worker = createWorker();

    worker.onmessage = (e) => {
      const { type, id, result, error } = e.data;
      if (type === "complete") {
        console.log(`Worker completed processing image ${id}`);
        handleBlobAfterProcessing(oauthClient, blobMetaCache, result);
      } else if (type === "error") {
        console.error(
          `Worker encountered an error processing image ${id}:`,
          error,
        );
      } else if (type === "shutdown") {
        workerProcessing = false;
        worker.terminate();
        console.log("Worker shut down due to empty queue");
      }
    };

    worker.onerror = (error) => {
      console.error("Worker error:", error);
      workerProcessing = false;
    };

    worker.postMessage({ command: "start", databaseUrl: cfg.queueDatabaseUrl });

    console.log("Image processor worker started");
  };

  return {
    enqueue: async (payload: QueuePayloads) => {
      await kv.enqueue(payload);
    },
    close: () => {
      kv.close();
    },
  } as Queue;
}

export function requireAuth<T>(
  ctx: BffContext<T>,
): asserts ctx is BffContext<T> & {
  currentUser: NonNullable<BffContext["currentUser"]>;
} {
  if (!ctx.currentUser) {
    throw new UnauthorizedError("User not authenticated", ctx);
  }
}
