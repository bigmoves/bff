#!/usr/bin/env -S deno run --allow-net --allow-write

if (import.meta.main) {
  await Deno.mkdir("lexicons/com/whtwnd/blog", { recursive: true });

  const filesToDownload = [
    "defs.json",
    "entry.json",
  ];

  for (const fileName of filesToDownload) {
    const response = await fetch(
      `https://raw.githubusercontent.com/whtwnd/whitewind-blog/main/lexicons/com/whtwnd/blog/${fileName}`,
    );
    const fileContent = await response.text();
    await Deno.writeTextFile(
      `lexicons/com/whtwnd/blog/${fileName}`,
      fileContent,
    );
  }

  console.log("Lexicons added successfully!");
}
