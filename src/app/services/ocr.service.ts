import { Injectable } from '@angular/core';
import { DI_CONFIG, findOcr } from '../config/di.config';
import { RawOcr } from '../models/models';

export interface OcrResult {
  text: string;
  confidence: number | null; // overall 0–100; null when the engine reports no score
  pages: number;
  totalMs: number | null; // processing time the backend reports; null when it reports none
  raw?: RawOcr;
  api?: OcrApiResponse; // full backend payload, kept for "Save OCR data"
}

/** Everything OCRFromBlob returns; persisted verbatim into gnr.archive_OCR. */
export interface OcrApiResponse {
  correlationId?: string;
  modelid?: string;
  content?: string;
  tables?: unknown;
  keyValuePairs?: unknown;
  fullResult?: unknown;
  elapsedTimeMs?: number;
  [k: string]: unknown;
}

/** Posts a file to the OCR backend and returns the recognized text. */
@Injectable({ providedIn: 'root' })
export class OcrService {
  async recognize(file: File, engineId = DI_CONFIG.ocr.defaultId, pages = '1'): Promise<OcrResult> {
    const engine = findOcr(engineId);

    const url = new URL(DI_CONFIG.ocr.endpoint);
    url.searchParams.set('modelid', engine.modelId);
    url.searchParams.set('pages', pages);

    // Send the File directly as the binary body. File extends Blob, so fetch
    // streams the bytes as-is. Content-Type overrides the File's own MIME type
    // so ASP.NET Core's [Consumes("application/octet-stream")] binding matches.
    const t0 = performance.now();
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const tHeaders = performance.now();
    if (!res.ok) throw new Error(`OCR failed for ${file.name} (${res.status} ${res.statusText})`);

    // ponytail: never log the payload itself — fullResult runs to megabytes and
    // DevTools stringifying it costs more than the OCR call.
    const r = await res.json();
    console.log(
      `OCR ${file.name}: ttfb ${Math.round(tHeaders - t0)}ms, body ${Math.round(performance.now() - tHeaders)}ms, server ${r.elapsedTimeMs ?? '?'}ms`
    );

    const body = r.text ?? r.content ?? '';
    const lines: string[] = body.split('\n');
    return {
      text: body,
      confidence: r.confidence,
      pages: r.pages,
      totalMs: typeof r.elapsedTimeMs === 'number' ? r.elapsedTimeMs : null,
      // ponytail: backend gives no per-token confidence, so lowConf stays 0.
      // Add a real count if the API starts returning token-level scores.
      raw: { pages: r.pages, avgConf: r.confidence, lowConf: 0, lines },
      api: r,
    };
  }
}
