import type { BlobMeta } from "@bigmoves/bff";

export function AvatarOob({ blobRef, dataUrl }: Readonly<BlobMeta>) {
  return (
    <>
      <div hx-swap-oob="innerHTML:#image-input">
        <input
          type="hidden"
          name="avatarCid"
          value={blobRef?.ref.toString()}
        />
      </div>
      <img
        src={dataUrl}
        alt=""
        class="rounded-full w-full h-full object-cover"
      />
    </>
  );
}
