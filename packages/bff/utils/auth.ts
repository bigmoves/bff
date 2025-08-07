import jwt from "jsonwebtoken";
import { UnauthorizedError } from "./errors.ts";
import type { ActorTable, BffConfig, BffContext } from "../types.d.ts";

export function requireAuth(ctx: BffContext): ActorTable {
  if (!ctx.currentUser) {
    throw new UnauthorizedError("User not authenticated", ctx);
  }
  return ctx.currentUser;
}

export function parseJwtFromAuthHeader(
  req: Request,
  cfg: BffConfig,
): string | undefined {
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!bearerToken) {
    return undefined;
  }

  let did: string | undefined;

  if (!cfg.jwtSecret) {
    console.error("BFF_JWT_SECRET secret is not configured");
    return undefined;
  }

  try {
    const decoded = jwt.verify(bearerToken, cfg.jwtSecret);
    did = decoded.did as string;
  } catch (_err) {
    console.error("JWT verification failed:", _err);
    return undefined;
  }
  return did;
}