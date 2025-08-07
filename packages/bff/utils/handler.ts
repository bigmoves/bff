import type { DidResolver } from "@atproto/identity";
import type { AtprotoOAuthClient } from "@bigmoves/atproto-oauth-client";
import { composeMiddlewares } from "../middleware/compose.ts";
import type { IndexService } from "../services/indexing.ts";
import type { BffConfig, Database } from "../types.d.ts";
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
  indexService: IndexService;
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
