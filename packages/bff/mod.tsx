import { Agent } from "@atproto/api";
import { TID } from "@atproto/common";
import { DidResolver, MemoryCache } from "@atproto/identity";
import { Lexicons, stringifyLex } from "@atproto/lexicon";
import { OAuthResolverError } from "@atproto/oauth-client";
import { isValidHandle } from "@atproto/syntax";
import {
  AtprotoOAuthClient,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  type NodeSavedStateStore,
} from "@bigmoves/atproto-oauth-client";
import { assert } from "@std/assert";
import { deleteCookie, getCookies, setCookie } from "@std/http";
import { serveDir } from "@std/http/file-server";
import { join } from "@std/path/join";
import { DatabaseSync } from "node:sqlite";
import type { ComponentChildren } from "preact";
import { render as renderToString } from "preact-render-to-string";
import { Login } from "./components/Login.tsx";
import { Jetstream } from "./jetstream.ts";
import { CSS } from "./styles.ts";
import type {
  ActorTable,
  BffConfig,
  BffContext,
  BffMiddleware,
  Config,
  Database,
  IndexService,
  OauthMiddlewareOptions,
  OrderByOption,
  RecordTable,
  RootProps,
} from "./types.d.ts";

export type {
  BffContext,
  BffMiddleware,
  RootProps,
  WithBffMeta,
} from "./types.d.ts";

export { CSS } from "./styles.ts";

export async function bff(cfg: Config) {
  const bffConfig = configureBff(cfg);
  const db = createDb(bffConfig);
  const idxService = indexService(db);
  const oauthClient = createOauthClient(db, bffConfig);
  const handler = createBffHandler(db, oauthClient, bffConfig);
  const jetstream = createSubscription(idxService, bffConfig);

  if (cfg.unstable_backfillRepos?.length) {
    await backfillRepos(bffConfig, idxService);
  }

  jetstream.connect();

  Deno.serve({ port: bffConfig.port }, handler);

  Deno.addSignalListener("SIGINT", () => {
    console.log("Shutting down...");
    jetstream.disconnect();
    Deno.exit(0);
  });
}

function configureBff(cfg: Config): BffConfig {
  return {
    ...cfg,
    rootDir: Deno.env.get("BFF_ROOT_DIR") ?? Deno.cwd(),
    publicUrl: Deno.env.get("BFF_PUBLIC_URL") ?? "",
    port: Number(Deno.env.get("BFF_PORT")) || 8080,
    lexiconDir: cfg.lexiconDir ?? "__generated__",
    databaseUrl: cfg.databaseUrl ?? ":memory:",
    oauthScope: cfg.oauthScope ?? "atproto transition:generic",
    middlewares: cfg.middlewares ?? [],
    rootElement: cfg.rootElement ?? Root,
  };
}

function createDb(cfg: BffConfig) {
  const db = new DatabaseSync(cfg.databaseUrl);

  db.exec(`
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
      orderBy?: OrderByOption<T>,
    ): T[] => {
      let query = `SELECT * FROM "record" WHERE collection = ?`;
      const params: string[] = [collection];

      if (orderBy) {
        // Extract the JSON property using JSON_EXTRACT and order by it
        // SQLite supports JSON_EXTRACT for querying JSON stored as text
        query += ` ORDER BY JSON_EXTRACT(json, '$.${String(orderBy.column)}') ${
          orderBy.direction || "asc"
        }`;
      }

      const rows = db.prepare(query).all(...params) as RecordTable[];

      return rows.map(
        (r) => ({
          uri: r.uri,
          cid: r.cid,
          did: r.did,
          indexedAt: r.indexedAt,
          ...JSON.parse(r.json),
        } as T),
      );
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
        ...JSON.parse(result.json),
      } as T;
    },
    insertRecord: (record: {
      uri: string;
      cid: string;
      did: string;
      collection: string;
      json: string;
      indexedAt: string;
    }) => {
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
    deleteRecord: (uri: string) => {
      db.prepare(`DELETE FROM "record" WHERE uri = ?`).run(uri);
    },
    insertActor: (actor: { did: string; handle: string }) => {
      db.prepare(
        `INSERT INTO "actor" (did, handle, "indexedAt") VALUES (?, ?, ?) ON CONFLICT (did) DO UPDATE SET handle = ?, "indexedAt" = ?`,
      ).run(
        actor.did,
        actor.handle,
        new Date().toISOString(),
        actor.handle,
        new Date().toISOString(),
      );
    },
    getActor: (did: string): ActorTable | undefined => {
      const result = db.prepare(`SELECT * FROM "actor" WHERE did = ?`).get(did);
      return result as ActorTable | undefined;
    },
  };
};

function createBffHandler(
  db: Database,
  oauthClient: AtprotoOAuthClient,
  cfg: BffConfig,
) {
  const inner = handler;
  const withMiddlewares = composeMiddlewares(db, oauthClient, cfg);
  return function handler(req: Request, connInfo: Deno.ServeHandlerInfo) {
    return withMiddlewares(req, connInfo, inner);
  };
}

function composeMiddlewares(
  db: Database,
  oauthClient: AtprotoOAuthClient,
  cfg: BffConfig,
) {
  return async (
    req: Request,
    _connInfo: Deno.ServeHandlerInfo,
    inner: (req: Request, ctx: BffContext) => Promise<Response>,
  ) => {
    const mws = cfg.middlewares?.slice().reverse();

    const handlers: (() => Response | Promise<Response>)[] = [];

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

    const ctx: BffContext = {
      state: {},
      next() {
        const handler = handlers.shift()!;
        return Promise.resolve(handler());
      },
      oauthClient,
      indexService: idxService,
      currentUser,
      agent,
      createRecord: createRecordFn,
      didResolver,
      render: () => new Response(),
      cfg,
    };

    ctx.render = render(ctx, cfg);

    if (mws) {
      for (const mw of mws) {
        handlers.push(() => mw(req, ctx));
      }
    }

    handlers.push(() => inner(req, ctx));

    const handler = handlers.shift()!;
    return handler();
  };
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
    wantedCollections: cfg.collections,
    handleEvent: (event) => {
      if (event.kind !== "commit") return;
      if (!event.commit) return;

      const uri =
        `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;

      if (
        (
          event.commit.operation === "create" ||
          event.commit.operation === "update"
        )
      ) {
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
  return async (collection: string, data: { [_ in string]: unknown }) => {
    const did = agent?.assertDid;
    const lexiconsFile = join(
      Deno.cwd(),
      cfg.lexiconDir,
      "lexicons.ts",
    );
    const lex = await import(lexiconsFile);

    const schemas = lex.schemas;
    const lexicons = new Lexicons(schemas);
    const rkey = TID.nextStr();

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const record = {
      $type: collection,
      ...data,
    };

    assert(lexicons.assertValidRecord(collection, record));

    const response = await agent.com.atproto.repo.createRecord({
      repo: agent.assertDid,
      collection,
      rkey,
      record,
      validate: false,
    });

    indexService.insertRecord({
      uri: `at://${did}/${collection}/${rkey}`,
      cid: response.data.cid.toString(),
      did,
      collection,
      json: stringifyLex(record),
      indexedAt: new Date().toISOString(),
    });
  };
}

function render(ctx: BffContext, cfg: BffConfig) {
  return (children: ComponentChildren) => {
    const RootElement = cfg.rootElement;
    return new Response(
      renderToString(<RootElement ctx={ctx}>{children}</RootElement>),
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8;",
        },
      },
    );
  };
}

function Root(props: RootProps) {
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

export function oauth(opts?: OauthMiddlewareOptions): BffMiddleware {
  return async (req, ctx) => {
    const headers = new Headers(req.headers);
    const cookie = getCookies(req.headers);
    const { pathname, searchParams, hostname } = new URL(req.url);

    if (pathname === "/oauth/login") {
      const LoginComponent = opts?.LoginComponent ?? Login;
      const formData = await req.formData();
      const handle = formData.get("handle") as string;

      if (typeof handle !== "string" || !isValidHandle(handle)) {
        return ctx.render(<LoginComponent error="invalid handle" />);
      }

      try {
        const url = await ctx.oauthClient.authorize(handle);
        return new Response(null, {
          status: 200,
          headers: {
            "HX-Redirect": url.toString(),
          },
        });
      } catch (err) {
        console.error("oauth authorize failed:", err);
        const error = err instanceof OAuthResolverError
          ? err.message
          : "couldn't initiate login";
        return new Response(error, { status: 400 });
      }
    }

    if (pathname === "/oauth/callback") {
      try {
        const { session } = await ctx.oauthClient.callback(searchParams);

        const agent = new Agent(session);

        const sessionResponse = await agent.com.atproto.server.getSession();

        if (!sessionResponse) {
          return new Response(null, {
            status: 303, // "See Other"
            headers: {
              location: "/",
            },
          });
        }

        await ctx.cfg.onSignedIn?.(sessionResponse.data);

        ctx.indexService.insertActor({
          did: sessionResponse.data.did,
          handle: sessionResponse.data.handle,
        });

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

        headers.set("location", "/");
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

    if (pathname === "/login") {
      return ctx.render(<Login />);
    }

    if (pathname === "/logout") {
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

    if (pathname === "/client-metadata.json") {
      return new Response(JSON.stringify(ctx.oauthClient.clientMetadata), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return ctx.next();
  };
}

async function backfillRepos(
  cfg: BffConfig,
  indexService: IndexService,
) {
  if (!cfg.unstable_backfillRepos) return;

  const collections = cfg.collections;

  const didResolver = new DidResolver({
    didCache: new MemoryCache(),
  });

  const pdsMap = new Map<string, string>();
  for (const repo of cfg.unstable_backfillRepos) {
    const atpData = await didResolver.resolveAtprotoData(repo);
    if (!pdsMap.has(atpData.did)) {
      pdsMap.set(atpData.did, atpData.pds);
    }
  }

  for (const repo of cfg.unstable_backfillRepos) {
    for (const collection of collections) {
      let cursor: string | undefined = undefined;
      // deno-lint-ignore no-explicit-any
      let allRecords: any[] = [];

      const agent = new Agent(new URL(pdsMap.get(repo)!));

      do {
        const response = await agent.com.atproto.repo.listRecords({
          repo,
          collection,
          cursor,
          limit: 100, // Adjust the batch size
        });
        allRecords = [...allRecords, ...response.data.records];
        cursor = response.data.cursor ?? undefined; // Continue fetching if there's more data
      } while (cursor);

      for (const record of allRecords) {
        indexService.insertRecord({
          uri: record.uri,
          cid: record.cid.toString(),
          did: repo,
          collection,
          json: stringifyLex(record.value),
          indexedAt: new Date().toISOString(),
        });
      }
    }
  }
}
