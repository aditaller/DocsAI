import { Injectable } from '@angular/core';
import { DI_CONFIG, findOcr } from '../config/di.config';
import { RawOcr } from '../models/models';

export interface OcrResult {
  text: string;
  confidence: number; // overall 0–100
  pages: number;
  raw?: RawOcr;
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
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error(`OCR failed for ${file.name} (${res.status} ${res.statusText})`);
    console.log(`OCR succeeded for ${file.name} (${res.status} ${res.statusText})`);
    
    //console.log(`response: ${await res.text()}`);
    const text = await res.text();
    console.log(`response text: ${text}`);
    const r = JSON.parse(text);

    const lines: string[] = (r.text ?? '').split('\n');
    return {
      text: r.text,
      confidence: r.confidence,
      pages: r.pages,
      // ponytail: backend gives no per-token confidence, so lowConf stays 0.
      // Add a real count if the API starts returning token-level scores.
      raw: { pages: r.pages, avgConf: r.confidence, lowConf: 0, lines },
    };
  }
}
