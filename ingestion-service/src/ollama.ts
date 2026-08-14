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
      numContext: number;
      /** Send `format: "json"` on OCR calls. Not every vision model survives it. */
      ocrJsonFormat?: boolean;
      /** Called when a page came back truncated, so the run can say so. */
      onTruncated?: (pageIndex: number) => void;
      fetchImplementation?: typeof fetch;
    },
  ) {}

  async recognizePage(page: RenderedPage): Promise<TextPage> {
    const body = await this.post<OllamaGenerateResponse>('/api/generate', {
      model: this.options.ocrModel,
      stream: false,
      // Transcription needs no reasoning, and a thinking-capable model will
      // otherwise spend its whole output budget in the thinking channel and
      // return an empty `response` with done_reason "length".
      think: false,
      // Grammar-constrained JSON. Opt-in, because qwen3-vl:4b answers with a
      // full response worth of tokens and an empty body under it. The prompt
      // below asks for the same shape regardless, and extractTranscription
      // unwraps whatever arrives, so this only adds the hard constraint.
      ...(this.options.ocrJsonFormat ? { format: 'json' } : {}),
      prompt:
        'Transcribe all legible text in this document page. Preserve reading order. Do not summarize or invent text. ' +
        'Respond with a JSON object of the form {"text": "<the full transcription>"} and nothing else.',
      images: [page.bytes.toString('base64')],
      // Ollama defaults to a 4096-token context regardless of what the model
      // supports; image tokens plus a dense page overrun it easily.
      options: { num_ctx: this.options.numContext },
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
 * Unwraps the transcription from a JSON-mode reply.
 *
 * The contract asked for is `{"text": "..."}`, but a model can return a bare
 * string, a different key, or JSON truncated mid-escape. Anything unrecognised
 * falls through to the raw response: a page indexed with a little JSON syntax
 * around it is recoverable, a page silently dropped is not.
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
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string').join('\n');
  if (!parsed || typeof parsed !== 'object') return raw;

  const object = parsed as Record<string, unknown>;
  for (const key of ['text', 'transcription', 'content', 'page_text']) {
    const value = object[key];
    if (typeof value === 'string' && value.trim()) return value;
    // Some models answer with a list of lines under the same key.
    if (Array.isArray(value)) {
      const lines = value.filter((item): item is string => typeof item === 'string');
      if (lines.length) return lines.join('\n');
    }
  }
  const strings = Object.values(object).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return strings.length ? strings.join('\n') : raw;
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
