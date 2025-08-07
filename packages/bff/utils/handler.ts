import { AtprotoOAuthClient } from "@bigmoves/atproto-oauth-client";
import { DidResolver } from "@atproto/identity";
import type { BffConfig, Database } from "../types.d.ts";
import { composeMiddlewares } from "../middleware/compose.ts";
import { handler } from "./routing.ts";

export function createBffHandler({
  db,
  oauthClient,
  oauthClientNative,
  cfg,
  didResolver,
  fileFingerprints,
  indexService,
}: {
  db: Database;
  oauthClient: AtprotoOAuthClient;
  oauthClientNative: AtprotoOAuthClient;
  cfg: BffConfig;
  didResolver: DidResolver;
  fileFingerprints: Map<string, string>;
  indexService: (db: Database, cfg: BffConfig) => any;
}) {
  const inner = handler;
  const withMiddlewares = composeMiddlewares({
    db,
    oauthClient,
    oauthClientNative,
    cfg,
    didResolver,
    fileFingerprints,
    indexService,
  });
  return function handler(req: Request, connInfo: Deno.ServeHandlerInfo) {
    return withMiddlewares(req, connInfo, inner);
  };
}