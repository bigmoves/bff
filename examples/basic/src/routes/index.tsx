import { BffContext, RouteHandler } from "@bigmoves/bff";
import { HomePage } from "../components/HomePage.tsx";
import { State } from "../main.tsx";

export const handler: RouteHandler = (
  _req,
  _params,
  ctx: BffContext<State>,
) => {
  return ctx.render(
    <HomePage
      isLoggedIn={!!ctx.currentUser}
      profile={ctx.state.profile}
    />,
  );
};
