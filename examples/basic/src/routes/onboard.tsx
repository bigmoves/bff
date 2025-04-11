import { BffContext, RouteHandler } from "@bigmoves/bff";
import { State } from "../main.tsx";

export const handler: RouteHandler = (
  _req,
  _params,
  ctx: BffContext<State>,
) => {
  return ctx.render(
    <div
      hx-get="/modals/profile"
      hx-trigger="load"
      hx-target="body"
      hx-swap="afterbegin"
    >
    </div>,
  );
};
