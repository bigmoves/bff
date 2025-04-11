import { Record as BskyProfileRecord } from "$lexicon/types/app/bsky/actor/profile.ts";
import { ProfileView } from "$lexicon/types/dev/fly/bffbasic/defs.ts";
import { Record as ProfileRecord } from "$lexicon/types/dev/fly/bffbasic/profile.ts";
import { Un$Typed } from "$lexicon/util.ts";
import { stringifyLex } from "@atproto/lexicon";
import { AtprotoSession, BffContext, WithBffMeta } from "@bigmoves/bff";

export async function onSignedIn(
  session: AtprotoSession,
  ctx: BffContext,
): Promise<string | undefined> {
  let bffBasicProfileRecord: ProfileRecord | undefined;
  let bskyProfileRecord: BskyProfileRecord | undefined;

  try {
    const existingProfileResponse = await ctx.agent?.com.atproto.repo.getRecord(
      {
        repo: session.did,
        collection: "dev.fly.bffbasic.profile",
        rkey: "self",
      },
    );

    if (!existingProfileResponse?.data?.cid) {
      return;
    }

    bffBasicProfileRecord = existingProfileResponse.data.value as ProfileRecord;

    // We have to index the profile record here becuase the appview might not know about it yet
    ctx.indexService.insertRecord({
      uri: `at://${session.did}/dev.fly.bffbasic.profile/self`,
      cid: existingProfileResponse.data.cid,
      did: session.did,
      collection: "dev.fly.bffbasic.profile",
      json: stringifyLex(bffBasicProfileRecord),
      indexedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching BFF Basic Profile:", error);
  }

  if (bffBasicProfileRecord) {
    console.log("Profile already exists");
    return `/profile/${session.handle}`;
  }

  try {
    bskyProfileRecord = await ctx.agent?.com.atproto.repo.getRecord({
      repo: session.did,
      collection: "app.bsky.actor.profile",
      rkey: "self",
    }).then((res) => res.data.value as BskyProfileRecord);
  } catch (error) {
    console.error("Error fetching Bsky Profile:", error);
  }

  if (!bskyProfileRecord) {
    console.error("Failed to get profile");
    return;
  }

  await ctx.createRecord<ProfileRecord>(
    "dev.fly.bffbasic.profile",
    {
      displayName: bskyProfileRecord.displayName ?? undefined,
      description: bskyProfileRecord.description ?? undefined,
      avatar: bskyProfileRecord.avatar ?? undefined,
      createdAt: new Date().toISOString(),
    },
    true,
  );

  return "/onboard";
}

export function getActorProfile(handle: string, ctx: BffContext) {
  const actor = ctx.indexService.getActorByHandle(handle);

  if (!actor) {
    console.error("Failed to get actor");
    return null;
  }

  const profileRecord = ctx.indexService.getRecord<WithBffMeta<ProfileRecord>>(
    `at://${actor.did}/dev.fly.bffbasic.profile/self`,
  );

  return profileRecord ? profileToView(profileRecord, actor.handle) : null;
}

export function profileStateResolver(_req: Request, ctx: BffContext) {
  if (ctx.currentUser) {
    const profile = getActorProfile(ctx.currentUser.handle, ctx);
    if (profile) {
      ctx.state.profile = profile;
      return ctx.next();
    }
  }
  return ctx.next();
}

export function profileToView(
  record: WithBffMeta<ProfileRecord>,
  handle: string,
): Un$Typed<ProfileView> {
  const avatar = record?.avatar
    ? `https://cdn.bsky.app/img/feed_thumbnail/plain/${record.did}/${record.avatar.ref.toString()}`
    : undefined;

  return {
    did: record.did,
    handle,
    displayName: record.displayName,
    description: record.description,
    avatar,
    createdAt: record.createdAt,
  };
}
