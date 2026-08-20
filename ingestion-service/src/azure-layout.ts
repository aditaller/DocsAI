import { ServiceError } from './errors.js';
import type { AnalyzedDocument, DocumentAnalyzer, FormAnswer, TextPage } from './types.js';

/**
 * Azure Document Intelligence's Layout model, running as a local container.
 *
 * It exists here for one reason the other engines cannot cover: a scanned
 * questionnaire's answers are ticks in table cells, not words. Tesseract reads
 * this project's Hebrew well and still reports nothing for those ticks, because
 * its output is a flat word stream with no table structure — a tick surfaces as
 * a stray `/` or `v` belonging to no row. Layout returns tables with cell
 * row/column indices and selection marks with their state, which is what turns
 * a page of questions into a set of answers.
 *
 * The container reads the document on this host. Only page counts leave, to the
 * Azure resource named by its `billing` argument, so the document itself never
 * crosses a network — which is why config holds it to the same loopback rule as
 * Ollama.
 */

/** DI 4.0's GA REST surface, which the layout-4.0 container implements. */
const API_VERSION = '2024-11-30';
/** Layout is CPU-bound and reads a page in seconds; this only fires on a wedged container. */
const ANALYZE_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Operation-Location polling. The container has no push channel. */
const POLL_INTERVAL_MS = 1_000;

/**
 * Hebrew for yes and no, as printed in the answer columns of the Clal
 * questionnaires this reads. Held as a pair rather than a regex so the column
 * that carries the mark can be named in the answer.
 */
const AFFIRMATIVE = 'כן';
const NEGATIVE = 'לא';

/** Layout marks a tick as `selected`; everything else is an empty cell. */
const SELECTED = 'selected';

interface LayoutSpan {
  offset: number;
  length: number;
}

interface LayoutSelectionMark {
  state?: string;
  confidence?: number;
  span?: LayoutSpan;
  polygon?: number[];
}

interface LayoutWord {
  content?: string;
  confidence?: number;
}

interface LayoutLine {
  content?: string;
}

interface LayoutPage {
  pageNumber?: number;
  lines?: LayoutLine[];
  words?: LayoutWord[];
  selectionMarks?: LayoutSelectionMark[];
}

interface LayoutCell {
  rowIndex?: number;
  columnIndex?: number;
  content?: string;
  kind?: string;
  boundingRegions?: { pageNumber?: number }[];
  spans?: LayoutSpan[];
}

interface LayoutTable {
  rowCount?: number;
  columnCount?: number;
  cells?: LayoutCell[];
  boundingRegions?: { pageNumber?: number }[];
}

interface AnalyzeResult {
  content?: string;
  pages?: LayoutPage[];
  tables?: LayoutTable[];
}

interface AnalyzeResponse {
  status?: string;
  error?: { message?: string };
  analyzeResult?: AnalyzeResult;
}

export interface AzureLayoutOptions {
  baseUrl: URL;
  fetchImplementation?: typeof fetch;
  /** Injected in tests so polling does not spend real time. */
  sleep?: (ms: number) => Promise<void>;
}

export class AzureLayoutClient implements DocumentAnalyzer {
  constructor(private readonly options: AzureLayoutOptions) {}

  /**
   * Health probe, matching TesseractClient.version() and PdfRenderer.version():
   * a container that is not up should surface on the health banner rather than
   * on someone's first upload.
   */
  async version(): Promise<void> {
    const response = await this.send(new URL('/ready', this.options.baseUrl), { method: 'GET' });
    if (!response.ok) {
      throw new ServiceError(`Azure Layout container returned HTTP ${response.status}`, 'azure_layout', true);
    }
  }

  async analyzeDocument(bytes: Buffer, mimeType: string): Promise<AnalyzedDocument> {
    const result = await this.analyze(bytes, mimeType);
    return { pages: toTextPages(result), answers: toAnswers(result) };
  }

  private async analyze(bytes: Buffer, mimeType: string): Promise<AnalyzeResult> {
    const url = new URL(
      `/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${API_VERSION}`,
      this.options.baseUrl,
    );
    const submitted = await this.send(url, {
      method: 'POST',
      headers: { 'content-type': mimeType },
      body: new Uint8Array(bytes),
    });
    if (submitted.status !== 202) {
      throw new ServiceError(
        `Azure Layout returned HTTP ${submitted.status} on submit`,
        'azure_layout',
        submitted.status === 429 || submitted.status >= 500,
      );
    }
    const operation = submitted.headers.get('operation-location');
    if (!operation) {
      throw new ServiceError('Azure Layout returned no Operation-Location', 'azure_layout', true);
    }
    return this.poll(new URL(operation));
  }

  /**
   * Analyze is asynchronous even in the container: submit returns 202 and the
   * result appears at Operation-Location once the model finishes.
   */
  private async poll(operation: URL): Promise<AnalyzeResult> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + ANALYZE_TIMEOUT_MS;
    for (;;) {
      const response = await this.send(operation, { method: 'GET' });
      if (!response.ok) {
        throw new ServiceError(
          `Azure Layout returned HTTP ${response.status} while polling`,
          'azure_layout',
          response.status === 429 || response.status >= 500,
        );
      }
      let body: AnalyzeResponse;
      try {
        body = (await response.json()) as AnalyzeResponse;
      } catch {
        throw new ServiceError('Azure Layout returned invalid JSON', 'azure_layout', true);
      }
      const status = body.status ?? 'unknown';
      if (status === 'succeeded') {
        if (!body.analyzeResult) {
          throw new ServiceError('Azure Layout succeeded with no analyzeResult', 'azure_layout', true);
        }
        return body.analyzeResult;
      }
      if (status === 'failed') {
        // The container's message can quote document text. Report the status
        // only: OCR text must never reach a log or a PostgreSQL run record.
        throw new ServiceError('Azure Layout failed to analyze the document', 'azure_layout', false);
      }
      if (Date.now() > deadline) {
        throw new ServiceError('Azure Layout did not finish before the timeout', 'azure_layout', true);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private async send(url: URL, init: RequestInit): Promise<Response> {
    const call = this.options.fetchImplementation ?? fetch;
    try {
      return await call(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new ServiceError(
        error instanceof Error ? `Azure Layout request failed: ${error.message}` : 'Azure Layout request failed',
        'azure_layout',
        true,
      );
    }
  }
}

/**
 * Layout's pages into the shape the rest of the pipeline already stores.
 *
 * Confidence is the mean of the per-word scores, the same convention
 * parseTesseractTsv uses, so the two engines' numbers mean the same thing on
 * the UI. Layout scores words but not lines, and the text is rebuilt from
 * lines, so the two are read from different arrays of the same page.
 */
export function toTextPages(result: AnalyzeResult): TextPage[] {
  return (result.pages ?? []).map((page, offset) => {
    const scores = (page.words ?? [])
      .map((word) => word.confidence)
      .filter((score): score is number => typeof score === 'number');
    return {
      pageIndex: page.pageNumber ?? offset + 1,
      text: (page.lines ?? [])
        .map((line) => line.content ?? '')
        .filter((line) => line.length > 0)
        .join('\n'),
      confidence: scores.length ? scores.reduce((total, score) => total + score, 0) / scores.length : null,
    };
  });
}

/**
 * The answers a candidate marked, read off Layout's tables.
 *
 * These forms are right-to-left: the question sits in the widest, rightmost
 * cell of its row and the two answer cells (כן, לא) are the leftmost pair. The
 * header row names them, which is what fixes the mapping rather than assuming
 * an order — the layout is only conventional, and a form that swaps the columns
 * would otherwise invert every answer silently.
 *
 * A row whose answer cells are blank produced no answer at all and is skipped:
 * an unanswered question is not a negative one, and recording it as `לא` would
 * invent a declaration the candidate never made.
 */
export function toAnswers(result: AnalyzeResult): FormAnswer[] {
  const answers: FormAnswer[] = [];
  for (const table of result.tables ?? []) {
    const cells = table.cells ?? [];
    if (cells.length === 0) continue;
    const columns = answerColumns(cells);
    if (!columns) continue;

    const page = table.boundingRegions?.[0]?.pageNumber ?? 1;
    for (const [rowIndex, row] of groupRows(cells)) {
      if (rowIndex === columns.headerRow) continue;
      const affirmative = row.find((cell) => cell.columnIndex === columns.affirmative);
      const negative = row.find((cell) => cell.columnIndex === columns.negative);
      const marked = isSelected(affirmative) ? AFFIRMATIVE : isSelected(negative) ? NEGATIVE : null;
      if (!marked) continue;

      const question = questionCell(row, columns);
      if (!question) continue;
      const { label, text } = splitLabel(question.content ?? '');
      if (!text) continue;
      answers.push({
        page: question.boundingRegions?.[0]?.pageNumber ?? page,
        label,
        text,
        kind: 'boolean',
        value: marked,
        confidence: null,
      });
    }
  }
  return answers;
}

/**
 * Which column is כן and which is לא, read from the header row rather than
 * assumed. Returns null for any table without both, which is how a table that
 * is not an answer grid — a details block, a footer — is left alone.
 */
function answerColumns(
  cells: LayoutCell[],
): { affirmative: number; negative: number; headerRow: number } | null {
  for (const cell of cells) {
    if (normalize(cell.content) !== AFFIRMATIVE) continue;
    const row = cell.rowIndex ?? 0;
    const negative = cells.find(
      (candidate) => candidate.rowIndex === row && normalize(candidate.content) === NEGATIVE,
    );
    if (negative && typeof cell.columnIndex === 'number' && typeof negative.columnIndex === 'number') {
      return { affirmative: cell.columnIndex, negative: negative.columnIndex, headerRow: row };
    }
  }
  return null;
}

function groupRows(cells: LayoutCell[]): Map<number, LayoutCell[]> {
  const rows = new Map<number, LayoutCell[]>();
  for (const cell of cells) {
    const index = cell.rowIndex ?? 0;
    const row = rows.get(index);
    if (row) row.push(cell);
    else rows.set(index, [cell]);
  }
  return rows;
}

/**
 * The question is the row's remaining content: whichever cell is neither answer
 * column and actually carries text. Picking the longest guards against a row
 * split into a number cell and a text cell, where the number alone would be a
 * useless label.
 */
function questionCell(
  row: LayoutCell[],
  columns: { affirmative: number; negative: number },
): LayoutCell | undefined {
  return row
    .filter((cell) => cell.columnIndex !== columns.affirmative && cell.columnIndex !== columns.negative)
    .filter((cell) => normalize(cell.content).length > 0)
    .sort((left, right) => normalize(right.content).length - normalize(left.content).length)[0];
}

/**
 * `1.5.1 האם ערכי הסוכר...` into its printed number and the question itself.
 * The number is what an underwriter cites, and it is worth keeping separate
 * even though Layout returns the cell as one string.
 */
export function splitLabel(content: string): { label: string; text: string } {
  const trimmed = normalize(content);
  // Hebrew sub-clauses are lettered (`1.א`) as often as numbered (`1.5.1`), and
  // the trailing dot is part of the printed label rather than the question.
  const match = /^([0-9]+(?:\.[0-9֐-׿]+)*)\.?\s+(.*)$/su.exec(trimmed);
  if (!match) return { label: '', text: trimmed };
  return { label: match[1] ?? '', text: (match[2] ?? '').trim() };
}

function isSelected(cell: LayoutCell | undefined): boolean {
  if (!cell) return false;
  // Layout puts the mark's state in the cell content as `:selected:` /
  // `:unselected:` when the cell holds nothing else.
  return /:selected:/u.test(cell.content ?? '');
}

function normalize(content: string | undefined): string {
  return (content ?? '').replace(/:(?:un)?selected:/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * The answers as a block of text appended to the page they came from.
 *
 * Retrieval only ever sees `documentchunk.contenttext`, so an answer that lives
 * solely in a `rag.documentfield` row cannot be found by asking a question in
 * the chat drawer. Writing it back into the page text is what makes "which
 * questions were answered yes?" a retrievable question. Generated from the
 * parsed answers rather than by a model, so it cannot invent one.
 */
export function describeAnswers(pageIndex: number, answers: FormAnswer[]): string {
  const forPage = answers.filter((answer) => answer.page === pageIndex);
  if (forPage.length === 0) return '';
  const affirmative = forPage.filter((answer) => answer.value === AFFIRMATIVE);
  const lines = forPage.map((answer) =>
    answer.label ? `${answer.label} ${answer.text} — ${answer.value}` : `${answer.text} — ${answer.value}`,
  );
  const summary = affirmative.length
    ? `שאלות שנענו בחיוב: ${affirmative.map((answer) => answer.label || answer.text).join(', ')}`
    : 'לא נענתה אף שאלה בחיוב.';
  return [`תשובות שסומנו בעמוד ${pageIndex}:`, ...lines, summary].join('\n');
}
