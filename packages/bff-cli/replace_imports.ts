#!/usr/bin/env -S deno run --unstable-sloppy-imports --allow-read --allow-write
import { walk } from "@std/fs";

if (import.meta.main) {
  const args = Deno.args;
  if (args.length !== 1) {
    console.error(
      "Usage: deno run --unstable-sloppy-imports --allow-read --allow-write unslopify.ts <path>",
    );
    Deno.exit(1);
  }
  for await (const dirEntry of walk(args[0], { exts: ["ts"] })) {
    await processFile(dirEntry.path);
  }
}

async function processFile(file: string): Promise<void> {
  try {
    const text = await Deno.readTextFile(file);

    // Replace imports with npm: prefix
    const modifiedText = text.replace(
      /from\s+['"](@atproto\/lexicon|@atproto\/xrpc-server|multiformats(?:\/[^'"]+)?)['"]/g,
      'from "npm:$1"',
    );

    if (text !== modifiedText) {
      console.log(`Modified imports in: ${file}`);
      await Deno.writeTextFile(file, modifiedText);
    }
  } catch (error) {
    console.error(`Error processing file ${file}:`, error);
  }
}
