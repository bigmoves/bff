import { ProfileView } from "$lexicon/types/dev/fly/bffbasic/defs.ts";
import { Record as BffBasicProfile } from "$lexicon/types/dev/fly/bffbasic/profile.ts";
import { AvatarForm } from "./AvatarForm.tsx";

type Props = Readonly<{
  profile: ProfileView;
  profileRecord: BffBasicProfile;
}>;

export function ProfileModal(
  { profile, profileRecord }: Props,
) {
  return (
    <div
      id="modal"
      _="on closeModal remove me"
      class="fixed top-0 bottom-0 right-0 left-0 flex items-center justify-center"
    >
      <div
        _="on click trigger closeModal"
        class="absolute top-0 left-0 right-0 bottom-0 bg-black/80"
      >
      </div>
      <div class="w-[400px] bg-white flex flex-col p-4 z-10">
        <h1 class="text-lg font-semibold text-center w-full mb-2">
          Edit my profile
        </h1>
        <div>
          <AvatarForm
            src={profile.avatar}
            alt={profile.handle}
          />
        </div>
        <form
          hx-post="/profile"
          hx-swap="none"
          _="on htmx:afterOnLoad[successful] trigger closeModal"
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
            <label htmlFor="displayName" class="label">Display Name</label>
            <input
              type="text"
              id="displayName"
              name="displayName"
              class="input"
              value={profile.displayName}
            />
          </div>
          <div class="mb-4 relative">
            <label htmlFor="description" class="label">Description</label>
            <textarea
              id="description"
              name="description"
              rows={4}
              class="input"
            >
              {profile.description}
            </textarea>
          </div>
          <button
            type="submit"
            class="btn btn-primary w-full mb-2"
          >
            Update
          </button>
          <button
            type="button"
            class="btn btn-secondary w-full"
            _="on click trigger closeModal"
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
}
