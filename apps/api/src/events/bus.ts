import { EventEmitter } from "node:events";

export type SsePayload = {
  type: string;
  data: unknown;
};

export class EventBus extends EventEmitter {
  publish(type: string, data: unknown): void {
    const payload: SsePayload = { type, data };
    this.emit("sse", payload);
  }

  subscribe(listener: (payload: SsePayload) => void): () => void {
    this.on("sse", listener);
    return () => this.off("sse", listener);
  }
}
