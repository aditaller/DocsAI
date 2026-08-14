import { ServiceError } from './errors.js';
import type { RenderedPage, TextPage } from './types.js';

interface OllamaGenerateResponse {
  response?: unknown;
}

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

interface OllamaChatResponse {
  message?: { content?: unknown };
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
      fetchImplementation?: typeof fetch;
    },
  ) {}

  async recognizePage(page: RenderedPage): Promise<TextPage> {
    const body = await this.post<OllamaGenerateResponse>('/api/generate', {
      model: this.options.ocrModel,
      stream: false,
      prompt: 'Transcribe all legible text in this document page. Preserve reading order. Return only the transcription; do not summarize or invent text.',
      images: [page.bytes.toString('base64')],
    });
    if (typeof body.response !== 'string') {
      throw new ServiceError('Ollama OCR response has no transcription', 'ollama', true);
    }
    return { pageIndex: page.pageIndex, text: normalizeOcr(body.response) };
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
    });
    const content = body.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ServiceError('Ollama chat response has no content', 'ollama', true);
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

/** Keeps text stable for hashing/chunking without rewriting its transcription. */
export function normalizeOcr(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
