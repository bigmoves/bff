import type { Agent } from "@atproto/api";
import type { DidResolver } from "@atproto/identity";
import type { BlobRef, Lexicons } from "@atproto/lexicon";
import type { AtprotoOAuthClient } from "@bigmoves/atproto-oauth-client";
import type { TtlCache } from "@std/cache";
import type { DatabaseSync } from "node:sqlite";
import type { ComponentChildren, FunctionComponent, VNode } from "preact";

export type Database = DatabaseSync;

export type ActorTable = {
  did: string;
  handle: string;
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

export type onListenArgs = { indexService: IndexService };

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
  /** Collections to index from the firehose */
  collections?: string[];
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

export type QueryOptions = {
  orderBy?: {
    field: string;
    direction?: "asc" | "desc";
  };
  where?: Array<
    { field: string; equals?: string; contains?: string; in?: string[] }
  >;
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
  deleteRecord: (uri: string) => void;
  insertActor: (actor: ActorTable) => void;
  getActor: (did: string) => ActorTable | undefined;
  getActorByHandle: (handle: string) => ActorTable | undefined;
};

type BlobMeta = {
  dataUrl?: string;
  blobRef?: BlobRef;
  dimensions?: {
    width?: number;
    height?: number;
  };
};

type UploadBlobOptions = {
  compress?: boolean;
};

export type UploadBlobArgs = {
  file: File;
  dataUrl?: string;
  opts?: UploadBlobOptions;
};

export type BffContext<State = Record<string, unknown>> = {
  state: State;
  didResolver: DidResolver;
  agent?: Agent;
  blobMetaCache: TtlCache<string, BlobMeta>;
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
  deleteRecord: (uri: string) => Promise<void>;
  backfillCollections: (
    repos: string[],
    collections: string[],
  ) => Promise<void>;
  backfillUris: (
    uris: string[],
  ) => Promise<void>;
  uploadBlob: (params: UploadBlobArgs) => string;
  indexService: IndexService;
  oauthClient: AtprotoOAuthClient;
  currentUser?: ActorTable;
  cfg: BffConfig;
  next: () => Promise<Response>;
  render: (children: ComponentChildren) => Response;
  html: (vnode: VNode, headers?: Record<string, string>) => Response;
  redirect: (url: string) => Response;
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

type QueuePayload = { type: string; data: unknown };

export type ProcessImageQueuePayload = QueuePayload & {
  type: "process_image";
  data: {
    uploadId: string;
    did: string;
    imagePath: string;
    opts?: {
      compress?: boolean;
    };
  };
};

export type QueuePayloads = ProcessImageQueuePayload;

type QueueItemResult = {
  uploadId: string;
  did: string;
  imagePath: string;
  dimensions: {
    width?: number;
    height?: number;
  };
};

type QueueItem = {
  id: string;
  did: string;
  imagePath: string;
  status: "pending" | "processing" | "completed" | "failed";
  result?: QueueItemResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Queue = {
  enqueue: (payload: QueuePayloads) => Promise<void>;
  close: () => Promise<void>;
};
