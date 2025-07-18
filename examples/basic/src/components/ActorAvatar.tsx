import { ProfileView } from "$lexicon/types/dev/fly/bffbasic/defs.ts";
import { Un$Typed } from "$lexicon/util.ts";
import { cn } from "@bigmoves/bff/components";
import { DefaultAvatar } from "./DefaultAvatar.tsx";

export function ActorAvatar({
  profile,
  size,
  class: classProp,
}: Readonly<
  { profile: Un$Typed<ProfileView>; size?: number; class?: string }
>) {
  return (
    profile.avatar
      ? (
        <img
          src={profile.avatar}
          alt={profile.handle}
          title={profile.handle}
          class={cn("rounded-full object-cover", classProp)}
          style={size ? { width: size, height: size } : undefined}
        />
      )
      : <DefaultAvatar size={size} class={classProp} />
  );
}
