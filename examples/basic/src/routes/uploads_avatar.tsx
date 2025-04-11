import { RouteHandler } from "@bigmoves/bff";
import { Buffer } from "node:buffer";
import { blobCache } from "../main.tsx";

export const handler: RouteHandler = async (req, _params, ctx) => {
  const formData = await req.formData();
  const file = formData.get("file") as File;

  if (!ctx.agent) {
    return new Response("Agent not initialized", { status: 500 });
  }

  if (!file) {
    return new Response("No file provided", { status: 400 });
  }

  const blobResponse = await ctx.agent.uploadBlob(file);

  if (!blobResponse) {
    return new Response("Failed to upload blob", { status: 500 });
  }

  const cid = blobResponse.data.blob.ref.toString();

  blobCache.set(cid, blobResponse.data.blob);

  const buffer = Buffer.from(await file.arrayBuffer()); // Convert Blob to Uint8Array
  const base64 = btoa(
    new Uint8Array(buffer).reduce(function (data, byte) {
      return data + String.fromCharCode(byte);
    }, ""),
  ); // Encode as base64

  const src = `data:${blobResponse.data.blob.mimeType};base64,${base64}`;

  return ctx.html(
    <>
      <div hx-swap-oob="innerHTML:#image-input">
        <input
          type="hidden"
          name="avatarCid"
          value={cid}
        />
      </div>
      <img
        src={src}
        alt=""
        class="rounded-full w-full h-full object-cover"
      />
    </>,
  );
};
