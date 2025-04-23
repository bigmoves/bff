import sharp from "sharp";
import type { QueueItem, QueueItemResult } from "./types.d.ts";

let running = false;
let workerStartTime: number | undefined;
let databaseUrl: string | undefined;

self.onmessage = (event) => {
  if (event.data.command === "start") {
    databaseUrl = event.data.databaseUrl;
    if (!running) {
      running = true;
      workerStartTime = Date.now();
      processQueue();
    }
  } else if (event.data.command === "shutdown") {
    running = false;
    workerStartTime = undefined;
  }
};

export async function processQueue() {
  while (running) {
    const nextItem = await getNextPendingItem();

    if (!nextItem) {
      console.log("No pending items in queue, worker sleeping...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      // Shutdown worker after 2 minutes of inactivity
      if (workerStartTime && (Date.now() - workerStartTime >= 2 * 60 * 1000)) {
        console.log("Worker has been running for 2 minutes, shutting down...");
        running = false;
        workerStartTime = undefined;
      }
      continue;
    }

    try {
      await processImage(nextItem);
    } catch (error) {
      console.error(`Error processing image ${nextItem.id}:`, error);
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      await updateItemStatus(nextItem.id, "failed", undefined, errorMessage);
      self.postMessage({
        type: "error",
        id: nextItem.id,
        error: errorMessage,
      });
    }
  }

  self.postMessage({ type: "shutdown" });
}

async function getNextPendingItem() {
  const kv = await Deno.openKv(databaseUrl);

  // Get the oldest pending item
  const pendingItems = kv.list<string>({
    prefix: ["imageQueueIndex", "pending"],
  }, { limit: 1 });

  for await (const entry of pendingItems) {
    const id = entry.value;
    const itemResult = await kv.get(["imageQueue", id]);

    if (itemResult.value) {
      // Mark as processing to prevent other workers from picking it up
      await updateItemStatus(id, "processing");
      return itemResult.value as QueueItem;
    }
  }

  kv.close();

  return null;
}

async function updateItemStatus(
  id: string,
  status: "pending" | "processing" | "completed" | "failed",
  result?: QueueItemResult,
  error?: string,
) {
  const kv = await Deno.openKv(databaseUrl);

  const itemResult = await kv.get(["imageQueue", id]);
  if (!itemResult.value) return;

  const item = itemResult.value as QueueItem;
  const now = new Date();

  await kv.delete([
    "imageQueueIndex",
    item.status,
    item.updatedAt.toISOString(),
    id,
  ]);

  item.status = status;
  item.updatedAt = now;
  if (result !== undefined) item.result = result;
  if (error !== undefined) item.error = error;

  await kv.set(["imageQueue", id], item);
  await kv.set(["imageQueueIndex", status, now.toISOString(), id], id);

  kv.close();
}

async function processImage(item: QueueItem) {
  console.log(`Processing image ${item.id}: ${item.id}`);

  const imageBuffer = await Deno.readFile(item.imagePath);

  const { buffer, dimensions } = await compressImage(imageBuffer);

  await Deno.writeFile(item.imagePath, buffer);

  const result: QueueItemResult = {
    uploadId: item.id,
    did: item.did,
    imagePath: item.imagePath,
    dimensions,
  };

  await updateItemStatus(item.id, "completed", result);

  self.postMessage({
    type: "complete",
    id: item.id,
    result,
  });
}

async function compressImage(
  fileBuffer: Uint8Array,
): Promise<
  { dimensions: { width?: number; height?: number }; buffer: Uint8Array }
> {
  const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
  const TARGET_WIDTH = 1200;
  let quality = 90;

  let buffer = await sharp(fileBuffer)
    .autoOrient()
    .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();

  if (buffer.length <= MAX_FILE_SIZE) {
    const metadata = await sharp(buffer).metadata();
    const { width, height } = metadata;
    return { dimensions: { width, height }, buffer };
  }

  let minQuality = 10;
  let maxQuality = 75;

  while (minQuality <= maxQuality) {
    quality = Math.floor((minQuality + maxQuality) / 2);

    buffer = await sharp(fileBuffer)
      .autoOrient()
      .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
      .webp({ quality })
      .toBuffer();

    if (buffer.length <= MAX_FILE_SIZE) {
      minQuality = quality + 1; // Try to find higher quality that fits
    } else {
      maxQuality = quality - 1; // Need lower quality
    }
  }

  buffer = await sharp(fileBuffer)
    .autoOrient()
    .resize({ width: TARGET_WIDTH, withoutEnlargement: true })
    .webp({ quality: maxQuality })
    .toBuffer();

  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  return { dimensions: { width, height }, buffer };
}
