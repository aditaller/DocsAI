/* Document Intelligence — shared types */

export type FileType = 'pdf' | 'word' | 'image';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type FlagSeverity = 'warn' | 'danger' | 'info';

export interface Doc {
  id: string;
  name: string;
  type: FileType;
  date: string;
  category: string;
  selected: boolean;
  file?: File; // present for docs loaded from server; opened by native type handling
  path?: string; // gnr.archive file path/URL; opened directly when present
  note?: string; // gnr.archive.note
  isFromArchive: boolean; // true = came from gnr.v_Archive; false = freshly uploaded, not yet archived
  archiveId: number | null; // gnr.archive id when isFromArchive; null until an upload is archived
}

export interface Job {
  jobId: string;
  docId: string;
  name: string;
  type: FileType;
  status: JobStatus;
  confidence: number | null;
  pages: number;
  /** Processing time the backend reports for this document; null when it reports none. */
  totalMs: number | null;
  ts: string;
  progress: number;
  raw?: RawOcr;
  ocr?: unknown; // full OCR API payload, saved to gnr.archive_OCR
  isFromArchive: boolean; // mirrors the source Doc; false = uploaded, not yet in gnr.archive
  archiveId: number | null; // gnr.archive id once archived
  ragDocumentId?: number | null; // rag.document id once ingested locally; what local analysis searches
  error?: string; // why status === 'failed'; the toast is gone by the time anyone reads the board
}

export interface Field {
  k: string;
  v: string;
  amount?: boolean;
}

export interface Flag {
  sev: FlagSeverity;
  title: string;
  body: string;
}

export interface AnalysisResponse {
  id: string;
  docNames: string[];
  timestamp: string;
  model: string;
  saved: boolean;
  summary: string;
  fields: Field[];
  flags: Flag[];
  relatedFiles?: RelatedFile[]; // the docs whose OCR text was sent to AI, in save order
  elapsedMs?: number; // AI round-trip time, stored as ResponseTime
  prompt?: string; // the instruction sent with this analysis, stored as PromptText
}

export interface RelatedFile {
  docId: string; // the Doc.id, so the live doc (and its File) can be re-found at save time
  name: string;
  isFromArchive: boolean;
  archiveId: number | null; // set once the file exists in gnr.archive
}

export interface RawOcr {
  pages: number;
  avgConf: number;
  lowConf: number;
  lines: string[];
}

export interface PromptTemplate {
  label: string;
  text: string;
  /** Prepended to the user-edited prompt as the system message. */
  system?: string;
}

export interface Preview {
  kind: 'form' | 'doc' | 'table' | 'image';
  org: string;
  title: string;
  ref: string;
  meta?: [string, string][];
  fields?: [string, string][];
  narrativeTitle?: string;
  narrative?: string;
  paragraphs?: string[];
  lines?: [string, string][];
  shots?: string[];
  caption?: string;
  totals?: [string, string][];
}

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'success' | 'error';
}

/**
 * Prefix on a streamed fragment that is the model's reasoning, not its answer.
 * A thinking model emits reasoning for many seconds before the first answer
 * token, and showing nothing during that time is indistinguishable from a hang.
 * The UI renders it as visible progress and drops it when the answer starts.
 */
export const THINKING_PREFIX = '⚙ ';
