import { Injectable } from '@angular/core';
import { DI_CONFIG } from '../config/di.config';
import { OcrResult } from './ocr.service';

export interface LocalIngestResult extends OcrResult {
  ragDocumentId: number | null;
  scopeId: number | null;
  reused: boolean;
  /** What the OCR model said the document is written in, e.g. "Hebrew". */
  language: string | null;
  /** Which engine actually read the pages: 'tesseract' or 'ollama'. */
  engine: string;
}

/** Identifies the record documents are scoped to, mirroring gnr.archive.object_type. */
export interface RagScope {
  objectType: string;
  objectId: number;
  label: string;
}

export interface Citation {
  documentId: number;
  pageStart: number;
  pageEnd: number;
  distance: number;
}

export interface LocalChatResult {
  reply: string;
  citations: Citation[];
  elapsedTimeMs: number;
  /**
   * How the answer was actually sourced. A `full` request downgrades itself to
   * `retrieval` when the document exceeds the context budget, so this can differ
   * from what was asked for.
   */
  mode: 'full' | 'retrieval';
  /** Set only when a full-document request fell back, with the sizes that forced it. */
  fellBack?: { chars: number; budget: number };
}

/** A stream that failed after some tokens had already been shown. */
export class LocalChatError extends Error {
  constructor(message: string, readonly partial: string) {
    super(message);
    this.name = 'LocalChatError';
  }
}

export interface LocalHealth {
  ok: boolean;
  postgres: boolean;
  ollama: boolean;
  missingModels: string[];
  /** Whether the tesseract container answered. Ollama still gates `ok`: it embeds and answers. */
  tesseract: boolean;
  /** Whether poppler's pdftoppm ran. Images ingest without it; only PDFs need it. */
  pdftoppm: boolean;
}

/**
 * The local counterpart to OcrService: Ollama vision OCR straight into pgvector,
 * then retrieval-augmented answers from a local model. Same OcrResult shape, so
 * the caller swaps implementations without restructuring.
 */
@Injectable({ providedIn: 'root' })
export class LocalRagService {
  /** OCRs the bytes locally and indexes every page into pgvector under the record's scope. */
  async ingest(file: File, archiveId: number, scope: RagScope, engineId = DI_CONFIG.local.defaultEngineId): Promise<LocalIngestResult> {
    const url = new URL(DI_CONFIG.local.ingestEndpoint, location.origin);
    url.searchParams.set('archiveId', String(archiveId));
    url.searchParams.set('objectType', scope.objectType);
    url.searchParams.set('objectId', String(scope.objectId));
    url.searchParams.set('label', scope.label);
    url.searchParams.set('fileName', file.name);
    url.searchParams.set('engine', engineId);

    const t0 = performance.now();
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const r = await this.body(res, `Local OCR failed for ${file.name}`);
    const pages: Array<{ pageNumber: number; text: string; confidence: number | null }> = r['pages'] ?? [];
    console.log(`local OCR ${file.name} (${r['engine'] ?? engineId}): ${pages.length} page(s), server ${r['elapsedTimeMs'] ?? '?'}ms, total ${Math.round(performance.now() - t0)}ms`);

    // Mean word confidence from tesseract, or mean token probability from the
    // vision model, on the same 0–100 scale Azure reports. Null when the Ollama
    // build returns no logprobs, or when these bytes were already indexed and the
    // text came back from the store; the board then renders "—" rather than
    // inventing a number.
    const confidence = typeof r['confidence'] === 'number' ? r['confidence'] : null;

    return {
      text: String(r['content'] ?? ''),
      confidence,
      pages: pages.length,
      // The run's own duration, read back from rag.ingestionrun when these bytes
      // were already indexed — otherwise a reused document would report the few
      // milliseconds the skip took rather than what the OCR actually cost.
      totalMs: typeof r['totalMs'] === 'number' ? r['totalMs'] : null,
      raw: {
        pages: pages.length,
        avgConf: confidence ?? 0,
        lowConf: pages.filter((p) => typeof p.confidence === 'number' && p.confidence < 90).length,
        lines: pages.map((p) => `[Page ${p.pageNumber}] ${p.text}`),
      },
      api: r,
      ragDocumentId: r['ragDocumentId'] ?? null,
      scopeId: r['scopeId'] ?? null,
      reused: r['reused'] === true,
      language: r['language'] ?? null,
      engine: String(r['engine'] ?? engineId),
    };
  }

  /**
   * Answers over the given documents, streaming the reply.
   *
   * `full` picks how the documents reach the model. Analyze sends `true`, so
   * every OCR page goes in and the local answer rests on the same evidence the
   * cloud path sends. The chat drawer leaves it `false` and gets the retrieval
   * behaviour, which is what a narrow follow-up wants.
   *
   * `onToken` receives each fragment as it arrives; the resolved value is the
   * complete reply either way.
   */
  async chat(
    prompt: string,
    ragDocumentIds: number[],
    options: {
      full?: boolean;
      onToken?: (token: string) => void;
      /** Reasoning text from a thinking model, ahead of the answer. Never part of the reply. */
      onThinking?: (token: string) => void;
    } = {},
  ): Promise<LocalChatResult> {
    const res = await fetch(new URL(DI_CONFIG.local.chatEndpoint, location.origin).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        documentIds: ragDocumentIds,
        full: options.full === true,
        topK: DI_CONFIG.local.topK,
      }),
    });
    // A refusal (over budget, no chat model) still arrives as JSON with a status,
    // because the service checks those before it opens the stream.
    if (!res.ok || !res.body) {
      await this.body(res, 'Local analysis failed');
      throw new Error('Local analysis failed');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    let citations: Citation[] = [];
    let elapsedTimeMs = 0;
    let mode: 'full' | 'retrieval' = options.full === true ? 'full' : 'retrieval';
    let fellBack: { chars: number; budget: number } | null = null;
    let failure: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a chunk can split one, so the
      // remainder stays buffered until its terminator arrives.
      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split).trim();
        buffer = buffer.slice(split + 2);
        if (!frame.startsWith('data:')) continue;
        let event: Record<string, any>;
        try {
          event = JSON.parse(frame.slice(5).trim());
        } catch {
          continue;
        }
        if (typeof event['thinking'] === 'string') options.onThinking?.(event['thinking']);
        if (typeof event['token'] === 'string') {
          reply += event['token'];
          options.onToken?.(event['token']);
        }
        if (event['error']) failure = String(event['error']);
        if (event['done']) {
          citations = event['citations'] ?? [];
          elapsedTimeMs = Number(event['elapsedTimeMs'] ?? 0);
          mode = event['mode'] === 'full' ? 'full' : 'retrieval';
          fellBack = event['fellBack'] ?? null;
        }
      }
    }

    // The stream carries its own failures once headers are out. Never let a
    // partial answer pass as a complete one.
    if (failure) throw new LocalChatError(failure, reply);
    return { reply: reply.trim(), citations, elapsedTimeMs, mode, ...(fellBack ? { fellBack } : {}) };
  }

  /** Drives whether the toggle is offered at all. */
  async health(): Promise<LocalHealth> {
    try {
      const res = await fetch(new URL(DI_CONFIG.local.healthEndpoint, location.origin).toString());
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as LocalHealth;
    } catch {
      // An unstarted server.js is the common case; report it as unavailable
      // rather than letting the failure surface later as an OCR error.
      return { ok: false, postgres: false, ollama: false, missingModels: [], tesseract: false, pdftoppm: false };
    }
  }

  /** The service sanitizes its own errors, so its message is safe to surface. */
  private async body(res: Response, fallback: string): Promise<Record<string, any>> {
    const text = await res.text();
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${fallback} (${res.status} ${res.statusText})`);
    }
    if (!res.ok) throw new Error(`${fallback}: ${parsed['error'] ?? res.statusText}`);
    return parsed;
  }
}
