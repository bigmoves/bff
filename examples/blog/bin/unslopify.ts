#!/usr/bin/env -S deno run --allow-env

import { walk } from "@std/fs";

/**
 * Based on https://github.com/callmephilip/tinychat-at-proto/blob/main/bin/unslopify.ts
 * A utility to ensure TypeScript import statements include ".ts" extensions
 */

if (import.meta.main) {
  const args = Deno.args;

  if (args.length !== 1) {
    console.error(
      "Usage: deno run --allow-read --allow-write ./bin/unslopify.ts <path>",
    );
    Deno.exit(1);
  }

  for await (const dirEntry of walk(args[0], { exts: ["ts"] })) {
    await processFile(dirEntry.path);
  }
}

function processLine(line: string): string {
  if (!line.trim().match(/^(import|export)/gi)) {
    return line;
  }
  const module = line.split("from").pop()?.trim().replaceAll(/'|"|;/gi, "");
  if (!module?.startsWith(".") || module.endsWith(".ts")) {
    return line;
  }
  return line.replace(module, `${module}.ts`).replace(".js", "");
}

async function processFile(file: string): Promise<string> {
  const text = await Deno.readTextFile(file);
  const modifiedText = text.split("\n").map(processLine).join("\n");
  await Deno.writeTextFile(file, modifiedText);
  return modifiedText;
}
