import type { Agent } from "@atproto/api";
import type { BlobRef } from "@atproto/lexicon";
import { TtlCache } from "@std/cache";
import { join } from "@std/path";
import { Buffer } from "node:buffer";
import { Queue, type QueueItemResult, type QueuePayload } from "./queue.ts";

const TEMP_IMAGE_STORAGE = "./image_storage";

type UploadMeta = {
  status: "pending" | "completed" | "failed";
  blobRef?: BlobRef;
  dimensions?: {
    width?: number;
    height?: number;
  };
};

/**
 * Handles processing and uploading images provided an authenticated AT Protocol Agent.
 *
 * @example
 * const photoProcessor = new BFFPhotoProcessor();
 * await photoProcessor.initialize(agent);
 * const uploadId = photoProcessor.startUpload(file, dataUrl);
 * const status = photoProcessor.getUploadStatus(uploadId);
 */
export class BFFPhotoProcessor {
  private agent?: Agent;
  private queue?: Queue;
  private initialized = false;
  private readonly uploadMetaCache = new TtlCache<string, UploadMeta>(
    1000 * 60 * 5,
  ); // 5 min

  constructor() {
    Deno.addSignalListener("SIGINT", () => {
      console.log("Shutting down photo processor...");
      this.queue?.close();
    });
  }

  async initialize(agent: Agent): Promise<void> {
    if (this.initialized) return;
    this.agent = agent;
    this.queue = await Queue.create(
      "file::memory:?cache=shared",
      this.onComplete.bind(this),
      this.onError.bind(this),
    );
    this.initialized = true;
  }

  startUpload(file: File): string {
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }

    const uploadId = crypto.randomUUID();

    this.uploadMetaCache.set(uploadId, {
      status: "pending",
    });

    if (!file) {
      throw new Error("No file provided");
    }

    this.enqueueImage({
      file,
      uploadId,
    });

    return uploadId.toString();
  }

  getUploadStatus(uploadId: string): UploadMeta | undefined {
    const blobMeta = this.uploadMetaCache.get(uploadId);
    if (!blobMeta) {
      return undefined;
    }
    const blobRef = blobMeta.blobRef;
    if (blobRef) {
      return blobMeta;
    }
    return undefined;
  }

  async enqueueImage({
    file,
    uploadId,
  }: {
    file: File;
    uploadId: string;
  }): Promise<{
    uploadId: string;
    imagePath: string;
  }> {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const tempImagePath = join(
      Deno.cwd(),
      TEMP_IMAGE_STORAGE,
    );
    const imagePath = join(tempImagePath, uploadId);
    await Deno.mkdir(tempImagePath, { recursive: true });
    await Deno.writeFile(
      imagePath,
      buffer,
    );

    const payload: QueuePayload = {
      type: "process_image",
      data: {
        uploadId,
        imagePath,
      },
    };

    await this.queue?.enqueue(payload);

    return {
      uploadId,
      imagePath,
    };
  }

  async onComplete(
    result: QueueItemResult,
  ) {
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }

    try {
      const buffer = await Deno.readFile(result.imagePath);

      const blobResponse = await this.agent.uploadBlob(buffer);

      await Deno.remove(result.imagePath);

      const existingUploadMeta = this.uploadMetaCache.get(result.uploadId);
      const newUploadMeta: UploadMeta = {
        ...existingUploadMeta,
        status: "completed",
        blobRef: blobResponse.data.blob,
        dimensions: result.dimensions,
      };

      this.uploadMetaCache.set(result.uploadId, newUploadMeta);
    } catch (error) {
      console.error("Error uploading blob:", error);
      throw new Error("Failed to upload blob");
    }
  }

  onError(
    id: string,
    _error: unknown,
  ) {
    const blobMeta = this.uploadMetaCache.get(id);
    if (blobMeta) {
      this.uploadMetaCache.set(id, {
        ...blobMeta,
        status: "failed",
      });
    }
  }
}
