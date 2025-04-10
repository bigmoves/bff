import { BlobRef, stringifyLex } from "@atproto/lexicon";
import {
  AtprotoSession,
  bff,
  BffContext,
  BffMiddleware,
  CSS,
  oauth,
  RootProps,
  WithBffMeta,
} from "@bigmoves/bff";
import { Login } from "@bigmoves/bff/components";
import { TtlCache } from "@std/cache";
import { Buffer } from "node:buffer";
import { Record as BskyProfileRecord } from "./__generated__/types/app/bsky/actor/profile.ts";
import { ProfileView } from "./__generated__/types/dev/fly/bffbasic/defs.ts";
import { Record as ProfileRecord } from "./__generated__/types/dev/fly/bffbasic/profile.ts";
import { Un$Typed } from "./__generated__/util.ts";

type BffBasicProfile = WithBffMeta<ProfileRecord>;

type State = {
  profile?: ProfileView;
};

const blobCache = new TtlCache<string, BlobRef>(1000 * 60 * 60);

bff({
  appName: "AT Protocol App",
  collections: ["dev.fly.bffbasic.profile"],
  rootElement: Root,
  onSignedIn,
  middlewares: [
    profileResolver(),
    oauth({
      LoginComponent: ({ error }) => (
        <div id="login" class="flex justify-center items-center w-full h-full">
          <Login hx-target="body" error={error} />
        </div>
      ),
    }),
    async (req, ctx: BffContext<State>) => {
      const { pathname } = new URL(req.url);
      const profilePattern = new URLPattern({ pathname: "/profile/:handle" });
      const profileMatch = profilePattern.exec(req.url);
      const avatarModalPattern = new URLPattern({
        pathname: "/modals/avatar/:handle",
      });
      const avatarModalMatch = avatarModalPattern.exec(req.url);

      if (pathname === "/") {
        return ctx.render(
          <HomePage
            isLoggedIn={!!ctx.currentUser}
            profile={ctx.state.profile}
          />,
        );
      }

      if (profileMatch) {
        if (!profileMatch.pathname.groups.handle) return ctx.next();

        const profile = getActorProfile(
          profileMatch.pathname.groups.handle,
          ctx,
        );

        if (!profile) return ctx.next();

        return ctx.render(
          <ProfilePage
            isLoggedIn={!!ctx.currentUser}
            profile={profile}
          />,
        );
      }

      if (pathname === "/onboard") {
        return ctx.render(
          <div
            hx-get="/modals/profile"
            hx-trigger="load"
            hx-target="body"
            hx-swap="afterbegin"
          >
          </div>,
        );
      }

      if (pathname === "/modals/profile") {
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
      }

      if (avatarModalMatch) {
        if (!avatarModalMatch.pathname.groups.handle) return ctx.next();

        const profile = getActorProfile(
          avatarModalMatch.pathname.groups.handle,
          ctx,
        );

        if (!profile) return ctx.next();

        return ctx.html(
          <AvatarModal
            profile={profile}
          />,
        );
      }

      if (pathname === "/profile") {
        if (req.method !== "POST") {
          return ctx.next();
        }

        const formData = await req.formData();
        const displayName = formData.get("displayName") as string;
        const description = formData.get("description") as string;
        const avatarCid = formData.get("avatarCid") as string;

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
            avatar: blobCache.get(avatarCid) ?? record.avatar,
          },
        );

        return new Response(null, {
          status: 303,
          headers: {
            "HX-Redirect": `/profile/${ctx.currentUser.handle}`,
          },
        });
      }

      if (pathname === "/uploads/avatar") {
        if (req.method !== "POST") return ctx.next();

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
      }

      return ctx.next();
    },
  ],
});

async function onSignedIn(
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

    if (!existingProfileResponse?.data || !existingProfileResponse?.data?.cid) {
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

  await ctx.createRecord<BffBasicProfile>(
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

function getActorProfile(handle: string, ctx: BffContext) {
  const actor = ctx.indexService.getActorByHandle(handle);

  if (!actor) {
    console.error("Failed to get actor");
    return null;
  }

  const profileRecord = ctx.indexService.getRecord<BffBasicProfile>(
    `at://${actor.did}/dev.fly.bffbasic.profile/self`,
  );

  return profileRecord ? profileToView(profileRecord, actor.handle) : null;
}

function profileResolver(): BffMiddleware {
  return (_req, ctx) => {
    if (ctx.currentUser) {
      const profile = getActorProfile(ctx.currentUser.handle, ctx);
      if (profile) {
        ctx.state.profile = profile;
        return ctx.next();
      }
    }
    return ctx.next();
  };
}

export function profileToView(
  record: BffBasicProfile,
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

// function bskyProfileResolver(): BffMiddleware {
//   const cache = new TtlCache<string, ProfileViewDetailed>(1000 * 60 * 60);
//   return async (_req, ctx) => {
//     if (ctx.currentUser) {
//       if (cache.has(ctx.currentUser.did)) {
//         ctx.state.profile = cache.get(ctx.currentUser.did);
//         return ctx.next();
//       }

//       const response = await ctx.agent?.getProfile({
//         actor: ctx.currentUser.did,
//       });

//       if (!response) return ctx.next();

//       cache.set(ctx.currentUser.did, response.data);
//       ctx.state.profile = response.data;
//     }
//     return ctx.next();
//   };
// }

function Root(props: RootProps<State>) {
  return (
    <html lang="en" class="w-full h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://unpkg.com/htmx.org@1.9.10" />
        <script src="https://unpkg.com/hyperscript.org@0.9.14" />
        <link
          rel="stylesheet"
          href="https://unpkg.com/@fortawesome/fontawesome-free@6.7.2/css/all.min.css"
          preload
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <link rel="stylesheet" href="/static/styles.css" />
      </head>
      <body class="h-full max-w-5xl mx-auto sm:border-x relative">
        <Nav profile={props.ctx.state.profile} />
        <main id="main" class="h-[calc(100vh-56px)] sm:overflow-y-auto px-4">
          {props.children}
        </main>
      </body>
    </html>
  );
}

function Nav({ profile }: { profile?: ProfileView }) {
  return (
    <nav className="w-full border-b border-slate-950 flex justify-between items-center px-4 h-14">
      <div className="flex items-center space-x-4">
        <a hx-boost="true" href="/">
          <h1 className="text-2xl font-semibold">
            <span className="text-sky-600">@</span> bff
          </h1>
        </a>
      </div>
      <div className="space-x-2">
        {profile
          ? (
            <div className="flex items-center space-x-2">
              <form hx-post="/logout" hx-swap="none" className="inline">
                <button type="submit" className="btn btn-link">Sign out</button>
              </form>
              <a href={`/profile/${profile.handle}`} hx-boost="true">
                <img
                  src={profile.avatar}
                  alt={profile.handle}
                  className="rounded-full h-8 w-8"
                />
              </a>
            </div>
          )
          : (
            <div className="flex items-center space-x-4">
              <form hx-post="/signup" hx-swap="none" className="inline">
                <button type="submit" className="btn btn-link">
                  Create account
                </button>
              </form>
              <a
                hx-boost="true"
                href="/login"
                className="btn btn-link"
              >
                Sign in
              </a>
            </div>
          )}
      </div>
    </nav>
  );
}

function ProfileModal(
  { profile, profileRecord }: Readonly<{
    profile: ProfileView;
    profileRecord: BffBasicProfile;
  }>,
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

function AvatarForm({ src, alt }: { src?: string; alt?: string }) {
  return (
    <form
      id="avatar-file-form"
      hx-post="/uploads/avatar"
      hx-target="#image-preview"
      hx-swap="innerHTML"
      hx-encoding="multipart/form-data"
      hx-trigger="change from:#file"
    >
      <label>
        <div class="border rounded-full border-slate-900 w-16 h-16 mx-auto mb-2 relative my-2 cursor-pointer">
          <div class="absolute bottom-0 right-0 bg-slate-800 rounded-full w-5 h-5 flex items-center justify-center">
            <i class="fa-solid fa-camera text-white text-xs"></i>
          </div>
          <div id="image-preview" class="w-full h-full">
            {src
              ? (
                <img
                  src={src}
                  alt={alt}
                  className="rounded-full w-full h-full object-cover"
                />
              )
              : null}
          </div>
        </div>
        <input
          class="input hidden"
          type="file"
          id="file"
          name="file"
          accept="image/*"
        />
      </label>
    </form>
  );
}

function ProfilePage(
  { isLoggedIn, profile }: { isLoggedIn: boolean; profile: ProfileView },
) {
  return (
    <div>
      <div class="flex flex-col sm:flex-row justify-between items-start my-8">
        <div class="flex flex-col">
          <button
            type="button"
            class="flex flex-row items-center gap-2 cursor-pointer border rounded-full w-fit"
            hx-get={`/modals/avatar/${profile.handle}`}
            hx-trigger="click"
            hx-target="body"
            hx-swap="afterbegin"
          >
            <img
              src={profile.avatar}
              alt={profile.handle}
              class="rounded-full object-cover size-16"
            />
          </button>
          <p class="text-2xl font-bold">
            {profile.displayName}
          </p>
          <p class="text-gray-600">@{profile.handle}</p>
          <p class="my-2">{profile.description}</p>
        </div>
        {isLoggedIn
          ? (
            <div class="w-full sm:w-fit flex flex-col sm:flex-row gap-2 pt-2 sm:pt-0">
              <button
                type="button"
                hx-get="/modals/profile"
                hx-trigger="click"
                hx-target="body"
                hx-swap="afterbegin"
                class="btn btn-primary w-full sm:w-fit"
              >
                Edit profile
              </button>
            </div>
          )
          : null}
      </div>
      <div className="my-4">
        <h2 className="text-xl font-semibold mb-4">Recent Activity</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((item) => (
            <div
              key={item}
              className="border border-gray-200 rounded-lg p-4"
            >
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-4"></div>
              <div className="h-2 bg-gray-200 rounded w-full mb-2"></div>
              <div className="h-2 bg-gray-200 rounded w-5/6 mb-2"></div>
              <div className="h-2 bg-gray-200 rounded w-3/4"></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AvatarModal({ profile }: { profile: ProfileView }) {
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

function HomePage(
  { isLoggedIn, profile }: { isLoggedIn: boolean; profile?: ProfileView },
) {
  return (
    <div class="w-full h-full flex flex-col items-center justify-center">
      <form id="signup" hx-post="/signup" hx-swap="none" />
      <h1 class="text-2xl font-bold">Welcome to the Basic BFF Example</h1>
      <p class="text-gray-600">
        You can{" "}
        <button
          form="signup"
          type="submit"
          class="text-sky-600 hover:underline cursor-pointer"
        >
          create an account
        </button>
        {", "}
        <a href="/login" hx-boost="true" class="text-sky-600 hover:underline">
          sign in
        </a>
        {", and "}
        {isLoggedIn
          ? (
            <a
              href={`/profile/${profile?.handle}`}
              hx-boost="true"
              class="text-sky-600 hover:underline"
            >
              edit your profile
            </a>
          )
          : (
            <a
              href="/login"
              hx-boost="true"
              class="text-sky-600 hover:underline"
            >
              edit your profile
            </a>
          )}.
      </p>
    </div>
  );
}
