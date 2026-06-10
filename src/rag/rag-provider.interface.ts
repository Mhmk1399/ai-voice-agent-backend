// ─────────────────────────────────────────────────────────────────────────────
// RAG Provider Interface
// For future retrieval-augmented generation (e.g. FAQ, policy docs).
// ─────────────────────────────────────────────────────────────────────────────

export interface RagChunk {
  id: string;
  content: string;
  score: number;
  source?: string;
}

export interface RagProvider {
  query(question: string, topK?: number): Promise<RagChunk[]>;
}
