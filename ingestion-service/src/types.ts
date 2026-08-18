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
  /**
   * Text lifted straight from a digital PDF's own text layer. When present the
   * document needed no rasterising and `pages` is empty: the pipeline stores
   * this as-is instead of running an OCR engine over pictures of text it
   * already has.
   */
  textPages?: TextPage[];
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

/**
 * One page in, one page of text out — the whole contract an OCR engine has to
 * meet. Both the Ollama vision client and the tesseract container implement it,
 * and the pipeline is handed whichever one the request asked for.
 */
export interface PageRecognizer {
  recognizePage(page: RenderedPage): Promise<TextPage>;
}

/**
 * Tesseract is listed once per language set rather than taking the languages as
 * a parameter: loading `heb` for an English document actively hurts it, because
 * the Hebrew model competes for every Latin glyph. The choice belongs to the
 * document, so it belongs in the engine list the operator picks from.
 */
export const OCR_ENGINE_IDS = ['ollama', 'tesseract-heb', 'tesseract-eng'] as const;
export type OcrEngineId = (typeof OCR_ENGINE_IDS)[number];

/** The engine handling one ingest, and the id that names it in logs and fingerprints. */
export interface OcrEngineChoice {
  id: OcrEngineId;
  recognizer: PageRecognizer;
}

export interface TextChunk {
  index: number;
  pageStart: number;
  pageEnd: number;
  content: string;
}
