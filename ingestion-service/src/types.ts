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
 * One answer read off a form: a question and what the candidate put against it.
 *
 * `label` is the printed question number (`1.5.1`), `text` the question itself,
 * and `value` either the marked option (`כן`/`לא`) or the written-in figure. A
 * checkbox grid is the whole reason this exists: the OCR text of a scanned
 * questionnaire contains the questions but not the answers, because the answers
 * are ticks in table cells rather than words.
 */
export interface FormAnswer {
  page: number;
  label: string;
  text: string;
  kind: 'boolean' | 'value';
  value: string;
  confidence?: number | null;
}

/**
 * A whole document in, text and structure out.
 *
 * Deliberately not `PageRecognizer`. A layout engine reads tables that span
 * pages and is priced per page whether it is handed a PDF or a stack of PNGs,
 * so rasterising first would cost the same and throw the structure away. The
 * pipeline branches on which of the two contracts an engine implements.
 */
export interface DocumentAnalyzer {
  analyzeDocument(bytes: Buffer, mimeType: string): Promise<AnalyzedDocument>;
}

export interface AnalyzedDocument {
  pages: TextPage[];
  answers: FormAnswer[];
}

export function isDocumentAnalyzer(
  engine: PageRecognizer | DocumentAnalyzer,
): engine is DocumentAnalyzer {
  return typeof (engine as DocumentAnalyzer).analyzeDocument === 'function';
}

/**
 * Tesseract is listed once per language set rather than taking the languages as
 * a parameter: loading `heb` for an English document actively hurts it, because
 * the Hebrew model competes for every Latin glyph. The choice belongs to the
 * document, which is what `tesseract-auto` reads off it — the two explicit sets
 * stay for the scans OSD cannot call, where the operator knows the corpus and
 * the page does not say.
 *
 * `azure-layout` is the odd one out: it is the only engine that reports which
 * checkbox was ticked, which is the only way a questionnaire's answers can be
 * read at all. It runs in a local container and is billed per page.
 */
export const OCR_ENGINE_IDS = [
  'ollama',
  'tesseract-auto',
  'tesseract-heb',
  'tesseract-eng',
  'azure-layout',
] as const;
export type OcrEngineId = (typeof OCR_ENGINE_IDS)[number];

/** The engine handling one ingest, and the id that names it in logs and fingerprints. */
export interface OcrEngineChoice {
  id: OcrEngineId;
  recognizer: PageRecognizer | DocumentAnalyzer;
}

export interface TextChunk {
  index: number;
  pageStart: number;
  pageEnd: number;
  content: string;
}
