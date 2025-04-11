import { ProfileView } from "$lexicon/types/dev/fly/bffbasic/defs.ts";

type Props = Readonly<{
  profile: ProfileView;
}>;

export function AvatarModal({ profile }: Props) {
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
      <div class="w-[400px] h-[400px] flex flex-col p-4 z-10">
        <img
          src={profile.avatar}
          alt={profile.handle}
          class="rounded-full w-full h-full object-cover"
        />
      </div>
    </div>
  );
}
