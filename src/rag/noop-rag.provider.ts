import type { RagChunk, RagProvider } from "./rag-provider.interface.js";

/** No-op RAG provider. Replace with a vector-search implementation later. */
export class NoopRagProvider implements RagProvider {
  async query(_question: string, _topK?: number): Promise<RagChunk[]> {
    return [];
  }
}

export const ragProvider: RagProvider = new NoopRagProvider();
