import { Agent } from "@atproto/api";
import type { DidResolver } from "@atproto/identity";
import type { AtprotoOAuthClient } from "@bigmoves/atproto-oauth-client";
import { getCookies } from "@std/http";
import { backfillCollections, backfillUris } from "../services/backfill.ts";
import type { IndexService } from "../services/indexing.ts";
import { getLabelerDefinitions } from "../services/labeler.ts";
import { getNotifications, updateSeen } from "../services/notifications.ts";
import {
  createRecord,
  createRecords,
  deleteRecord,
  updateRecord,
  updateRecords,
} from "../services/records.ts";
import type {
  ActorTable,
  BffConfig,
  BffContext,
  Database,
} from "../types.d.ts";
import { parseJwtFromAuthHeader, requireAuth } from "../utils/auth.ts";
import { uploadBlob } from "../utils/blob.ts";
import { parseCookie } from "../utils/cookies.ts";
import { rateLimit } from "../utils/rate_limit.ts";
import { html, json, redirect, render } from "../utils/response.tsx";
import { composeHandlers } from "../utils/routing.ts";

export function composeMiddlewares({
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
  return async (
    req: Request,
    _connInfo: Deno.ServeHandlerInfo,
    inner: (req: Request, ctx: BffContext) => Promise<Response>,
  ) => {
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
      const actor = indexService.getActor(sessionDid);
      currentUser = actor;
    }

    const createRecordFn = createRecord(agent, indexService, cfg);
    const createRecordsFn = createRecords(agent, indexService, cfg);
    const updateRecordFn = updateRecord(agent, indexService, cfg);
    const updateRecordsFn = updateRecords(agent, indexService, cfg);
    const deleteRecordFn = deleteRecord(agent, indexService);
    const backfillCollectionsFn = backfillCollections(indexService, cfg);
    const backfillUrisFn = backfillUris(indexService, cfg);
    const uploadBlobFn = uploadBlob(agent);
    const rateLimitFn = rateLimit(req, currentUser, db);
    const getNotificationsFn = getNotifications(currentUser, indexService);
    const updateSeenFn = updateSeen(currentUser, indexService);
    const getLabelerDefinitionsFn = getLabelerDefinitions(didResolver, cfg);

    const ctx: BffContext = {
      state: {},
      oauthClient,
      oauthClientNative,
      indexService: indexService,
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
}
