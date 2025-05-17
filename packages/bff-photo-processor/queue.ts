export type QueuePayload = {
  type: "process_image";
  data: {
    uploadId: string;
    imagePath: string;
  };
};

export type QueueItemResult = {
  uploadId: string;
  imagePath: string;
  dimensions: {
    width?: number;
    height?: number;
  };
};

export type QueueItem = {
  id: string;
  imagePath: string;
  status: "pending" | "processing" | "completed" | "failed";
  result?: QueueItemResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
};

export class Queue {
  private kv?: Deno.Kv;
  private workerProcessing = false;
  private readonly onComplete: (result: QueueItemResult) => void;
  private readonly onError: (id: string, error: unknown) => void;
  private readonly queueDatabaseUrl: string;

  private constructor(
    queueDatabaseUrl: string,
    onComplete: (result: QueueItemResult) => void,
    onError: (id: string, error: unknown) => void,
  ) {
    this.queueDatabaseUrl = queueDatabaseUrl;
    this.onComplete = onComplete;
    this.onError = onError;
  }

  static async create(
    queueDatabaseUrl: string,
    onComplete: (result: QueueItemResult) => void,
    onError: (id: string, error: unknown) => void,
  ): Promise<Queue> {
    const instance = new Queue(
      queueDatabaseUrl,
      onComplete,
      onError,
    );
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    this.kv = await Deno.openKv(this.queueDatabaseUrl);

    this.kv.listenQueue(async (message: QueuePayload) => {
      if (message.type !== "process_image") return;
      const now = new Date();
      const { data } = message;

      const queueItem: QueueItem = {
        id: data.uploadId,
        imagePath: data.imagePath,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };

      await this.kv?.set(["imageQueue", queueItem.id], queueItem);
      await this.kv?.set([
        "imageQueueIndex",
        "pending",
        now.toISOString(),
        queueItem.id,
      ], queueItem.id);

      console.log(`Image enqueued with ID: ${queueItem.id}`);

      this.ensureWorkerIsRunning();
    });
  }

  private createWorker(): Worker {
    const worker = new Worker(
      new URL("./worker.ts", import.meta.url).href,
      {
        type: "module",
      },
    );
    return worker;
  }

  private ensureWorkerIsRunning(): void {
    if (this.workerProcessing) return;
    this.workerProcessing = true;

    const worker = this.createWorker();

    worker.onmessage = (e) => {
      const { type, id, result, error } = e.data;
      if (type === "complete") {
        console.log(`Worker completed processing image ${id}`);
        this.onComplete(result);
      } else if (type === "error") {
        console.error(
          `Worker encountered an error processing image ${id}:`,
          error,
        );
        this.onError(id, error);
      } else if (type === "shutdown") {
        this.workerProcessing = false;
        worker.terminate();
        console.log("Worker shut down due to empty queue");
      }
    };

    worker.onerror = (error) => {
      console.error("Worker error:", error);
      this.workerProcessing = false;
    };

    worker.postMessage({
      command: "start",
      databaseUrl: this.queueDatabaseUrl,
    });

    console.log("Image processor worker started");
  }

  async enqueue(payload: QueuePayload): Promise<void> {
    await this.kv?.enqueue(payload);
  }

  close(): void {
    this.kv?.close();
  }
}
