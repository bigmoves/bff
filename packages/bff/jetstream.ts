import type { JetstreamEvent } from "./types.d.ts";

export class Jetstream<T> {
  readonly wantedCollections: string[];

  #handleEvent: (event: JetstreamEvent<T>) => void;
  #ws: WebSocket | null = null;
  #isConnected = false;
  #instanceUrl: string;
  #reconnectAttempt = 0;
  #maxReconnectAttempts = 10;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #shouldReconnect = true;

  constructor(opts: {
    instanceUrl?: string;
    handleEvent: (event: JetstreamEvent<T>) => void;
    wantedCollections: string[];
    maxReconnectAttempts?: number;
  }) {
    this.#instanceUrl = opts.instanceUrl ||
      "wss://jetstream2.us-west.bsky.network";
    this.#handleEvent = opts.handleEvent;
    this.wantedCollections = opts.wantedCollections;
    this.#maxReconnectAttempts = opts.maxReconnectAttempts ?? 10;
  }

  constructUrl() {
    const params = new URLSearchParams();
    if (this.wantedCollections.length > 0) {
      params.append("wantedCollections", this.wantedCollections.join(","));
    }
    return `${this.#instanceUrl}/subscribe?${params.toString()}`;
  }

  public connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#shouldReconnect = true;
      this.#ws = new WebSocket(this.constructUrl());

      this.#ws.onopen = () => {
        this.#isConnected = true;
        this.#reconnectAttempt = 0;
        console.log("Connected to Jetstream");
        resolve();
      };

      this.#ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.#handleEvent(data);
        } catch (error) {
          console.error("Error decoding message:", error);
        }
      };

      this.#ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        if (!this.#isConnected) {
          reject(error);
        }
      };

      this.#ws.onclose = () => {
        this.#isConnected = false;
        console.log("Disconnected from Jetstream");
        if (this.#shouldReconnect) {
          this.attemptReconnect();
        }
      };
    });
  }

  private attemptReconnect(): void {
    if (this.#reconnectAttempt >= this.#maxReconnectAttempts) {
      console.error(
        `Failed to reconnect after ${this.#maxReconnectAttempts} attempts`,
      );
      return;
    }

    this.#reconnectAttempt++;
    const delay = Math.min(
      1000 * Math.pow(2, this.#reconnectAttempt - 1),
      30000,
    ); // Exponential backoff with max of 30 seconds

    console.log(
      `Attempting to reconnect (${this.#reconnectAttempt}/${this.#maxReconnectAttempts}) in ${
        delay / 1000
      } seconds`,
    );

    this.#reconnectTimeout = setTimeout(() => {
      console.log(`Reconnecting... Attempt ${this.#reconnectAttempt}`);
      this.connect().catch(() => {
        // If connection attempt fails, the onclose handler will trigger another reconnect attempt
      });
    }, delay);
  }

  public disconnect() {
    this.#shouldReconnect = false;
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
      this.#reconnectTimeout = null;
    }
    if (this.#ws) {
      this.#ws.close();
      this.#ws = null;
    }
    this.#isConnected = false;
  }
}

export default Jetstream;
