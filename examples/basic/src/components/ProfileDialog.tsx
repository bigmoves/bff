import { ProfileView } from "$lexicon/types/dev/fly/bffbasic/defs.ts";
import { Record as BffBasicProfile } from "$lexicon/types/dev/fly/bffbasic/profile.ts";
import { Button, Dialog, Input, Textarea } from "@bigmoves/bff/components";
import { AvatarForm } from "./AvatarForm.tsx";

type Props = Readonly<{
  profile: ProfileView;
  profileRecord: BffBasicProfile;
}>;

export function ProfileDialog(
  { profile, profileRecord }: Props,
) {
  return (
    <Dialog>
      <Dialog.Content class="relative">
        <Dialog.X class="fill-zinc-950" />
        <Dialog.Title>Edit my profile</Dialog.Title>
        <div>
          <AvatarForm
            src={profile.avatar}
            alt={profile.handle}
          />
        </div>
        <form
          hx-post="/profile"
          hx-swap="none"
          _="on htmx:afterOnLoad trigger closeDialog"
        >
          <div id="image-input">
            <input
              type="hidden"
              name="avatarCid"
              value={profileRecord.avatar
                ? profileRecord.avatar.ref.toString()
                : undefined}
            />
          </div>
          <div class="mb-4 relative">
            <label htmlFor="displayName">Display Name</label>
            <Input
              type="text"
              id="displayName"
              name="displayName"
              class="input"
              value={profile.displayName}
            />
          </div>
          <div class="mb-4 relative">
            <label htmlFor="description">Description</label>
            <Textarea
              id="description"
              name="description"
              rows={4}
              class="input"
            >
              {profile.description}
            </Textarea>
          </div>
          <Button
            type="submit"
            class="btn btn-primary w-full mb-2"
            variant="primary"
          >
            Update
          </Button>
          <Dialog.Close class="w-full">
            Cancel
          </Dialog.Close>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
