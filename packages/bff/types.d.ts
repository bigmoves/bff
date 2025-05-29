import type { Agent } from "@atproto/api";
import type { DidResolver } from "@atproto/identity";
import type { BlobRef, Lexicons } from "@atproto/lexicon";
import type { AtprotoOAuthClient } from "@bigmoves/atproto-oauth-client";
import type { DatabaseSync } from "node:sqlite";
import type { ComponentChildren, FunctionComponent, VNode } from "preact";

export type Database = DatabaseSync;

export type ActorTable = {
  did: string;
  handle: string;
  lastSeenNotifs?: string;
  indexedAt: string;
};

export type RecordTable = {
  uri: string;
  cid: string;
  did: string;
  collection: string;
  json: string;
  indexedAt: string;
};

export type RecordMeta = {
  indexedAt: string;
  cid: string;
  did: string;
  uri: string;
};

export type WithBffMeta<T> = T & RecordMeta;

export type BffMiddleware = (
  req: Request,
  ctx: BffContext,
) => Promise<Response>;

type RootElement = <T extends Record<string, unknown>>(
  props: RootProps<T>,
) => preact.VNode;

export type onListenArgs = { indexService: IndexService; cfg: BffConfig };

export type BffOptions = {
  /** The name of the app, used for OAuth */
  appName: string;
  /**
   * The URL of the database, used for SQLite
   * @default ":memory:"
   */
  databaseUrl?: string;
  /** The URL of the Jetstream server */
  jetstreamUrl?: string;
  /** Collections to index off the firehose from internal lexicons */
  collections?: string[];
  /** Collections to index off the firehose from external lexicons */
  externalCollections?: string[];
  /** OAuth Scopes */
  /** @default "atproto transition:generic" */
  oauthScope?: string;
  /** Functions that are called before rendering and can modify the content or make other changes. */
  middlewares?: BffMiddleware[];
  /** The lexicons class imported from codegen. */
  lexicons?: Lexicons;
  /** The root element of the app */
  rootElement?: RootElement;
  /** Called when the server starts listening. */
  onListen?: (params: onListenArgs) => Promise<void> | void;
  /** Called when the server throws an error. */
  onError?: (err: unknown) => Response | Promise<Response>;
};

export type EnvConfig = {
  /**
   * The port to serve the app on
   * @default 8080
   */
  port: number;
  /** The URL of the app, used for OAuth */
  publicUrl: string;
  /**
   * The root directory of the app
   * @default process.cwd()
   */
  rootDir: string;
  /** The lifefs directory. This should be what you set your fuse.dir config to in the litefs.yml config. */
  litefsDir: string;
  /** The cookie secret */
  cookieSecret: string;
  /** jwks private key 1 */
  privateKey1?: string;
  /** jwks private key 2 */
  privateKey2?: string;
  /** jwks private key 3 */
  privateKey3?: string;
  /** The PLC directory url */
  plcDirectoryUrl?: string;
  /** The URL of the Jetstream server */
  jetstreamUrl?: string;
};

export type BffConfig = BffOptions & EnvConfig & {
  lexicons: Lexicons;
  /**
   * The URL of the database, used for SQLite
   * @default ":memory:"
   */
  databaseUrl: string;
  queueDatabaseUrl: string;
  oauthScope: string;
  rootElement: RootElement;
};

export type OrderByOption = {
  field: string;
  direction?: "asc" | "desc";
};

export type WhereOption = {
  field: string;
  equals?: string;
  contains?: string;
  in?: string[];
};

interface WhereCondition {
  field: string;
  equals?: string | number | boolean;
  contains?: string;
  in?: Array<string | number | boolean>;
}

type NestedWhere = {
  AND?: Where[];
  OR?: Where[];
  NOT?: Where;
};

export type Where = WhereCondition | NestedWhere;

export type QueryOptions = {
  orderBy?: OrderByOption[];
  where?: Where | Where[];
  limit?: number;
  cursor?: string;
};

export type IndexService = {
  getRecords: <T extends Record<string, unknown>>(
    collection: string,
    opts?: QueryOptions,
  ) => { items: T[]; cusor?: string };
  getRecord: <T extends Record<string, unknown>>(
    uri: string,
  ) => T | undefined;
  insertRecord: (record: RecordTable) => void;
  updateRecord: (record: RecordTable) => void;
  updateRecords: (records: RecordTable[]) => void;
  deleteRecord: (uri: string) => void;
  insertActor: (actor: ActorTable) => void;
  getActor: (did: string) => ActorTable | undefined;
  getActorByHandle: (handle: string) => ActorTable | undefined;
  searchActors: (
    query: string,
    opts?: { limit?: number },
  ) => ActorTable[];
  getMentioningUris: (
    did: string,
  ) => string[];
  updateActor: (did: string, lastSeenNotifs: string) => void;
};

export type BffContext<State = Record<string, unknown>> = {
  state: State;
  didResolver: DidResolver;
  agent?: Agent;
  createRecord: <T>(
    collection: string,
    data: Partial<T>,
    self?: boolean,
  ) => Promise<string>;
  updateRecord: <T>(
    collection: string,
    rkey: string,
    data: Partial<T>,
  ) => Promise<string>;
  updateRecords: <T>(
    updates: Array<{
      collection: string;
      rkey: string;
      data: Partial<T>;
    }>,
  ) => Promise<string[]>;
  deleteRecord: (uri: string) => Promise<void>;
  backfillCollections: (params: {
    collections?: string[];
    externalCollections?: string[];
    repos?: string[];
  }) => Promise<void>;
  backfillUris: (
    uris: string[],
  ) => Promise<void>;
  uploadBlob: (file: File) => Promise<BlobRef>;
  indexService: IndexService;
  oauthClient: AtprotoOAuthClient;
  currentUser?: ActorTable;
  cfg: BffConfig;
  next: () => Promise<Response>;
  render: (
    children: ComponentChildren,
    headers?: Record<string, string>,
  ) => Response;
  html: (vnode: VNode, headers?: Record<string, string>) => Response;
  redirect: (url: string) => Response;
  rateLimit: (options: {
    namespace: string;
    points?: number;
    limit: number;
    window: number;
    key?: string;
  }) => boolean;
  requireAuth: () => ActorTable; // Returns the currentUser if authenticated, throws otherwise
  getNotifications: <T extends Record<string, unknown>>() => T[];
  updateSeen: () => void;
};

export type onSignedInArgs = {
  actor: ActorTable;
  ctx: BffContext;
};

export type OauthMiddlewareOptions = {
  LoginComponent?: FunctionComponent<{ error?: string }>;
  /**
   * Hook that's called when a user logs in
   * @returns {string | undefined} The URL to redirect to after login
   */
  onSignedIn?: (params: onSignedInArgs) => Promise<string | undefined> | void;

  createAccountPdsHost?: string;
};

export type RootProps<T = Record<string, unknown>> = {
  ctx: BffContext<T>;
  children: ComponentChildren;
};

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS";

export type RouteHandler = (
  req: Request,
  params: Record<string, string>,
  ctx: BffContext,
) => Promise<Response> | Response;
