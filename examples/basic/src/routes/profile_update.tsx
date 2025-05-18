import { Record as BffBasicProfile } from "$lexicon/types/dev/fly/bffbasic/profile.ts";
import { BffContext, RouteHandler } from "@bigmoves/bff";
import { photoProcessor } from "../uploads.tsx";

export const handler: RouteHandler = async (
  req,
  _params,
  ctx: BffContext,
) => {
  const formData = await req.formData();
  const displayName = formData.get("displayName") as string;
  const description = formData.get("description") as string;
  const uploadId = formData.get("uploadId") as string;

  if (!ctx.currentUser) {
    return new Response("User not signed in", { status: 401 });
  }

  if (!ctx.agent) {
    return new Response("Agent not initialized", { status: 500 });
  }

  const record = ctx.indexService.getRecord<BffBasicProfile>(
    `at://${ctx.currentUser.did}/dev.fly.bffbasic.profile/self`,
  );

  if (!record) {
    return new Response("Profile record not found", { status: 404 });
  }

  await ctx.updateRecord<BffBasicProfile>(
    "dev.fly.bffbasic.profile",
    "self",
    {
      displayName,
      description,
      avatar: photoProcessor.getUploadStatus(uploadId)?.blobRef ??
        record.avatar,
    },
  );

  return new Response(null, {
    status: 303,
    headers: {
      "HX-Redirect": `/profile/${ctx.currentUser.handle}`,
    },
  });
};
