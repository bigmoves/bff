import { Agent } from "@atproto/api";
import { OAuthResolverError } from "@atproto/oauth-client";
import { AtprotoOAuthClient } from "@bigmoves/atproto-oauth-client";
import { JoseKey } from "@bigmoves/atproto-oauth-client/jose_key.ts";
import { deleteCookie, getCookies, setCookie } from "@std/http";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { Login } from "../components/Login.tsx";
import { createRecord } from "../services/records.ts";
import type { ActorTable, ApplicationType, BffConfig, BffContext, BffMiddleware, Database, OauthMiddlewareOptions } from "../types.d.ts";
import { parseCookie, signCookie } from "../utils/cookies.ts";
import { createSessionStore, createStateStore } from "../utils/database.ts";
import { getInstanceInfo } from "../utils/litefs.ts";

export const OAUTH_ROUTES = {
  loginPage: "/login",
  login: "/oauth/login",
  callback: "/oauth/callback",
  signup: "/signup",
  logout: "/logout",
  clientMetadata: "/oauth-client-metadata.json",
  jwks: "/oauth/jwks.json",
  session: "/api/session",
  refreshToken: "/api/token/refresh",
  revokeToken: "/api/token/revoke",
};

export function oauth(opts?: OauthMiddlewareOptions): BffMiddleware {
  return async (req: Request, ctx: BffContext) => {
    const headers = new Headers(req.headers);
    const cookie = getCookies(req.headers);
    const { pathname, searchParams, hostname } = new URL(req.url);
    const LoginComponent = opts?.LoginComponent ?? Login;

    if (pathname === OAUTH_ROUTES.login) {
      let handle: string | undefined;
      const clientType = searchParams.get("client");
      const oauthClient = clientType === "native"
        ? ctx.oauthClientNative
        : ctx.oauthClient;

      if (clientType === "native") {
        handle = searchParams.get("handle") ?? undefined;

        if (typeof handle !== "string") {
          return ctx.json(
            { error: "invalid handle" },
            400,
          );
        }
      } else if (req.method === "POST") {
        const formData = await req.formData();
        handle = formData.get("handle") as string ?? undefined;

        if (typeof handle !== "string") {
          return ctx.html(<LoginComponent error="invalid handle" />);
        }
      }

      if (!handle) {
        throw new Error("Handle is required for login");
      }

      try {
        const url = await oauthClient.authorize(handle, {
          signal: req.signal,
          state: clientType ?? undefined,
        });
        return ctx.redirect(url.toString());
      } catch (err) {
        console.error("oauth authorize failed:", err);
        const error = err instanceof OAuthResolverError
          ? err.message
          : "couldn't initiate login";

        if (clientType === "native") {
          return ctx.json({ error }, 400);
        }

        return ctx.html(<LoginComponent error={error} />);
      }
    }

    if (pathname === OAUTH_ROUTES.callback) {
      try {
        const { currentIsPrimary, primaryInstance } = await getInstanceInfo(
          ctx.cfg,
        );

        if (!currentIsPrimary) {
          return new Response(null, {
            status: 409,
            headers: {
              "fly-replay": `instance=${primaryInstance}`,
            },
          });
        }

        const stateKey = searchParams.get("state");
        const stateData = ctx.indexService.getState(stateKey ?? "");
        const state = stateData?.appState;

        const oauthClient = state === "native"
          ? ctx.oauthClientNative
          : ctx.oauthClient;

        const { session } = await oauthClient.callback(searchParams);

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

        if (state) {
          if (state !== "native") {
            throw new Error("Unexpected state in OAuth callback");
          }

          if (!ctx.cfg.jwtSecret) {
            throw new Error("BFF_JWT_SECRET secret is not configured");
          }

          const expiresIn = 60 * 15; // 15 minutes
          const now = Math.floor(Date.now() / 1000);
          const expiresAt = now + expiresIn;
          const expiresAtStr = new Date(expiresAt * 1000).toISOString();
          const token = jwt.sign(
            { did: session.did },
            ctx.cfg.jwtSecret,
            {
              expiresIn,
            },
          );
          const refreshToken = randomBytes(32).toString("hex");
          ctx.indexService.insertAuthToken(
            session.did,
            refreshToken,
            new Date().toISOString(),
            expiresAtStr,
          );
          let url =
            `${ctx.cfg.tokenCallbackUrl}?token=${encodeURIComponent(token)}` +
            `&refreshToken=${encodeURIComponent(refreshToken)}` +
            `&expiresAt=${expiresAtStr}` +
            `&did=${encodeURIComponent(session.did)}`;
          const redirectPath = await opts?.onSignedIn?.({ actor, ctx });
          if (redirectPath) {
            url += `&redirect=${encodeURIComponent(redirectPath)}`;
          }
          return ctx.redirect(url);
        }

        const redirectPath = await opts?.onSignedIn?.({ actor, ctx });

        const value = btoa(session.did);
        const signature = await signCookie(value, ctx.cfg.cookieSecret);
        const signedCookie = `${value}|${signature}`;

        const headers = new Headers();
        setCookie(headers, {
          name: "auth",
          value: signedCookie,
          maxAge: 604800, // 7 days
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
      const formData = await req.formData();
      let pdsHostUrl = formData.get("pdsHostUrl") as string;

      if (typeof pdsHostUrl !== "string" || !pdsHostUrl) {
        pdsHostUrl = opts?.createAccountPdsHost || "https://bsky.social";
      }

      try {
        const url = await ctx.oauthClient.authorize(
          pdsHostUrl,
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
        const value = await parseCookie(cookie.auth, ctx.cfg.cookieSecret);
        if (!value) {
          throw new Error("Failed to parse cookie");
        }
        await ctx.oauthClient.revoke(value);
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

    if (pathname === OAUTH_ROUTES.jwks) {
      return new Response(JSON.stringify(ctx.oauthClient.jwks), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === OAUTH_ROUTES.session) {
      if (!ctx.currentUser) {
        return ctx.json({ message: "Unauthorized" }, 401);
      }
      const did = ctx.currentUser.did;
      try {
        if (!ctx.cfg.jwtSecret) {
          throw new Error("BFF_JWT_SECRET secret is not configured");
        }
        const expiresIn = 60 * 15; // 15 minutes
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + expiresIn;
        const token = jwt.sign({ did }, ctx.cfg.jwtSecret, {
          expiresIn,
        });
        const refreshToken = randomBytes(32).toString("hex");
        return ctx.json({
          token,
          refreshToken,
          did,
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        });
      } catch (err) {
        console.error("Failed to refresh token:", err);
        return ctx.json({ message: "Failed to refresh token" }, 500);
      }
    }

    if (pathname === OAUTH_ROUTES.refreshToken && req.method === "POST") {
      const { refreshToken } = await req.json();
      const actor = ctx.indexService.getActorByRefreshToken(refreshToken);
      if (!actor) {
        return ctx.json({ message: "Invalid refresh token" }, 401);
      }
      const expiresIn = 60 * 15; // 15 minutes
      const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
      const expiresAtStr = new Date(expiresAt * 1000).toISOString();
      const token = jwt.sign(
        { did: actor.did },
        ctx.cfg.jwtSecret,
        {
          expiresIn,
        },
      );
      const newRefreshToken = randomBytes(32).toString("hex");
      ctx.indexService.insertAuthToken(
        actor.did,
        newRefreshToken,
        new Date().toISOString(),
        expiresAtStr,
      );
      return ctx.json({
        token,
        refreshToken: newRefreshToken,
        did: actor.did,
        expiresAtStr,
      });
    }

    if (pathname === OAUTH_ROUTES.revokeToken && req.method === "POST") {
      const { refreshToken } = await req.json();
      const actor = ctx.indexService.getActorByRefreshToken(refreshToken);
      if (!actor) {
        return ctx.json({ message: "Invalid refresh token" }, 401);
      }
      ctx.indexService.deleteAuthToken(actor.did);
      await ctx.oauthClientNative.revoke(actor.did);
      return ctx.json({ message: "Token revoked successfully" });
    }

    return ctx.next();
  };
}

export async function createOauthClient(
  db: Database,
  cfg: BffConfig,
  applicationType: ApplicationType = "web",
) {
  const publicUrl = cfg.publicUrl;
  const url = publicUrl || `http://127.0.0.1:${cfg.port}`;
  const enc = encodeURIComponent;
  const scope = cfg.oauthScope;

  const hasPrivateKeys =
    !!(cfg.privateKey1 && cfg.privateKey2 && cfg.privateKey3);

  // const requestLock = createLock(db, cfg);

  return new AtprotoOAuthClient({
    plcDirectoryUrl: cfg.plcDirectoryUrl,
    responseMode: "query",
    clientMetadata: {
      client_name: cfg.appName,
      client_id: publicUrl
        ? `${url}${OAUTH_ROUTES.clientMetadata}`
        : `http://localhost?redirect_uri=${
          enc(
            `${url}/oauth/callback`,
          )
        }&scope=${enc(scope)}`,
      client_uri: url,
      jwks_uri: `${url}${OAUTH_ROUTES.jwks}`,
      redirect_uris: [`${url}${OAUTH_ROUTES.callback}`],
      scope,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      token_endpoint_auth_method: hasPrivateKeys ? "private_key_jwt" : "none",
      dpop_bound_access_tokens: true,
      ...hasPrivateKeys && { token_endpoint_auth_signing_alg: "ES256" },
    },
    stateStore: createStateStore(db, applicationType),
    sessionStore: createSessionStore(db, applicationType),
    ...hasPrivateKeys && {
      // @TODO: fix this type assertion
      keyset: (await Promise.all([
        JoseKey.fromImportable(cfg.privateKey1 ?? "{}"),
        JoseKey.fromImportable(cfg.privateKey2 ?? "{}"),
        JoseKey.fromImportable(cfg.privateKey3 ?? "{}"),
      ])) as unknown as ConstructorParameters<
        typeof AtprotoOAuthClient
      >[0]["keyset"],
    },
  });
}