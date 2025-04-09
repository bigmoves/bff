import type { Agent } from "@atproto/api";
import type { Response as SessionResponse } from "@atproto/api/dist/client/types/com/atproto/server/getSession.ts";
import type { DidResolver } from "@atproto/identity";
import type { AtprotoOAuthClient } from "@bigmoves/atproto-oauth-client";
import type { DatabaseSync } from "node:sqlite";
import type { ComponentChildren, FunctionComponent } from "preact";

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

export type Config = {
  appName: string;
  lexiconDir?: string;
  databaseUrl?: string;
  jetstreamUrl?: string;
  collections: string[];
  oauthScope?: string;
  middlewares?: BffMiddleware[];
  rootElement?: RootElement;
  onSignedIn?: (session: SessionResponse["data"]) => Promise<void> | void;

  unstable_backfillRepos?: string[];
};

export type EnvConfig = {
  port: number;
  publicUrl: string;
  rootDir: string;
};

export type BffConfig = Config & EnvConfig & {
  lexiconDir: string;
  databaseUrl: string;
  oauthScope: string;
  rootElement: RootElement;
};

// Helper type to extract keys from T that are valid for ordering
type OrderableKeys<T> = Extract<keyof T, string>;

export interface OrderByOption<T> {
  column: OrderableKeys<T>; // The JSON property to order by
  direction?: "asc" | "desc"; // Optional sort direction
}

type IndexService = {
  getRecords: <T extends Record<string, unknown>>(
    collection: string,
    orderBy?: OrderByOption<T>,
  ) => T[];
  getRecord: <T extends Record<string, unknown>>(
    uri: string,
  ) => T | undefined;
  insertRecord: (record: {
    uri: string;
    cid: string;
    did: string;
    collection: string;
    json: string;
    indexedAt: string;
  }) => void;
  deleteRecord: (uri: string) => void;
  insertActor: (actor: { did: string; handle: string }) => void;
  getActor: (did: string) => ActorTable | undefined;
};

export type BffContext<State = Record<string, unknown>> = {
  state: State;
  didResolver: DidResolver;
  agent?: Agent;
  createRecord: <T>(collection: string, data: Partial<T>) => Promise<void>;
  indexService: IndexService;
  oauthClient: AtprotoOAuthClient;
  currentUser?: ActorTable;
  cfg: BffConfig;
  next: () => Promise<Response>;
  render: (children: ComponentChildren) => Response;
};

export interface JetstreamEvent<T> {
  did: string;
  time_us: number;
  kind: string;
  commit?: {
    rev: string;
    operation: string;
    collection: string;
    rkey: string;
    record: T;
    cid: string;
  };
}

export type OauthMiddlewareOptions = {
  LoginComponent?: FunctionComponent<{ error?: string }>;
};

export type RootProps<T = Record<string, unknown>> = {
  ctx: BffContext<T>;
  children: ComponentChildren;
};
