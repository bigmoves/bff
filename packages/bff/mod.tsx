import { Agent } from "@atproto/api";
import { TID } from "@atproto/common";
import { type AtprotoData, DidResolver, MemoryCache } from "@atproto/identity";
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
import type { ComponentChildren, VNode } from "preact";
import { render as renderToString } from "preact-render-to-string";
import { Login } from "./components/Login.tsx";
import { Jetstream } from "./jetstream.ts";
import { CSS } from "./styles.ts";
import type {
  ActorTable,
  BffConfig,
  BffContext,
  BffMiddleware,
  BffOptions,
  Database,
  HttpMethod,
  IndexService,
  OauthMiddlewareOptions,
  QueryOptions,
  RecordTable,
  RootProps,
  RouteHandler,
} from "./types.d.ts";
import { hydrateBlobRefs } from "./utils.ts";

export type {
  ActorTable,
  BffContext,
  BffMiddleware,
  BffOptions,
  onSignedInArgs,
  RecordTable,
  RootProps,
  RouteHandler,
  WithBffMeta,
} from "./types.d.ts";

export { CSS } from "./styles.ts";

export async function bff(opts: BffOptions) {
  const bffConfig = configureBff(opts);
  const db = createDb(bffConfig);
  const idxService = indexService(db);
  const oauthClient = createOauthClient(db, bffConfig);
  const handler = createBffHandler(db, oauthClient, bffConfig);
  const jetstream = createSubscription(idxService, bffConfig);

  await backfillRepos(
    idxService,
    bffConfig,
  )(bffConfig.unstable_backfillRepos ?? []);

  jetstream.connect();

  Deno.serve({ port: bffConfig.port }, handler);

  Deno.addSignalListener("SIGINT", () => {
    console.log("Shutting down...");
    jetstream.disconnect();
    Deno.exit(0);
  });
}

function configureBff(cfg: BffOptions): BffConfig {
  if (!cfg.collections.length) {
    throw new Error("No collections provided");
  }

  return {
    ...cfg,
    rootDir: Deno.env.get("BFF_ROOT_DIR") ?? Deno.cwd(),
    publicUrl: Deno.env.get("BFF_PUBLIC_URL") ?? "",
    port: Number(Deno.env.get("BFF_PORT")) || 8080,
    databaseUrl: Deno.env.get("BFF_DATABASE_URL") ??
      ":memory:",
    lexiconDir: Deno.env.get("BFF_LEXICON_DIR") ?? "__generated__",
    jetstreamUrl: cfg.jetstreamUrl ?? "wss://jetstream2.us-west.bsky.network",
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
      options?: QueryOptions,
    ) => {
      let query = `SELECT * FROM "record" WHERE collection = ?`;
      const params: string[] = [collection];

      const tableColumns = ["did", "uri"];

      if (options?.where && options.where.length > 0) {
        // Handle multiple where conditions
        options.where.forEach((condition) => {
          const field = condition.field;
          if (tableColumns.includes(field)) {
            query += ` AND ${field} = ?`;
          } else {
            query += ` AND JSON_EXTRACT(json, '$.${field}') = ?`;
          }
          params.push(condition.value);
        });
      }

      if (options?.orderBy) {
        const field = options.orderBy.field;
        if (tableColumns.includes(field)) {
          query += ` ORDER BY ${field}`;
        } else {
          query += ` ORDER BY JSON_EXTRACT(json, '$.${field}')`;
        }
        query += ` ${options.orderBy.direction || "asc"}`;
      }

      const rows = db.prepare(query).all(...params) as RecordTable[];

      return rows.map(
        (r) => ({
          uri: r.uri,
          cid: r.cid,
          did: r.did,
          indexedAt: r.indexedAt,
          ...hydrateBlobRefs(JSON.parse(r.json)),
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
    const backfillReposFn = backfillRepos(idxService, cfg);

    const ctx: BffContext = {
      state: {},
      oauthClient,
      indexService: idxService,
      currentUser,
      agent,
      createRecord: createRecordFn,
      updateRecord: updateRecordFn,
      deleteRecord: deleteRecordFn,
      backfillRepos: backfillReposFn,
      didResolver,
      render: () => new Response(),
      html: html(),
      cfg,
      next: async () => new Response(),
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
    wantedCollections: cfg.collections,
    handleEvent: async (event) => {
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
        const lexicons = await getLexicons(cfg);

        lexicons.assertValidRecord(
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

async function getLexicons(cfg: BffConfig) {
  const lexiconsFile = join(
    Deno.cwd(),
    cfg.lexiconDir,
    "lexicons.ts",
  );
  const lex = await import(lexiconsFile);
  const schemas = lex.schemas;
  return new Lexicons(schemas);
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
    const lexicons = await getLexicons(cfg);
    const rkey = self ? "self" : TID.nextStr();

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
    const lexicons = await getLexicons(cfg);

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    const record = {
      $type: collection,
      ...data,
    };

    assert(lexicons.assertValidRecord(collection, record));

    const response = await agent.com.atproto.repo.putRecord({
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

function deleteRecord(
  agent: Agent | undefined,
  indexService: IndexService,
) {
  return async (collection: string, rkey: string) => {
    const did = agent?.assertDid;

    if (!did) {
      throw new Error("Agent is not authenticated");
    }

    await agent.com.atproto.repo.deleteRecord({
      repo: agent.assertDid,
      collection,
      rkey,
    });

    indexService.deleteRecord(`at://${did}/${collection}/${rkey}`);
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
  return (vnode: VNode) => {
    const str = renderToString(vnode);
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
        ctx.backfillRepos = backfillRepos(
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
        return new Response(null, {
          status: 302,
          headers: { "HX-Redirect": url.toString() },
        });
      } catch (err) {
        console.error("oauth authorize failed:", err);
        return new Response(
          null,
          {
            status: 302,
            headers: {
              "HX-Redirect": "/",
            },
          },
        );
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

function backfillRepos(
  indexService: IndexService,
  cfg: BffConfig,
) {
  return async (repos: string[], collections?: string[]) => {
    if (!repos.length) return;

    const collectionsToSync = collections ?? cfg.collections;

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

    for (const repo of repos) {
      for (const collection of collectionsToSync) {
        let cursor: string | undefined = undefined;
        // deno-lint-ignore no-explicit-any
        let allRecords: any[] = [];

        const atpData = atpMap.get(repo);

        if (!atpData) {
          console.error(`No Atproto data found for repo: ${repo}`);
          continue;
        }

        const agent = new Agent(new URL(atpData.pds!));

        do {
          const response = await agent.com.atproto.repo.listRecords({
            repo,
            collection,
            cursor,
            limit: 100,
          });
          allRecords = [...allRecords, ...response.data.records];
          cursor = response.data.cursor ?? undefined; // Continue fetching if there's more data
        } while (cursor);

        for (const record of allRecords) {
          indexService.insertActor({
            did: repo,
            handle: atpData.handle,
            indexedAt: new Date().toISOString(),
          });

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
