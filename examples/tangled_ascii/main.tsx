import { lexicons } from "$lexicon/lexicons.ts";
import { Record as Star } from "$lexicon/types/sh/tangled/feed/star.ts";
import { Record as Repo } from "$lexicon/types/sh/tangled/repo.ts";
import {
  backfillCollections,
  bff,
  BffContext,
  CSS as BffCSS,
  JETSTREAM,
  oauth,
  onListenArgs,
  RootProps,
  route,
  WithBffMeta,
} from "@bigmoves/bff";
import { Layout, Login } from "@bigmoves/bff/components";
import { CSS } from "@deno/gfm";

bff({
  appName: "Tangled ASCII",
  collections: ["sh.tangled.repo", "sh.tangled.feed.star"],
  jetstreamUrl: JETSTREAM.WEST_1,
  lexicons,
  rootElement: Root,
  onListen: async ({ indexService }: onListenArgs) => {
    await backfillCollections(
      indexService,
    )(["did:plc:wshs7t2adsemcrrd4snkeqli"], ["sh.tangled.repo"]);
  },
  middlewares: [
    oauth({
      LoginComponent: ({ error }) => (
        <div id="login" class="flex justify-center items-center w-full h-full">
          <Login hx-target="#login" error={error} />
        </div>
      ),
      onSignedIn: async ({ actor, ctx }) => {
        await ctx.backfillCollections([actor.did], [
          "sh.tangled.feed.star",
        ]);
        return "/";
      },
    }),
    route("/", async (_req, _params, ctx) => {
      const { items: repos } = ctx.indexService.getRecords<WithBffMeta<Repo>>(
        "sh.tangled.repo",
        {
          orderBy: {
            field: "addedAt",
            direction: "desc",
          },
        },
      );

      const reposWithActorAndTrees = await getReposWithActorAndTrees(
        repos,
        ctx,
      );

      return ctx.render(
        <ul className="space-y-8">
          {reposWithActorAndTrees.map((repo) => (
            <li
              key={repo.cid}
            >
              <div className="py-4 flex justify-between items-center">
                <div>
                  <div className="text-xl font-semibold text-gray-700">
                    <a href={tangledLink(repo.handle)} target="_blank">
                      @{repo.handle}
                    </a>
                    <span className="text-gray-400 px-2">/</span>
                    <a href={tangledLink(repo.handle, repo.name)}>
                      {repo.name}
                    </a>
                  </div>
                  {repo.description && (
                    <p className="mt-1 text-gray-600">
                      {repo.description}
                    </p>
                  )}
                </div>
                <form hx-post="/star" hx-swap="innerHTML" hx-target="this">
                  <StarFormInner uri={repo.uri} starred={repo.starred} />
                </form>
              </div>
              <div class="markdown-body">
                {repo.tree
                  ? (
                    <pre className="p-4 overflow-x-auto text-gray-200 font-mono text-sm">
                {repo.tree}
                    </pre>
                  )
                  : <p className="p-4">Tree generation failed</p>}
              </div>
            </li>
          ))}
        </ul>,
      );
    }),
    route("/star", ["POST"], async (req, _params, ctx) => {
      const formData = await req.formData();
      const repoUri = formData.get("repoUri") as string;

      if (!ctx.currentUser) {
        return ctx.redirect("/login");
      }

      const { items: stars } = ctx.indexService.getRecords<WithBffMeta<Star>>(
        "sh.tangled.feed.star",
        {
          where: [{
            field: "subject",
            equals: repoUri,
          }],
        },
      );
      const star = stars[0];

      if (star) {
        ctx.deleteRecord(star.uri);
        return ctx.html(<StarFormInner uri={repoUri} starred={false} />);
      }

      await ctx.createRecord<Star>(
        "sh.tangled.feed.star",
        {
          subject: repoUri,
          createdAt: new Date().toISOString(),
        },
      );

      return ctx.html(<StarFormInner uri={repoUri} starred />);
    }),
  ],
});

function Root(props: RootProps) {
  const { children } = props;
  return (
    <html
      lang="en"
      data-color-mode="light"
      data-dark-theme="light"
      class="h-full"
    >
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>tangled ascii</title>
        <script src="https://unpkg.com/htmx.org@1.9.10" />
        <script src="https://unpkg.com/hyperscript.org@0.9.14" />
        <style dangerouslySetInnerHTML={{ __html: BffCSS }} />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
        <link rel="stylesheet" href="/static/styles.css" />
        <link
          rel="stylesheet"
          href="https://unpkg.com/@fortawesome/fontawesome-free@6.7.2/css/all.min.css"
          preload
        />
      </head>
      <body class="h-full w-full">
        <Layout>
          <Layout.Nav
            title={
              <>
                <span className="text-sky-600">@</span> tangled ascii
              </>
            }
          />
          <Layout.Content class="p-4">
            {children}
          </Layout.Content>
        </Layout>
      </body>
    </html>
  );
}

function StarFormInner(
  { uri, starred }: Readonly<{ uri: string; starred: boolean }>,
) {
  return (
    <>
      <input
        type="hidden"
        name="repoUri"
        value={uri}
      />
      <input
        type="hidden"
        name="starred"
        value={String(starred)}
      />
      <button type="submit">
        <StarIcon starred={starred} />
      </button>
    </>
  );
}

const StarIcon = ({ starred }: Readonly<{ starred: boolean }>) =>
  starred
    ? <i class="fa-solid fa-star"></i>
    : <i class="fa-regular fa-star"></i>;

async function fetchRepoTree(repo: WithBffMeta<Repo>): Promise<string> {
  try {
    const response = await fetch(
      `https://${repo.knot}/${repo.did}/${repo.name}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch repo data: ${response.statusText}`);
    }

    const repoData = await response.json();
    return generateFileTree(JSON.stringify(repoData));
  } catch (error) {
    console.error(`Error generating tree for ${repo.name}:`, error);
    return "";
  }
}

interface RepoFile {
  name: string;
  is_subtree?: boolean;
  is_file?: boolean;
}

function generateFileTree(jsonBlob: string): string {
  try {
    const data = JSON.parse(jsonBlob);
    const files = data.files || [];

    if (!files.length) {
      return "No files found in the repository.";
    }

    // Sort files: directories first, then alphabetically
    files.sort((a: RepoFile, b: RepoFile) => {
      if (a.is_subtree !== b.is_subtree) {
        return a.is_subtree ? -1 : 1;
      }
      if (!a.is_file !== !b.is_file) {
        return !a.is_file ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    // Build the tree
    let result = "";
    const items = files.map((file: RepoFile) => ({
      name: file.name,
      isDirectory: !file.is_file && file.name !== ".git",
    }));

    // Generate tree representation
    for (let i = 0; i < items.length; i++) {
      const isLast = i === items.length - 1;
      const prefix = isLast ? "└── " : "├── ";
      const item = items[i];
      result += `${prefix}${item.name}${item.isDirectory ? "/" : ""}\n`;
    }

    return result;
  } catch (error) {
    return `Error generating file tree: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

type RepoWithActorAndTree = Repo & {
  uri: string;
  did: string;
  cid: string;
  handle: string;
  tree: string;
  starred: boolean;
};

async function getReposWithActorAndTrees(
  repos: WithBffMeta<Repo>[],
  ctx: BffContext,
) {
  const reposResult: RepoWithActorAndTree[] = [];
  for (const repo of repos) {
    const userDid = ctx.currentUser?.did;
    let stars: Star[] = [];
    if (userDid) {
      const results = ctx.indexService.getRecords(
        "sh.tangled.feed.star",
        {
          where: [
            {
              field: "subject",
              equals: repo.uri,
            },
            { field: "did", equals: userDid },
          ],
        },
      );
      results.items = stars;
    }
    const starred = Boolean(stars[0]);
    const actor = ctx.indexService.getActor(repo.did);
    if (!actor) {
      continue;
    }
    const tree = await fetchRepoTree(repo);
    if (!tree) {
      continue;
    }
    reposResult.push({
      ...repo,
      handle: actor.handle,
      tree,
      starred,
    });
  }
  return reposResult;
}

function tangledLink(handle: string, repoName?: string) {
  const repoPath = repoName ? "/" + repoName : "";
  return "https://tangled.sh/@" + handle + repoPath;
}
