import {
  GalleryView,
  Image,
  ViewImage,
} from "$lexicon/types/app/bigmoves/defs.ts";
import { Record as Gallery } from "$lexicon/types/app/bigmoves/gallery.ts";
import { ProfileViewBasic } from "$lexicon/types/app/bsky/actor/defs.ts";
import { Record as BskyProfile } from "$lexicon/types/app/bsky/actor/profile.ts";
import { Un$Typed } from "$lexicon/util.ts";
import { AtUri } from "@atproto/syntax";
import {
  backfillCollections,
  bff,
  BffContext,
  BlobMeta,
  CSS,
  JETSTREAM,
  oauth,
  onListenArgs,
  onSignedInArgs,
  RootProps,
  route,
  uploadHandler,
  WithBffMeta,
} from "@bigmoves/bff";
import {
  Button,
  Input,
  Layout,
  Login,
  Textarea,
} from "@bigmoves/bff/components";
import { formatDistanceStrict } from "date-fns";

bff({
  appName: "AT Protocol Image Gallery",
  collections: ["app.bigmoves.gallery"],
  jetstreamUrl: JETSTREAM.WEST_1,
  // databaseUrl: "gallery.db",
  onListen: async ({ indexService }: onListenArgs) => {
    await backfillCollections(indexService)(
      ["did:plc:bcgltzqazw5tb6k2g3ttenbj"],
      ["app.bsky.actor.profile", "app.bigmoves.gallery"],
    );
  },
  rootElement: Root,
  middlewares: [
    oauth({
      onSignedIn: async ({ actor, ctx }: onSignedInArgs) => {
        await ctx.backfillCollections(
          [actor.did],
          ["app.bsky.actor.profile", "app.bigmoves.gallery"],
        );
        return "/";
      },
      LoginComponent: ({ error }) => (
        <div id="login" class="flex justify-center items-center w-full h-full">
          <Login hx-target="#login" error={error} />
        </div>
      ),
    }),
    (_req, ctx) => {
      if (ctx.currentUser) {
        const profile = getActorProfile(ctx.currentUser.did, ctx);
        if (profile) {
          ctx.state.profile = profile;
          return ctx.next();
        }
      }
      return ctx.next();
    },
    route("/", (_req, _params, ctx) => {
      const galleries = getTimeline(ctx);
      return ctx.render(<Timeline galleries={galleries} />);
    }),
    route("/profile/:handle", (_req, params, ctx) => {
      const handle = params.handle;
      const galleries = getActorGalleries(handle, ctx);
      if (!galleries) return ctx.next();
      const actor = ctx.indexService.getActorByHandle(handle);
      if (!actor) return ctx.next();
      const profile = getActorProfile(actor.did, ctx);
      if (!profile) return ctx.next();
      return ctx.render(
        <ProfilePage
          galleries={galleries}
          isLoggedIn={!!ctx.currentUser}
          profile={profile}
        />,
      );
    }),
    route("/profile/:handle/:rkey", (_req, params, ctx) => {
      const handle = params.handle;
      const rkey = params.rkey;
      const gallery = getGallery(handle, rkey, ctx);
      if (!gallery) return ctx.next();
      return ctx.render(
        <GalleryPage
          gallery={gallery}
          isLoggedIn={!!ctx.currentUser}
          isCreator={ctx.currentUser?.did === gallery.creator.did}
        />,
      );
    }),
    route("/modals/image", (req, _params, ctx) => {
      const url = new URL(req.url);
      const galleryUri = url.searchParams.get("galleryUri");
      const imageCid = url.searchParams.get("imageCid");
      if (!galleryUri || !imageCid) return ctx.next();
      const atUri = new AtUri(galleryUri);
      const galleryDid = atUri.hostname;
      const galleryRkey = atUri.rkey;
      const gallery = getGallery(galleryDid, galleryRkey, ctx);
      const image = gallery?.images?.find((image) => {
        return image.cid === imageCid;
      });
      if (!image) return ctx.next();
      return ctx.html(<ImageModal image={image} />);
    }),
    route("/modals/gallery", (req, _params, ctx) => {
      const url = new URL(req.url);
      const searchParams = new URLSearchParams(url.search);
      const uri = searchParams.get("uri");
      if (!uri) return ctx.html(<GalleryModal />);
      const atUri = new AtUri(uri);
      const did = atUri.hostname;
      const rkey = atUri.rkey;
      const gallery = getGallery(did, rkey, ctx);
      return ctx.html(<GalleryModal gallery={gallery} />);
    }),
    route("/modals/image-alt", (req, _params, ctx) => {
      const url = new URL(req.url);
      const galleryUri = url.searchParams.get("galleryUri");
      const imageCid = url.searchParams.get("imageCid");
      if (!galleryUri || !imageCid) return ctx.next();
      const atUri = new AtUri(galleryUri);
      const galleryDid = atUri.hostname;
      const galleryRkey = atUri.rkey;
      const gallery = getGallery(galleryDid, galleryRkey, ctx);
      const image = gallery?.images?.find((image) => {
        return image.cid === imageCid;
      });
      if (!image || !gallery) return ctx.next();
      return ctx.html(<ImageAltModal galleryUri={gallery.uri} image={image} />);
    }),
    route(
      "/actions/upload",
      ["POST"],
      uploadHandler((blobMetas) => <UploadOob blobMetas={blobMetas} />, {
        compress: true,
      }),
    ),
    route("/actions/create-edit", ["POST"], async (req, _params, ctx) => {
      if (!ctx.currentUser) {
        return new Response("Unauthorized", { status: 401 });
      }
      const formData = await req.formData();
      const title = formData.get("title") as string;
      const description = formData.get("description") as string;
      const cids = formData.getAll("cids") as string[];
      let images: Image[] = [];
      const url = new URL(req.url);
      const searchParams = new URLSearchParams(url.search);
      const uri = searchParams.get("uri");
      const handle = ctx.currentUser?.handle;

      for (const cid of cids) {
        const blobMeta = ctx.blobMetaCache.get(cid);
        if (!blobMeta) {
          continue;
        }
        images.push({
          image: blobMeta.blobRef,
          alt: "",
          aspectRatio: blobMeta.dimensions?.width && blobMeta.dimensions?.height
            ? {
              width: blobMeta.dimensions.width,
              height: blobMeta.dimensions.height,
            }
            : undefined,
        });
      }

      if (uri) {
        const gallery = ctx.indexService.getRecord<WithBffMeta<Gallery>>(uri);
        if (!gallery) return ctx.next();
        images = mergeUniqueImages(gallery.images, images, cids);
        const rkey = new AtUri(uri).rkey;
        await ctx.updateRecord<Gallery>("app.bigmoves.gallery", rkey, {
          title,
          description,
          images,
          createdAt: gallery.createdAt,
        });
        return ctx.redirect(`/profile/${handle}/${rkey}`);
      }

      const createdUri = await ctx.createRecord<Gallery>(
        "app.bigmoves.gallery",
        {
          title,
          description,
          images,
          createdAt: new Date().toISOString(),
        },
      );
      return ctx.redirect(`/profile/${handle}/${new AtUri(createdUri).rkey}`);
    }),
    route("/actions/delete", ["POST"], async (req, _params, ctx) => {
      if (!ctx.currentUser) {
        return new Response("Unauthorized", { status: 401 });
      }
      const formData = await req.formData();
      const uri = formData.get("uri") as string;
      await ctx.deleteRecord(uri);
      return ctx.redirect("/");
    }),
    route("/actions/image-alt", ["POST"], async (req, _params, ctx) => {
      if (!ctx.currentUser) {
        return new Response("Unauthorized", { status: 401 });
      }
      const formData = await req.formData();
      const alt = formData.get("alt") as string;
      const cid = formData.get("cid") as string;
      const galleryUri = formData.get("galleryUri") as string;
      const gallery = ctx.indexService.getRecord<WithBffMeta<Gallery>>(
        galleryUri,
      );
      if (!gallery) return ctx.next();
      const images = gallery?.images?.map((image) => {
        if (image.image.ref.toString() === cid) {
          return {
            ...image,
            alt,
          };
        }
        return image;
      });
      const rkey = new AtUri(galleryUri).rkey;
      await ctx.updateRecord<Gallery>("app.bigmoves.gallery", rkey, {
        title: gallery.title,
        description: gallery.description,
        images,
        createdAt: gallery.createdAt,
      });
      return new Response(null, { status: 200 });
    }),
  ],
});

export type State = {
  profile?: ProfileViewBasic;
};

function getTimeline(ctx: BffContext): GalleryView[] {
  const galleryViews: Un$Typed<GalleryView>[] = [];
  const galleries = ctx.indexService.getRecords<WithBffMeta<Gallery>>(
    "app.bigmoves.gallery",
    { orderBy: { field: "createdAt", direction: "desc" } },
  );
  for (const gallery of galleries) {
    const actor = ctx.indexService.getActor(gallery.did);
    if (!actor) continue;
    const profile = getActorProfile(actor.did, ctx);
    if (!profile) continue;
    galleryViews.push(galleryToView(gallery, profile));
  }
  return galleryViews;
}

function getActorGalleries(handleOrDid: string, ctx: BffContext) {
  let did: string;
  if (handleOrDid.includes("did:")) {
    did = handleOrDid;
  } else {
    const actor = ctx.indexService.getActorByHandle(handleOrDid);
    if (!actor) return null;
    did = actor.did;
  }
  const galleries = ctx.indexService.getRecords<WithBffMeta<Gallery>>(
    "app.bigmoves.gallery",
    {
      orderBy: { field: "createdAt", direction: "desc" },
      where: [
        {
          field: "did",
          equals: did,
        },
      ],
    },
  );
  if (!galleries) return null;
  const profile = getActorProfile(did, ctx);
  if (!profile) return null;
  return galleries.map((g) => galleryToView(g, profile));
}

function getGallery(handleOrDid: string, rkey: string, ctx: BffContext) {
  let did: string;
  if (handleOrDid.includes("did:")) {
    did = handleOrDid;
  } else {
    const actor = ctx.indexService.getActorByHandle(handleOrDid);
    if (!actor) return null;
    did = actor.did;
  }
  const gallery = ctx.indexService.getRecord<WithBffMeta<Gallery>>(
    `at://${did}/app.bigmoves.gallery/${rkey}`,
  );
  if (!gallery) return null;
  const profile = getActorProfile(did, ctx);
  if (!profile) return null;
  return galleryToView(gallery, profile);
}

function Root(props: Readonly<RootProps<State>>) {
  const profile = props.ctx.state.profile;
  return (
    <html lang="en" class="w-full h-full">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <script src="https://unpkg.com/htmx.org@1.9.10" />
        <script src="https://unpkg.com/hyperscript.org@0.9.14" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <link rel="stylesheet" href="/static/styles.css" />
        <link
          rel="stylesheet"
          href="https://unpkg.com/@fortawesome/fontawesome-free@6.7.2/css/all.min.css"
          preload
        />
      </head>
      <body class="h-full w-full">
        <Layout id="layout">
          <Layout.Nav
            title={
              <>
                <span className="text-sky-600">@</span> photo
              </>
            }
            profile={profile}
          />
          <Layout.Content>{props.children}</Layout.Content>
        </Layout>
      </body>
    </html>
  );
}

function Timeline({
  galleries,
}: Readonly<{ galleries: Un$Typed<GalleryView>[] }>) {
  return (
    <div class="px-4">
      <div class="my-4">
        <h1 class="text-xl font-semibold">Timeline</h1>
      </div>
      <ul class="space-y-4">
        {galleries.map((gallery) => (
          <li key={gallery.uri} class="space-y-1.5">
            <div>
              <a
                href={profileLink(gallery)}
                class="font-semibold hover:underline"
              >
                @{gallery.creator.handle}
              </a>{" "}
              created{" "}
              <a href={galleryLink(gallery)} class="font-semibold">
                {(gallery.record as Gallery).title}
              </a>
              <span class="ml-1">
                {formatDistanceStrict(
                  (gallery.record as Gallery).createdAt,
                  new Date(),
                  {
                    addSuffix: true,
                  },
                )}
              </span>
            </div>
            <a
              href={`/profile/${gallery.creator.handle}/${
                new AtUri(gallery.uri).rkey
              }`}
              class="flex flex-wrap gap-2"
            >
              {gallery.images?.length
                ? gallery?.images?.map((image) => (
                  <img
                    src={image.thumb}
                    alt={image.alt}
                    class="min-w-[50px] max-w-[50px] h-[50px] object-cover"
                  />
                ))
                : null}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProfilePage({
  galleries,
  isLoggedIn,
  profile,
}: Readonly<{
  galleries: Un$Typed<GalleryView>[];
  isLoggedIn: boolean;
  profile: Un$Typed<ProfileViewBasic>;
}>) {
  return (
    <div class="px-4">
      <div class="flex items-center justify-between my-4">
        <div class="flex flex-col">
          <img
            src={profile.avatar}
            alt={profile.handle}
            class="rounded-full object-cover size-16"
          />
          <p class="text-2xl font-bold">{profile.displayName}</p>
          <p class="text-gray-600">@{profile.handle}</p>
        </div>
        {isLoggedIn
          ? (
            <Button
              variant="primary"
              hx-get="/modals/gallery"
              hx-trigger="click"
              hx-target="#layout"
              hx-swap="afterbegin"
              class="self-start"
            >
              Create Gallery
            </Button>
          )
          : null}
      </div>
      <h1 class="text-xl font-semibold my-4">Activity</h1>
      <ul class="space-y-4">
        {galleries.map((gallery) => (
          <li key={gallery.uri} class="space-y-1.5">
            <div>
              Created{" "}
              <a href={galleryLink(gallery)} class="font-semibold">
                {(gallery.record as Gallery).title}
              </a>
              <span class="ml-1">
                {formatDistanceStrict(
                  (gallery.record as Gallery).createdAt,
                  new Date(),
                  {
                    addSuffix: true,
                  },
                )}
              </span>
            </div>
            <a
              href={`/profile/${gallery.creator.handle}/${
                new AtUri(gallery.uri).rkey
              }`}
              class="flex flex-wrap gap-2"
            >
              {gallery.images?.length
                ? gallery?.images?.map((image) => (
                  <img
                    src={image.fullsize}
                    alt={image.alt}
                    class="min-w-[50px] max-w-[50px] h-[50px] object-cover"
                  />
                ))
                : null}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GalleryPage({
  gallery,
  isLoggedIn,
  isCreator,
}: Readonly<{
  gallery: GalleryView;
  isLoggedIn: boolean;
  isCreator: boolean;
}>) {
  return (
    <div class="px-4">
      <div class="flex items-center justify-between my-4">
        <div>
          <div>
            <h1 class="font-medium text-2xl">
              {(gallery.record as Gallery).title}
            </h1>
            <a
              href={profileLink(gallery)}
              class="text-gray-600 hover:underline"
            >
              @{gallery.creator.handle}
            </a>
          </div>
          {(gallery.record as Gallery).description}
        </div>
        {isLoggedIn
          ? (
            <Button
              variant="primary"
              class="self-start"
              type="button"
              hx-get={`/modals/gallery?uri=${gallery.uri}`}
              hx-trigger="click"
              hx-target="#layout"
              hx-swap="afterbegin"
            >
              Edit
            </Button>
          )
          : null}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        {gallery.images?.length
          ? gallery?.images?.map((image) => (
            <button
              key={image.fullsize}
              type="button"
              hx-get={`/modals/image?galleryUri=${gallery.uri}&imageCid=${image.cid}`}
              hx-trigger="click"
              hx-target="#layout"
              hx-swap="afterbegin"
              class="cursor-pointer relative"
            >
              {isLoggedIn && isCreator
                ? <AltTextButton galleryUri={gallery.uri} cid={image.cid} />
                : null}
              <img
                src={image.fullsize}
                alt={image.alt}
                class="w-full h-auto object-cover"
              />
            </button>
          ))
          : null}
      </div>
    </div>
  );
}

function GalleryModal({ gallery }: Readonly<{ gallery?: GalleryView | null }>) {
  return (
    <div
      id="gallery-modal"
      _="on closeModal remove me"
      class="fixed top-0 bottom-0 right-0 left-0 flex items-center justify-center z-10"
    >
      <div
        _="on click trigger closeModal"
        class="absolute top-0 left-0 right-0 bottom-0 bg-black/80"
      >
      </div>
      <div class="w-[400px] bg-white flex flex-col p-4 max-h-screen overflow-y-auto z-20">
        <h1 class="text-lg font-semibold text-center w-full mb-2">
          {gallery ? "Edit gallery" : "Create gallery"}
        </h1>

        <form
          id="gallery-form"
          hx-post={`/actions/create-edit${
            gallery ? `?uri=${gallery?.uri}` : ""
          }`}
          hx-swap="none"
        >
          <div id="image-cids">
            {(gallery?.record as Gallery).images?.map((image) => (
              <Input
                type="hidden"
                name="cids"
                value={image.image.ref.toString()}
              />
            ))}
          </div>
          <div class="mb-4 relative">
            <label htmlFor="title">Display Name</label>
            <Input
              type="text"
              id="title"
              name="title"
              class="input"
              value={(gallery?.record as Gallery)?.title}
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
              {(gallery?.record as Gallery)?.description}
            </Textarea>
          </div>
        </form>
        <form
          id="upload-form"
          hx-post="/actions/upload"
          hx-target="#image-preview"
          hx-swap="beforeend"
          hx-encoding="multipart/form-data"
          hx-trigger="change from:#files"
          hx-indicator="#form-indicator"
          {...{
            ["hx-on::after-request"]:
              "this.reset(); document.getElementById('files').value = '';",
          }}
        >
          <input
            type="button"
            name="galleryUri"
            value={gallery?.uri}
            class="hidden"
          />
          <Button variant="secondary" class="mb-2" asChild>
            <label class="w-full">
              Upload images
              <Input
                class="hidden"
                type="file"
                id="files"
                name="files"
                multiple
                accept="image/*"
              />
            </label>
          </Button>
          <div id="form-indicator" class="htmx-indicator">
            Uploading... Please wait
          </div>
          <div id="image-preview" class="w-full h-full grid grid-cols-2 gap-2">
            {gallery?.images?.map((image) => (
              <ImagePreview key={image.cid} src={image.thumb} cid={image.cid} />
            ))}
          </div>
        </form>
        <form id="delete-form" hx-post={`/actions/delete?uri=${gallery?.uri}`}>
          <input type="hidden" name="uri" value={gallery?.uri} />
        </form>
        <div class="w-full flex flex-col gap-2 mt-2">
          {gallery
            ? (
              <Button variant="destructive" form="delete-form" type="submit">
                Delete
              </Button>
            )
            : null}
          <Button
            variant="primary"
            form="gallery-form"
            type="submit"
            id="submit-button"
          >
            Submit
          </Button>
          <Button variant="secondary" _="on click trigger closeModal">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImagePreview({ src, cid }: Readonly<{ src: string; cid: string }>) {
  return (
    <div class="relative">
      <button
        type="button"
        class="bg-black/80 z-10 absolute top-2 right-2 cursor-pointer size-4 flex items-center justify-center"
        _={`on click
          set input to <input[value='${cid}']/>
          if input exists
            remove input
          end
          remove me.parentNode 
          halt
        `}
      >
        <i class="fas fa-close text-white"></i>
      </button>
      <img
        key={cid}
        src={src}
        alt=""
        class="w-full h-full object-cover aspect-square"
      />
    </div>
  );
}

function AltTextButton({
  galleryUri,
  cid,
}: Readonly<{ galleryUri: string; cid: string }>) {
  return (
    <div
      class="bg-black/80 py-[1px] px-[3px] absolute top-2 left-2 cursor-pointer flex items-center justify-center text-xs text-white font-semibold"
      hx-get={`/modals/image-alt?galleryUri=${galleryUri}&imageCid=${cid}`}
      hx-trigger="click"
      hx-target="#layout"
      hx-swap="afterbegin"
      _="on click halt"
    >
      <i class="fas fa-plus text-[10px] mr-1"></i> ALT
    </div>
  );
}

function ImageModal({
  image,
}: Readonly<{
  image: ViewImage;
}>) {
  return (
    <div
      id="image-modal"
      _="on closeModal remove me"
      class="fixed top-0 bottom-0 right-0 left-0 flex items-center justify-center z-10"
    >
      <div
        _="on click trigger closeModal"
        class="absolute top-0 left-0 right-0 bottom-0 bg-black/80"
      >
      </div>
      <div class="flex flex-col max-w-5xl p-4 z-20">
        <img src={image.fullsize} alt={image.alt} class="w-full max-h-screen" />
      </div>
    </div>
  );
}

function ImageAltModal({
  image,
  galleryUri,
}: Readonly<{
  image: ViewImage;
  galleryUri: string;
}>) {
  return (
    <div
      id="image-alt-modal"
      _="on closeModal remove me"
      class="fixed top-0 bottom-0 right-0 left-0 flex items-center justify-center z-10"
    >
      <div
        _="on click trigger closeModal"
        class="absolute top-0 left-0 right-0 bottom-0 bg-black/80"
      >
      </div>
      <div class="w-[400px] bg-white flex flex-col p-4 z-20 max-h-screen overflow-y-auto">
        <h1 class="text-lg font-semibold text-center w-full mb-2">
          Add alt text
        </h1>
        <div class="aspect-square relative bg-gray-100">
          <img
            src={image.fullsize}
            alt={image.alt}
            class="absolute inset-0 w-full h-full object-contain"
          />
        </div>
        <form
          hx-post="/actions/image-alt"
          _="on htmx:afterOnLoad[successful] trigger closeModal"
        >
          <input type="hidden" name="galleryUri" value={galleryUri} />
          <input type="hidden" name="cid" value={image.cid} />
          <div class="my-2">
            <label htmlFor="alt">Descriptive alt text</label>
            <Textarea
              id="alt"
              name="alt"
              rows={4}
              defaultValue={image.alt}
              placeholder="Alt text"
            />
          </div>
          <Button type="submit" variant="primary" class="w-full">
            Save
          </Button>
        </form>
      </div>
    </div>
  );
}

function UploadOob({ blobMetas }: Readonly<{ blobMetas: BlobMeta[] }>) {
  return (
    <>
      {
        <div hx-swap-oob="beforeend:#image-cids">
          {blobMetas.map((b) => (
            <input
              key={b.blobRef.ref.toString()}
              type="hidden"
              name="cids"
              value={b.blobRef.ref.toString()}
            />
          ))}
        </div>
      }
      {blobMetas.map((b) => (
        <ImagePreview
          key={b.blobRef.ref.toString()}
          src={b.dataUrl}
          cid={b.blobRef.ref.toString()}
        />
      ))}
    </>
  );
}

function getActorProfile(did: string, ctx: BffContext) {
  const actor = ctx.indexService.getActor(did);
  if (!actor) return null;
  const profileRecord = ctx.indexService.getRecord<WithBffMeta<BskyProfile>>(
    `at://${did}/app.bsky.actor.profile/self`,
  );
  return profileRecord ? profileToView(profileRecord, actor.handle) : null;
}

function galleryToView(
  record: WithBffMeta<Gallery>,
  creator: Un$Typed<ProfileViewBasic>,
): Un$Typed<GalleryView> {
  return {
    uri: record.uri,
    cid: record.cid,
    creator,
    record,
    images: record?.images?.map((image) =>
      imageToView(new AtUri(record.uri).hostname, image)
    ),
    indexedAt: record.indexedAt,
  };
}

function imageToView(did: string, image: Image): Un$Typed<ViewImage> {
  return {
    cid: image.image.ref.toString(),
    thumb:
      `https://cdn.bsky.app/img/feed_thumbnail/plain/${did}/${image.image.ref.toString()}@webp`,
    fullsize:
      `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${image.image.ref.toString()}@webp`,
    alt: image.alt,
    aspectRatio: image.aspectRatio,
  };
}

function profileToView(
  record: WithBffMeta<BskyProfile>,
  handle: string,
): Un$Typed<ProfileViewBasic> {
  return {
    did: record.did,
    handle,
    displayName: record.displayName,
    avatar: record?.avatar
      ? `https://cdn.bsky.app/img/feed_thumbnail/plain/${record.did}/${record.avatar.ref.toString()}`
      : undefined,
  };
}

export function profileLink(gallery: GalleryView) {
  return `/profile/${gallery.creator.handle}`;
}

export function galleryLink(gallery: GalleryView) {
  return `/profile/${gallery.creator.handle}/${new AtUri(gallery.uri).rkey}`;
}

function mergeUniqueImages(
  existingImages: Image[] | undefined,
  newImages: Image[],
  validCids?: string[],
): Image[] {
  if (!existingImages || existingImages.length === 0) {
    return validCids
      ? newImages.filter((img) => validCids.includes(img.image.ref.toString()))
      : newImages;
  }
  const uniqueImagesMap = new Map<string, Image>();
  existingImages.forEach((img) => {
    const key = img.image.ref.toString();
    uniqueImagesMap.set(key, img);
  });
  newImages.forEach((img) => {
    const key = img.image.ref.toString();
    uniqueImagesMap.set(key, img);
  });
  const mergedImages = [...uniqueImagesMap.values()];
  return validCids
    ? mergedImages.filter((img) => validCids.includes(img.image.ref.toString()))
    : mergedImages;
}
