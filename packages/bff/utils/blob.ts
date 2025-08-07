import type { Agent } from "@atproto/api";
import type { BlobRef } from "@atproto/lexicon";

export function uploadBlob(
  agent: Agent | undefined,
) {
  return async (file: File): Promise<BlobRef> => {
    if (!agent) {
      throw new Error("Agent is not authenticated");
    }

    try {
      const response = await agent.uploadBlob(file);
      return response.data.blob;
    } catch (error) {
      console.error("Error uploading blob:", error);
      throw new Error("Failed to upload blob");
    }
  };
}