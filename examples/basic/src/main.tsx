import { ProfileView } from "$lexicon/types/dev/fly/bffbasic/defs.ts";
import { BlobRef } from "@atproto/lexicon";
import { bff, oauth } from "@bigmoves/bff";
import { Login } from "@bigmoves/bff/components";
import { TtlCache } from "@std/cache";
import { Root } from "./app.tsx";
import { routes } from "./routes.tsx";
import { onSignedIn, profileStateResolver } from "./utils.ts";

export type State = {
  profile?: ProfileView;
};

export const blobCache = new TtlCache<string, BlobRef>(1000 * 60 * 60);

bff({
  appName: "AT Protocol App",
  collections: ["dev.fly.bffbasic.profile"],
  rootElement: Root,
  onSignedIn,
  middlewares: [
    profileStateResolver,
    oauth({
      LoginComponent: ({ error }) => (
        <div id="login" class="flex justify-center items-center w-full h-full">
          <Login hx-target="body" error={error} />
        </div>
      ),
    }),
    ...routes,
  ],
});
