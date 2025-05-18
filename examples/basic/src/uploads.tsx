import { BffMiddleware, route, RouteHandler } from "@bigmoves/bff";
import { BFFPhotoProcessor } from "@bigmoves/bff-photo-processor";
import { VNode } from "preact";

export const photoProcessor = new BFFPhotoProcessor();

function uploadStart(
  routePrefix: string,
  cb: (params: { uploadId: string; src: string; done?: boolean }) => VNode,
): RouteHandler {
  return async (req, _params, ctx) => {
    console.log("uploadStart");
    ctx.requireAuth();
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) {
      return new Response("No file", { status: 400 });
    }
    const dataUrl = await readFileAsDataURL(file);
    if (!ctx.agent) {
      return new Response("No agent", { status: 400 });
    }
    await photoProcessor.initialize(ctx.agent);
    const uploadId = photoProcessor.startUpload(file);
    return ctx.html(
      <div
        id={`upload-id-${uploadId}`}
        hx-trigger="done"
        hx-get={`/actions/${routePrefix}/upload-done/${uploadId}`}
        hx-target="this"
        hx-swap="outerHTML"
        class="h-full w-full"
      >
        <div
          hx-get={`/actions/${routePrefix}/upload-check-status/${uploadId}`}
          hx-trigger="every 600ms"
          hx-target="this"
          hx-swap="innerHTML"
          class="h-full w-full"
        >
          {cb({ uploadId, src: dataUrl })}
        </div>
      </div>,
    );
  };
}

function uploadCheckStatus(): RouteHandler {
  return (_req, params, ctx) => {
    ctx.requireAuth();
    const uploadId = params.uploadId;
    if (!uploadId) return ctx.next();
    const meta = photoProcessor.getUploadStatus(uploadId);
    return new Response(
      null,
      {
        status: meta?.blobRef ? 200 : 204,
        headers: meta?.blobRef ? { "HX-Trigger": "done" } : {},
      },
    );
  };
}

function avatarUploadDone(
  cb: (params: { src: string; uploadId: string }) => VNode,
): RouteHandler {
  return (_req, params, ctx) => {
    const { did } = ctx.requireAuth();
    const uploadId = params.uploadId;
    if (!uploadId) return ctx.next();
    const meta = photoProcessor.getUploadStatus(uploadId);
    if (!meta?.blobRef) return ctx.next();
    return ctx.html(
      cb({ src: photoThumb(did, meta.blobRef.ref.toString()), uploadId }),
    );
  };
}

export function avatarUploadRoutes(): BffMiddleware[] {
  return [
    route(
      `/actions/avatar/upload-start`,
      ["POST"],
      uploadStart("avatar", ({ src }) => (
        <img
          src={src}
          alt=""
          data-state="pending"
          class="rounded-full w-full h-full object-cover data-[state=pending]:opacity-50"
        />
      )),
    ),
    route(
      `/actions/avatar/upload-check-status/:uploadId`,
      ["GET"],
      uploadCheckStatus(),
    ),
    route(
      `/actions/avatar/upload-done/:uploadId`,
      ["GET"],
      avatarUploadDone(({ src, uploadId }) => (
        <>
          <div hx-swap-oob="innerHTML:#image-input">
            <input type="hidden" name="uploadId" value={uploadId} />
          </div>
          <img
            src={src}
            alt=""
            class="rounded-full w-full h-full object-cover"
          />
        </>
      )),
    ),
  ];
}

function photoThumb(did: string, cid: string) {
  return `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${cid}@jpeg`;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
}
