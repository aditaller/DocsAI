import { ServiceError } from './errors.js';
import type { RenderedPage, TextPage } from './types.js';

interface OllamaGenerateResponse {
  response?: unknown;
  done_reason?: unknown;
  eval_count?: unknown;
}

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

interface OllamaChatResponse {
  message?: { content?: unknown };
  done_reason?: unknown;
}

export interface OcrEmbedder {
  recognizePage(page: RenderedPage): Promise<TextPage>;
  embed(texts: string[]): Promise<number[][]>;
}

/** Text completion, kept separate from OCR/embedding so retrieval can stub it alone. */
export interface ChatModel {
  chat(systemMessage: string, userMessage: string): Promise<string>;
}

export class OllamaClient implements OcrEmbedder, ChatModel {
  constructor(
    private readonly options: {
      baseUrl: URL;
      ocrModel: string;
      embeddingModel: string;
      dimensions: number;
      // Optional so the batch CLI, which never completes text, needs no extra
      // environment. The HTTP server refuses to start without it.
      chatModel?: string;
      /** Applies to chat only: retrieved chunks overrun Ollama's 4096 default. */
      numContext: number;
      /** Called when a page came back truncated, so the run can say so. */
      onTruncated?: (pageIndex: number) => void;
      fetchImplementation?: typeof fetch;
    },
  ) {}

  async recognizePage(page: RenderedPage): Promise<TextPage> {
    // This payload is deliberately minimal and matches a request verified by
    // hand against qwen3-vl:4b (~5s for a full page). Adding `think: false` or
    // an explicit `options.num_ctx` to it made the same model spend its whole
    // budget and return an empty body, so neither is sent here. `format: json`
    // is what keeps the reply terse: the grammar leaves no room for a preamble
    // or a reasoning monologue.
    const body = await this.post<OllamaGenerateResponse>('/api/generate', {
      model: this.options.ocrModel,
      prompt: 'extract all data',
      images: [page.bytes.toString('base64')],
      format: 'json',
      stream: false,
    });
    if (typeof body.response !== 'string') {
      throw new ServiceError('Ollama OCR response has no transcription', 'ollama', true);
    }
    const text = normalizeOcr(extractTranscription(body.response));
    if (!text) {
      throw new ServiceError(
        `Ollama returned no text for page ${page.pageIndex} (done_reason=${String(body.done_reason)}, tokens=${String(body.eval_count)}). ` +
          'A page that truly has no text aside, this usually means the output budget was exhausted — raise OLLAMA_NUM_CTX. ' +
          'JSON mode can also stall some vision models; drop `format` from recognizePage to rule that out.',
        'ollama',
        false,
      );
    }
    // Truncation still yields usable text, so this is a warning the caller can
    // see rather than a failure, but it means the page is incomplete.
    if (body.done_reason === 'length') {
      this.options.onTruncated?.(page.pageIndex);
    }
    return { pageIndex: page.pageIndex, text };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const body = await this.post<OllamaEmbedResponse>('/api/embed', {
      model: this.options.embeddingModel,
      input: texts,
      // Ask for the configured width rather than only validating what comes back.
      // Matryoshka-trained models (Qwen3-Embedding) honour this and return a
      // shorter, still-usable vector; models that ignore it are caught by the
      // dimension check below.
      dimensions: this.options.dimensions,
    });
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw new ServiceError('Ollama embedding response count does not match input', 'ollama', true);
    }
    return body.embeddings.map((embedding, index) => {
      if (!Array.isArray(embedding) || embedding.length !== this.options.dimensions || !embedding.every(Number.isFinite)) {
        throw new ServiceError(`Ollama embedding ${index} has an unexpected dimension`, 'ollama', false);
      }
      return embedding;
    });
  }

  async chat(systemMessage: string, userMessage: string): Promise<string> {
    if (!this.options.chatModel) {
      throw new ServiceError('OLLAMA_CHAT_MODEL is not configured', 'configuration', false);
    }
    const body = await this.post<OllamaChatResponse>('/api/chat', {
      model: this.options.chatModel,
      stream: false,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
      // Retrieved chunks make this prompt large; the 4096-token default would
      // truncate the context before the model ever saw the last excerpt.
      options: { num_ctx: this.options.numContext },
    });
    const content = body.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ServiceError(
        `Ollama chat returned no content (done_reason=${String(body.done_reason)}). ` +
          'A thinking model can exhaust its output budget before answering — raise OLLAMA_NUM_CTX.',
        'ollama',
        false,
      );
    }
    return content.trim();
  }

  private async post<T>(endpoint: string, body: unknown): Promise<T> {
    const fetchImplementation = this.options.fetchImplementation ?? fetch;
    let response: Response;
    try {
      response = await fetchImplementation(new URL(endpoint, this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new ServiceError(error instanceof Error ? `Ollama request failed: ${error.message}` : 'Ollama request failed', 'ollama', true);
    }
    if (!response.ok) {
      throw new ServiceError(`Ollama returned HTTP ${response.status}`, 'ollama', response.status === 408 || response.status === 429 || response.status >= 500);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ServiceError('Ollama returned invalid JSON', 'ollama', true);
    }
  }

}

/**
 * Turns a JSON-mode reply into the plain text that gets chunked and embedded.
 *
 * "extract all data" returns whatever shape the model considers natural — a
 * flat object for one page, nested objects and arrays for an invoice or a
 * table. Every leaf is flattened to a `key: value` line so nothing is dropped
 * before embedding; a value buried three levels down is exactly the sort of
 * thing a later question will ask about.
 *
 * A reply that is not JSON at all (truncated mid-escape, or plain prose) is
 * returned untouched. A page carrying stray punctuation is recoverable; a page
 * silently discarded is not.
 */
export function extractTranscription(raw: string): string {
  const trimmed = raw.trim();
  // A bare JSON string is a legal reply in JSON mode. Parsing text that merely
  // begins with a quote is safe: it either unwraps cleanly or falls through.
  if (!/^[{["]/.test(trimmed)) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return raw; // truncated or malformed — keep what the model did produce
  }

  const lines: string[] = [];
  const walk = (value: unknown, label: string): void => {
    if (value === null || value === undefined || value === '') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, label ? `${label} ${index + 1}` : String(index + 1)));
    } else if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, label ? `${label} ${key}` : key);
      }
    } else {
      lines.push(label ? `${label}: ${value}` : String(value));
    }
  };
  walk(parsed, '');
  return lines.length ? lines.join('\n') : raw;
}

/** Keeps text stable for hashing/chunking without rewriting its transcription. */
export function normalizeOcr(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
