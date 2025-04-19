import { Record as BffBasicProfile } from "$lexicon/types/dev/fly/bffbasic/profile.ts";
import { BffContext, RouteHandler } from "@bigmoves/bff";
import { ProfileModal } from "../components/ProfileModal.tsx";
import type { State } from "../app.tsx";

export const handler: RouteHandler = (
  _req,
  _params,
  ctx: BffContext<State>,
) => {
  if (!ctx.state.profile) return ctx.next();
  if (!ctx.currentUser) return ctx.next();

  const profileRecord = ctx.indexService.getRecord<BffBasicProfile>(
    `at://${ctx.currentUser.did}/dev.fly.bffbasic.profile/self`,
  );

  if (!profileRecord) return ctx.next();

  return ctx.html(
    <ProfileModal
      profile={ctx.state.profile}
      profileRecord={profileRecord}
    />,
  );
};
