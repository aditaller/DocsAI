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
}

export interface TextChunk {
  index: number;
  pageStart: number;
  pageEnd: number;
  content: string;
}
