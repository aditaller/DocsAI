import { Injectable } from '@angular/core';
import { DI_CONFIG } from '../config/di.config';
import { OcrResult } from './ocr.service';

export interface LocalIngestResult extends OcrResult {
  ragDocumentId: number | null;
  reused: boolean;
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
}

export interface LocalHealth {
  ok: boolean;
  postgres: boolean;
  ollama: boolean;
  missingModels: string[];
  claimIdPresent: boolean | null;
}

/**
 * The local counterpart to OcrService: Ollama vision OCR straight into pgvector,
 * then retrieval-augmented answers from a local model. Same OcrResult shape, so
 * the caller swaps implementations without restructuring.
 */
@Injectable({ providedIn: 'root' })
export class LocalRagService {
  /** OCRs the bytes locally and indexes every page into pgvector. */
  async ingest(file: File, archiveId: number, claimId: number): Promise<LocalIngestResult> {
    const url = new URL(DI_CONFIG.local.ingestEndpoint, location.origin);
    url.searchParams.set('archiveId', String(archiveId));
    url.searchParams.set('claimId', String(claimId));
    url.searchParams.set('fileName', file.name);

    const t0 = performance.now();
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const r = await this.body(res, `Local OCR failed for ${file.name}`);
    const pages: Array<{ pageNumber: number; text: string }> = r['pages'] ?? [];
    console.log(`local OCR ${file.name}: ${pages.length} page(s), server ${r['elapsedTimeMs'] ?? '?'}ms, total ${Math.round(performance.now() - t0)}ms`);

    return {
      text: String(r['content'] ?? ''),
      // The vision model returns no per-page score, so there is nothing honest to
      // report here. The board renders "—" rather than inventing a number.
      confidence: null,
      pages: pages.length,
      raw: { pages: pages.length, avgConf: 0, lowConf: 0, lines: pages.map((p) => `[Page ${p.pageNumber}] ${p.text}`) },
      api: r,
      ragDocumentId: r['ragDocumentId'] ?? null,
      reused: r['reused'] === true,
    };
  }

  /** Embeds the prompt, searches the given documents' chunks, answers from the hits. */
  async chat(prompt: string, ragDocumentIds: number[]): Promise<LocalChatResult> {
    const res = await fetch(new URL(DI_CONFIG.local.chatEndpoint, location.origin).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, documentIds: ragDocumentIds, topK: DI_CONFIG.local.topK }),
    });
    const r = await this.body(res, 'Local analysis failed');
    return {
      reply: String(r['reply'] ?? ''),
      citations: r['citations'] ?? [],
      elapsedTimeMs: Number(r['elapsedTimeMs'] ?? 0),
    };
  }

  /**
   * Drives whether the toggle is offered at all. Pass the record id to also learn
   * whether it exists in rag.claim — ingest fails on its foreign key otherwise.
   */
  async health(claimId?: number): Promise<LocalHealth> {
    const url = new URL(DI_CONFIG.local.healthEndpoint, location.origin);
    if (claimId) url.searchParams.set('claimId', String(claimId));
    try {
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(String(res.status));
      return (await res.json()) as LocalHealth;
    } catch {
      // An unstarted server.js is the common case; report it as unavailable
      // rather than letting the failure surface later as an OCR error.
      return { ok: false, postgres: false, ollama: false, missingModels: [], claimIdPresent: null };
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
