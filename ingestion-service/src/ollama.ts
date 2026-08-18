import { ServiceError } from './errors.js';
import type { PageRecognizer, RenderedPage, TextPage } from './types.js';

interface OllamaGenerateResponse {
  response?: unknown;
  done_reason?: unknown;
  eval_count?: unknown;
  logprobs?: unknown;
}

interface OllamaEmbedResponse {
  embeddings?: unknown;
}

interface OllamaChatResponse {
  message?: { content?: unknown; thinking?: unknown };
  done_reason?: unknown;
  /** Tokens Ollama actually read from the prompt. Only the final frame carries it. */
  prompt_eval_count?: unknown;
}

// A streamed answer emits tokens the whole time, so the ceiling is total answer
// length rather than time-to-first-byte. The buffered OCR call shares it.
const REQUEST_TIMEOUT_MS = 600_000;
const DEFAULT_KEEP_ALIVE = '1h';

/** Yields complete newline-delimited lines from a streamed response body. */
async function* readLines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new ServiceError('Ollama returned no response body', 'ollama', true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    // A chunk boundary can fall mid-line, so only complete lines are emitted
    // and the remainder is carried into the next read.
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield line;
    }
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}

const OCR_PROMPT =
  'Transcribe every piece of text in this page image. Begin the reply with one line ' +
  '"Language: <the language the document is written in>", then the transcription.';

/** Reads the `Language:` line the OCR prompt asks for. Null when the model skipped it. */
export function detectLanguage(pageText: string): string | null {
  // `[ \t]` rather than `\s`, so a bare "Language:" cannot swallow the newline and
  // report the first transcribed line as the language.
  return /^[ \t]*Language:[ \t]*(.+)$/im.exec(pageText)?.[1]?.trim() || null;
}

/**
 * Turns Ollama's per-token logprobs into one 0–1 page score: exp(mean logprob),
 * the geometric mean of the token probabilities. A page the model transcribed
 * confidently sits near 1; a page it guessed its way through drops fast, because
 * one very unsure token pulls the whole mean down.
 *
 * Null when the reply carries no usable logprobs — an older Ollama, or a build
 * that ignores the flag. Inventing a number there would be worse than "—".
 */
export function meanTokenProbability(logprobs: unknown): number | null {
  if (!Array.isArray(logprobs)) return null;
  const values = logprobs
    .map((entry) => (entry as { logprob?: unknown } | null)?.logprob)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return null;
  return Math.exp(values.reduce((total, value) => total + value, 0) / values.length);
}

/** 0–1 model score to the 0–100 the UI and Azure Document Intelligence both speak. */
export function toPercent(confidence: number | null | undefined): number | null {
  return typeof confidence === 'number' && Number.isFinite(confidence) ? Math.round(confidence * 1000) / 10 : null;
}

/** Document score: the mean over the pages that carry one, null when none do. */
export function averageConfidence(pages: TextPage[]): number | null {
  const scored = pages.map((page) => page.confidence).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return scored.length ? toPercent(scored.reduce((total, value) => total + value, 0) / scored.length) : null;
}

export interface OcrEmbedder extends PageRecognizer {
  embed(texts: string[]): Promise<number[][]>;
}

/** Text completion, kept separate from OCR/embedding so retrieval can stub it alone. */
export interface ChatModel {
  chat(systemMessage: string, userMessage: string, onToken?: (token: string, thinking: boolean) => void): Promise<string>;
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
      /** Retrieved chunks, and a vision model's reasoning, overrun Ollama's 4096 default. */
      numContext: number;
      /** How long Ollama holds each model in VRAM between calls (OLLAMA_KEEP_ALIVE). */
      keepAlive?: string;
      /** Called when a page came back truncated, so the run can say so. */
      onTruncated?: (pageIndex: number) => void;
      /**
       * Real prompt token count for a completed chat. The context budget can only
       * estimate tokens from characters, so this is how the estimate gets checked
       * against what Ollama actually read.
       */
      onPromptTokens?: (tokens: number) => void;
      fetchImplementation?: typeof fetch;
    },
  ) {}

  async recognizePage(page: RenderedPage): Promise<TextPage> {
    // No `format: json` here. qwen3-vl is a reasoning model, and with the JSON
    // grammar attached it spends the whole turn in `thinking` and returns an
    // empty `response` — measured against qwen3-vl:4b, 1382 thinking tokens and
    // zero response tokens on a page it transcribes fine without the grammar.
    // `think: false` and a raised num_ctx are what keep the budget on the
    // transcription: the same page came back `done_reason=length` with nothing
    // in `response` at Ollama's 4096 default.
    const body = await this.post<OllamaGenerateResponse>('/api/generate', {
      model: this.options.ocrModel,
      // The `Language:` line is what tells the caller which script the document is
      // in — nothing downstream can tell Hebrew from Arabic once the text is
      // chunked. It costs one line of transcription and is indexed with the page.
      prompt: OCR_PROMPT,
      images: [page.bytes.toString('base64')],
      stream: false,
      think: false,
      // The only confidence signal a vision model gives: how sure it was of each
      // token it emitted. Ollama builds older than the logprobs support simply
      // ignore this and return none, which reports as "no score" rather than failing.
      logprobs: true,
      options: { num_ctx: this.options.numContext },
    });
    if (typeof body.response !== 'string') {
      throw new ServiceError('Ollama OCR response has no transcription', 'ollama', true);
    }
    const text = normalizeOcr(extractTranscription(body.response));
    if (!text) {
      throw new ServiceError(
        `Ollama returned no text for page ${page.pageIndex} (done_reason=${String(body.done_reason)}, tokens=${String(body.eval_count)}). ` +
          'A page that truly has no text aside, this usually means the model spent its budget on reasoning instead of ' +
          'transcription — raise OLLAMA_NUM_CTX, or try a non-reasoning vision model.',
        'ollama',
        false,
      );
    }
    // Truncation still yields usable text, so this is a warning the caller can
    // see rather than a failure, but it means the page is incomplete.
    if (body.done_reason === 'length') {
      this.options.onTruncated?.(page.pageIndex);
    }
    return { pageIndex: page.pageIndex, text, confidence: meanTokenProbability(body.logprobs) };
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

  /**
   * Always streams. A full-document answer runs to thousands of tokens, and
   * buffering it meant the caller stared at nothing for over a minute; `onToken`
   * lets the HTTP layer forward each fragment as it lands. The accumulated text
   * is still returned, so a caller that does not care about progress passes no
   * callback and reads the result exactly as before.
   *
   * A reasoning model emits its reasoning first, on a separate `thinking` field,
   * and only then the answer. Measured on gpt-oss:20b over one page: first
   * thinking token at 1.1s, first content token at 13.7s. Forwarding only the
   * content would leave the caller with a blank screen for that whole stretch,
   * so reasoning is reported too — flagged, so it is never mistaken for answer
   * text or returned as the reply.
   */
  async chat(
    systemMessage: string,
    userMessage: string,
    onToken?: (token: string, thinking: boolean) => void,
  ): Promise<string> {
    if (!this.options.chatModel) {
      throw new ServiceError('OLLAMA_CHAT_MODEL is not configured', 'configuration', false);
    }
    const response = await this.send('/api/chat', {
      model: this.options.chatModel,
      stream: true,
      nothink:true,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessage },
      ],
      // A whole document makes this prompt large; the 4096-token default would
      // truncate the context before the model ever saw the last page.
      options: { num_ctx: this.options.numContext },
    });

    let content = '';
    let doneReason: unknown;
    let promptTokens: number | undefined;
    // Ollama streams NDJSON, one object per line, and a chunk boundary can fall
    // mid-line — so the tail is carried over rather than parsed.
    for await (const line of readLines(response)) {
      let frame: OllamaChatResponse;
      try {
        frame = JSON.parse(line) as OllamaChatResponse;
      } catch {
        continue; // a keep-alive blank or a partial trailing line
      }
      if (frame.done_reason !== undefined) doneReason = frame.done_reason;
      if (typeof frame.prompt_eval_count === 'number') promptTokens = frame.prompt_eval_count;
      const reasoning = frame.message?.thinking;
      if (typeof reasoning === 'string' && reasoning) onToken?.(reasoning, true);
      const token = frame.message?.content;
      if (typeof token === 'string' && token) {
        content += token;
        onToken?.(token, false);
      }
    }

    // Reported after the stream, not during: only the final frame carries it, and
    // it is the one number that shows whether the character-based context budget
    // matched what the model actually read.
    if (promptTokens !== undefined) this.options.onPromptTokens?.(promptTokens);

    if (!content.trim()) {
      throw new ServiceError(
        `Ollama chat returned no content (done_reason=${String(doneReason)}). ` +
          'A thinking model can exhaust its output budget before answering — raise OLLAMA_NUM_CTX.',
        'ollama',
        false,
      );
    }
    return content.trim();
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.send(endpoint, body);
    try {
      return (await response.json()) as T;
    } catch {
      throw new ServiceError('Ollama returned invalid JSON', 'ollama', true);
    }
  }

  /** Shared request/error handling for both the buffered and the streamed reads. */
  private async send(endpoint: string, body: Record<string, unknown>): Promise<Response> {
    const fetchImplementation = this.options.fetchImplementation ?? fetch;
    let response: Response;
    try {
      response = await fetchImplementation(new URL(endpoint, this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A batch run alternates OCR / embed / chat models. Ollama's 5m default
        // unloads each one between turns, so every page pays the reload.
        body: JSON.stringify({ ...body, keep_alive: this.options.keepAlive ?? DEFAULT_KEEP_ALIVE }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ServiceError(error instanceof Error ? `Ollama request failed: ${error.message}` : 'Ollama request failed', 'ollama', true);
    }
    if (!response.ok) {
      throw new ServiceError(`Ollama returned HTTP ${response.status}`, 'ollama', response.status === 408 || response.status === 429 || response.status >= 500);
    }
    return response;
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
