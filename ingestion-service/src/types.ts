export type IngestionJobState =
  | 'PENDING'
  | 'PARSING'
  | 'CHUNKING'
  | 'EMBEDDING'
  | 'COMPLETED'
  | 'RETRY_WAIT'
  | 'FAILED';

export interface ArchiveRecord {
  archiveId: number;
  sourceClaimId: number;
  fileName: string;
  mimeType?: string;
  fullPath?: string;
  sourceRevision?: string;
}

export interface SourceFile extends ArchiveRecord {
  bytes: Buffer;
  mimeType: string;
}

export interface RenderedPage {
  pageIndex: number;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  bytes: Buffer;
}

export interface RenderedDocument {
  sourceMimeType: string;
  pages: RenderedPage[];
}

export interface TextPage {
  pageIndex: number;
  text: string;
  /**
   * Geometric mean of the OCR model's token probabilities, 0–1, the local
   * counterpart to Azure Document Intelligence's confidence. Null when the
   * Ollama build returns no logprobs, or when the page was read back from the
   * store rather than transcribed.
   */
  confidence?: number | null;
}

export interface TextChunk {
  index: number;
  pageStart: number;
  pageEnd: number;
  content: string;
}
