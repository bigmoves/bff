import { BffMiddleware, route, uploadHandler } from "@bigmoves/bff";
import { AvatarOob } from "./components/AvatarOob.tsx";
import { NotFoundPage } from "./components/NotFoundPage.tsx";
import { handler as index } from "./routes/index.tsx";
import { handler as modalsAvatar } from "./routes/modals_avatar.tsx";
import { handler as modalsProfile } from "./routes/modals_profile.tsx";
import { handler as onboard } from "./routes/onboard.tsx";
import { handler as profile } from "./routes/profile.tsx";
import { handler as profileUpdate } from "./routes/profile_update.tsx";

export const routes: BffMiddleware[] = [
  // pages
  route("/", index),
  route("/profile/:handle", profile),
  route("/onboard", onboard),

  // handlers
  route(
    "/uploads/avatar",
    ["POST"],
    uploadHandler(([blobMeta]) => <AvatarOob {...blobMeta} />),
  ),
  route("/profile", ["POST"], profileUpdate),

  // ui
  route("/modals/profile", modalsProfile),
  route("/modals/avatar/:handle", modalsAvatar),

  // not found
  route("*", ["GET"], (req, _params, ctx) => {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/static/")) {
      return ctx.next();
    }
    return ctx.render(
      <NotFoundPage />,
    );
  }),
];
