import type { Response } from "express";

export class SseHub {
  readonly #clients = new Map<string, Set<Response>>();

  subscribe(runId: string, response: Response): () => void {
    const clients = this.#clients.get(runId) ?? new Set<Response>();
    clients.add(response);
    this.#clients.set(runId, clients);
    response.write(`event: connected\ndata: ${JSON.stringify({ runId })}\n\n`);

    return () => {
      clients.delete(response);
      if (clients.size === 0) {
        this.#clients.delete(runId);
      }
    };
  }

  publish(runId: string, event: unknown): void {
    const payload = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients.get(runId) ?? []) {
      client.write(payload);
    }
  }
}
