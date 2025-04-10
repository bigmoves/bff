#!/usr/bin/env -S deno run --allow-env
import { walk } from "@std/fs";

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

function processFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    Deno.readTextFile(file)
      .then(async (text) => {
        // Handle imports across multiple lines
        const importRegex = /(import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

        const modifiedText = text.replace(
          importRegex,
          (match, _statement, module) => {
            // Only process relative imports that don't already have .ts
            if (module.startsWith(".") && !module.endsWith(".ts")) {
              // Replace the module path, ensuring we remove any .js extension
              const newModule = `${module.replace(/\.js$/, "")}.ts`;
              return match.replace(module, newModule);
            }
            return match;
          },
        );

        await Deno.writeTextFile(file, modifiedText);
        return resolve(modifiedText);
      })
      .catch((err) => reject(err));
  });
}
