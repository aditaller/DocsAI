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
}

export interface Job {
  jobId: string;
  docId: string;
  name: string;
  type: FileType;
  status: JobStatus;
  confidence: number | null;
  pages: number;
  ts: string;
  progress: number;
  raw?: RawOcr;
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
