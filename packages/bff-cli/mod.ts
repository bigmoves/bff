import { parseArgs } from "@std/cli/parse-args";
import { dirname, fromFileUrl, join, resolve } from "@std/path";

const LEXICON_DIR = "lexicons";
const CODEGEN_DIR = "__generated__";

const MAIN_NAME = "main.tsx";
const MAIN_CONTENTS = `
import { bff, oauth, route, JETSTREAM } from "@bigmoves/bff";

bff({
  appName: "AT Protocol App",
  collections: ["xyz.statusphere.status"],
  jetstreamUrl: JETSTREAM.WEST_1,
  middlewares: [
    oauth(),
    route("/", (_req, _params, ctx) => {
      return ctx.render(<div>Hello, atmosphere!</div>);
    }),
  ],
});

`;

const DENO_JSON_NAME = "deno.json";
const DENO_JSON_CONTENTS = `{
  "imports": {
    "$lexicon/": "./__generated__/",
    "preact": "npm:preact@^10.26.5",
    "typed-htmx": "npm:typed-htmx@^0.3.1"
  },
  "tasks": {
    "dev": "deno run -A --watch main.tsx",
    "codegen": "deno run -A ../../packages/bff-cli/mod.ts lex"
  },
  "compilerOptions": {
    "jsx": "precompile",
    "jsxImportSource": "preact"
  }
}
`;

const GLOBALS_NAME = "globals.d.ts";
const GLOBALS_CONTENTS = `
import "typed-htmx";

declare module "preact" {
  namespace JSX {
    interface HTMLAttributes extends HtmxAttributes {}
  }
}
`;

if (import.meta.main) {
  const flags = parseArgs(Deno.args, {
    boolean: ["help"],
    string: ["unstable-lexicons"],
    alias: { h: "help" },
    "--": true,
  });

  if (flags.help) {
    printHelp();
  }

  const command = Deno.args[0];
  if (command == null) {
    printHelp();
  }

  switch (command) {
    case "init":
      if (!Deno.args[1] || Deno.args[1].startsWith("-")) {
        console.error("Please provide a directory to initialize.");
        Deno.exit(0);
      }
      await init(Deno.args[1]);
      if (flags["unstable-lexicons"]) {
        await addLexicons(flags["unstable-lexicons"], Deno.args[1]);
        await codegen(
          join(Deno.args[1], LEXICON_DIR),
          join(Deno.args[1], CODEGEN_DIR),
        );
      }
      break;
    case "lex": {
      await codegen();
      break;
    }
    case "tailwind": {
      await installTailwindDeps();
      const existingConfig = await Deno.readTextFile("./deno.json");
      const updatedConfig = addTailwindTasksToDenoJson(existingConfig);
      await Deno.writeTextFile("./deno.json", updatedConfig);
      await Deno.writeTextFile(
        "./input.css",
        `@import "tailwindcss";`,
      );
      break;
    }
    default:
      console.log('Please use "init" command to initialize a bff project.');
      printHelp();
      break;
  }
} else {
  throw new Error("This module is meant to be executed as a CLI.");
}

async function init(directory: string) {
  directory = resolve(directory);

  console.log(`Initializing bff in ${directory}...`);
  try {
    const dir = [...Deno.readDirSync(directory)];
    if (dir.length > 0) {
      const confirmed = confirm(
        "You are trying to initialize a bff in an non-empty directory, do you want to continue?",
      );
      if (!confirmed) {
        throw new Error("Directory is not empty, aborting.");
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      throw err;
    }
  }

  await Deno.mkdir(join(directory, "lexicons"), { recursive: true });
  await Deno.mkdir(join(directory, "static"), { recursive: true });
  await Deno.writeTextFile(join(directory, MAIN_NAME), MAIN_CONTENTS);
  await Deno.writeTextFile(
    join(directory, DENO_JSON_NAME),
    DENO_JSON_CONTENTS,
  );
  await Deno.writeTextFile(
    join(directory, GLOBALS_NAME),
    GLOBALS_CONTENTS,
  );

  console.log("Bff initialized, run `deno task dev` to get started.");
}

async function codegen(
  lexiconDir: string | undefined = LEXICON_DIR,
  codegenDir: string | undefined = CODEGEN_DIR,
) {
  const currentDir = dirname(fromFileUrl(Deno.mainModule));
  const filesAndDirs = await getJsonFilesAndDirs(lexiconDir);
  const { stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:@atproto/lex-cli",
      "gen-server",
      "--yes",
      codegenDir,
      ...filesAndDirs,
    ],
  }).output();
  logCommandOutput(stdout, stderr);
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--unstable-sloppy-imports",
      join(currentDir, "./unslopify.ts"),
      codegenDir,
    ],
  }).output();
  logCommandOutput(result.stdout, result.stderr);
  const result2 = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      join(currentDir, "./replace_imports.ts"),
      codegenDir,
    ],
  }).output();
  logCommandOutput(result2.stdout, result2.stderr);
}

async function addLexicons(lexicons: string, rootDir?: string) {
  const { stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "jsr:@lpm/cli",
      "add",
      lexicons,
    ],
    cwd: join(Deno.cwd(), rootDir ?? ""),
  }).output();
  logCommandOutput(stdout, stderr);
}

function printHelp(): void {
  console.log(`Usage: bff [OPTIONS...]`);
  console.log("\nArguments:");
  console.log("  init <directory>          Initialize a new bff project");
  console.log("\nOptional flags:");
  console.log("  -h, --help                Display help");
  Deno.exit(0);
}

function logCommandOutput(
  stdout: Uint8Array<ArrayBuffer>,
  stderr: Uint8Array<ArrayBuffer>,
) {
  const error = new TextDecoder().decode(stderr);
  if (error) {
    console.error("Error:", error);
  }
  const output = new TextDecoder().decode(stdout);
  console.log("Output:", output);
}

async function getJsonFilesAndDirs(dirPath: string): Promise<string[]> {
  const result: string[] = [];

  if (dirPath !== ".") {
    result.push(dirPath);
  }

  for await (const entry of Deno.readDir(dirPath)) {
    const entryPath = `${dirPath}/${entry.name}`;

    if (entry.isDirectory) {
      const subEntries = await getJsonFilesAndDirs(entryPath);
      result.push(...subEntries);
    } else if (entry.isFile && entry.name.endsWith(".json")) {
      result.push(entryPath);
    }
  }

  return result;
}

async function installTailwindDeps() {
  const { stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "add",
      "npm:@tailwindcss/cli",
      "npm:tailwindcss",
    ],
  }).output();
  const error = new TextDecoder().decode(stderr);
  if (error) {
    console.error(error);
  }
}

function addTailwindTasksToDenoJson(existingDenoJson: string) {
  const config = typeof existingDenoJson === "string"
    ? JSON.parse(existingDenoJson)
    : existingDenoJson;

  config.tasks = {
    ...(config.tasks || {}),
    "dev": 'deno run "dev:*"',
    "dev:server": "deno run -A --watch ./main.tsx",
    "dev:tailwind":
      "deno run -A --node-modules-dir npm:@tailwindcss/cli -i ./input.css -o ./static/styles.css --watch",
  };

  return JSON.stringify(config, null, 2);
}
