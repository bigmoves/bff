import { serveDir } from "@std/http/file-server";
import type { BffContext, BffMiddleware, HttpMethod, RouteHandler } from "../types.d.ts";

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

export async function handler(req: Request, ctx: BffContext) {
  const { pathname } = new URL(req.url);

  if (pathname.startsWith(`/${ctx.cfg.buildDir}/`)) {
    return serveDir(req, {
      fsRoot: ctx.cfg.rootDir,
    });
  }

  return new Response("Not found", {
    status: 404,
  });
}

export function composeHandlers(
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