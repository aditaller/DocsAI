import { Component, computed, effect, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { RAW_OCR } from '../data/data';
import { Job, RawOcr, THINKING_PREFIX, Toast } from '../models/models';
import { directionOf, FileIconComponent, IconComponent, linkifyPages, readPageClick, renderMarkdown } from './shared';

@Component({
  selector: 'di-raw-ocr-drawer',
  imports: [IconComponent, FileIconComponent],
  template: `
    <div class="drawer-scrim" data-testid="raw-drawer-scrim" [class.open]="!!job()" (click)="close.emit()"></div>
    <div class="drawer" [class.open]="!!job()" role="dialog" aria-label="Raw OCR output">
      @if (job(); as j) {
        <div class="drawer-head">
          <di-file-icon [type]="j.type" />
          <div class="titles">
            <div class="t">{{ j.name }}</div>
            <div class="s">Raw OCR · {{ j.confidence }}% avg confidence{{ pageLabel() }}</div>
          </div>
          <button class="drawer-close" data-testid="raw-drawer-close" (click)="close.emit()" aria-label="Close"><di-icon name="close" /></button>
        </div>
        <div class="drawer-body">
          <div class="raw-stats">
            <div class="raw-stat"><div class="k">Pages</div><div class="v">{{ data()?.pages ?? j.pages }}</div></div>
            <div class="raw-stat"><div class="k">Avg Confidence</div><div class="v good">{{ data()?.avgConf ?? j.confidence }}%</div></div>
            <div class="raw-stat"><div class="k">Low-conf Tokens</div><div class="v">{{ data()?.lowConf ?? 0 }}</div></div>
          </div>
          <div class="raw-tabs">
            <button class="raw-tab" data-testid="raw-tab-text" [class.active]="tab() === 'text'" (click)="tab.set('text')">Extracted Text</button>
            <button class="raw-tab" data-testid="raw-tab-json" [class.active]="tab() === 'json'" (click)="tab.set('json')">Layout JSON</button>
          </div>
          @if (tab() === 'text') {
            <div class="raw-ocr-text">
              @for (ln of lines(); track $index) {
                <div class="raw-line">
                  <span class="ln">{{ pad($index + 1) }}</span>
                  <span style="flex:1" [innerHTML]="ln || '&nbsp;'"></span>
                </div>
              }
            </div>
          } @else {
            <div class="raw-ocr-text"><span class="field">{{ '{' }}</span>
  "modelId": "{{ ocrModelId() }}",
  "pages": {{ data()?.pages ?? j.pages }},
  "confidence": {{ (data()?.avgConf ?? j.confidence ?? 0) / 100 }},
  "keyValuePairs": [
    {{ '{' }} "key": "Policy No", "value": "POL-2024-44910", "conf": 0.994 {{ '}' }},
    {{ '{' }} "key": "Date of Loss", "value": "2026-05-28", "conf": 0.981 {{ '}' }},
    {{ '{' }} "key": "Est. Damage", "value": "$14,250.00", "conf": 0.977 {{ '}' }}
  ]
<span class="field">{{ '}' }}</span></div>
          }
        </div>
      }
    </div>
  `,
})
export class RawOcrDrawerComponent {
  job = input.required<Job | null>();
  ocrModelId = input<string>('prebuilt-document');
  /** Page range to show alone, from a clicked page reference in an answer. */
  pages = input<[number, number] | null>(null);
  close = output<void>();

  tab = signal<'text' | 'json'>('text');
  data = signal<RawOcr | undefined>(undefined);

  /**
   * Local ingest writes one line per page, prefixed `[Page N]`; that marker is what
   * a page range filters on. Cloud OCR has no markers, so nothing matches and the
   * whole text stays — better than an empty drawer.
   */
  private picked = computed(() => {
    const all = this.data()?.lines ?? [];
    const range = this.pages();
    if (!range) return null;
    const hits = all.filter((l) => {
      const m = /^\[Page (\d+)\]/.exec(l);
      return !!m && +m[1] >= range[0] && +m[1] <= range[1];
    });
    return hits.length ? hits : null;
  });
  lines = computed(() => this.picked() ?? this.data()?.lines ?? []);
  pageLabel = computed(() => {
    const range = this.pages();
    if (!range || !this.picked()) return '';
    return range[0] === range[1] ? ` · page ${range[0]}` : ` · pages ${range[0]}–${range[1]}`;
  });

  constructor() {
    effect(() => {
      const j = this.job();
      this.tab.set('text');
      this.data.set(j?.raw ?? (j ? RAW_OCR[j.jobId] : undefined));
    });
  }

  pad(n: number) {
    return String(n).padStart(2, '0');
  }
}

/**
 * One axis of a dragged panel, held inside the viewport. A panel wider or taller
 * than the viewport is pinned at 0 rather than clamped to a negative range, so
 * it can never be pushed out of reach in the axis it does not fit.
 */
const clampWithin = (v: number, size: number, viewport: number) =>
  Math.min(Math.max(v, Math.min(0, viewport - size)), Math.max(0, viewport - size));

interface ChatMsg {
  who: 'ai' | 'user';
  text: string;
  /** Settled from the question, so an answer to a Hebrew prompt lays out RTL
      whatever character its markup happens to begin with. */
  dir: 'rtl' | 'ltr';
}

@Component({
  selector: 'di-chat-drawer',
  imports: [IconComponent],
  template: `
    <div class="drawer-scrim" data-testid="chat-drawer-scrim" [class.open]="open()" (click)="close.emit()"></div>
    <div
      class="drawer chat-panel"
      data-testid="chat-panel"
      [class.open]="open()"
      [class.dragging]="dragging()"
      [style.left.px]="pos()?.x"
      [style.top.px]="pos()?.y"
      [style.right]="pos() ? 'auto' : null"
      role="dialog"
      aria-label="Document chat"
    >
      <div
        class="drawer-head"
        data-testid="chat-drag-handle"
        title="Drag to move · double-click to snap back · drag the bottom corner to resize"
        (pointerdown)="startDrag($event)"
        (pointermove)="onDrag($event)"
        (pointerup)="endDrag($event)"
        (pointercancel)="endDrag($event)"
        (dblclick)="pos.set(null)"
      >
        <div class="z-icon" style="width:34px;height:34px"><di-icon name="chat" [size]="17" /></div>
        <div class="titles">
          <div class="t">Chat on Documents</div>
          <div class="s">RAG · {{ docNames().length }} doc{{ docNames().length !== 1 ? 's' : '' }} in context</div>
        </div>
        <button class="drawer-close" data-testid="chat-drawer-close" (click)="close.emit()" aria-label="Close"><di-icon name="close" /></button>
      </div>
      <div class="drawer-body" #body>
        <div class="chat-ctx">
          <di-icon name="layers" [size]="14" />
          Context: {{ docNames().join(', ') || '—' }}
        </div>
        <div class="chat-msgs">
          @for (m of msgs(); track $index) {
            <div class="chat-msg {{ m.who }}">
              <div class="chat-av {{ m.who }}">
                @if (m.who === 'ai') { <di-icon name="sparkles" [size]="15" /> } @else { DO }
              </div>
              @if (m.who === 'ai') {
                <div class="chat-bubble" [dir]="m.dir" [innerHTML]="linked(m.text)" (click)="onBubbleClick($event)"></div>
              } @else {
                <div class="chat-bubble" [dir]="m.dir">{{ m.text }}</div>
              }
            </div>
          }
          @if (pending()) {
            <div class="chat-msg ai">
              <div class="chat-av ai"><di-icon name="sparkles" [size]="15" /></div>
              <div class="chat-bubble">Searching the documents…</div>
            </div>
          }
        </div>
      </div>
      <div class="chat-input-bar">
        <input
          data-testid="chat-input"
          [value]="input()"
          [disabled]="pending()"
          (input)="input.set($any($event.target).value)"
          (keydown.enter)="send()"
          placeholder="Ask about these documents…"
        />
        <button class="chat-send" data-testid="chat-send" [disabled]="pending()" (click)="send()" aria-label="Send"><di-icon name="send" [size]="17" /></button>
      </div>
    </div>
  `,
})
export class ChatDrawerComponent {
  open = input.required<boolean>();
  docNames = input.required<string[]>();
  /** Answers a question over the documents in context. `onPartial` streams the reply as it is written. */
  ask = input.required<(question: string, onPartial?: (partial: string) => void) => Promise<string>>();
  /** Docs whose original can be fetched and opened; only those get a link. */
  openableDocNames = input<string[]>([]);
  close = output<void>();
  /** Same page-reference contract as the analysis result: open the original at that page. */
  openOriginal = output<{ docName: string; page: number }>();

  /**
   * Rendered as real markup, so a model answering with a table or a list shows
   * as one rather than as literal tags — markdown included, which is what the
   * chat model actually writes: see renderMarkdown. Deliberately NOT escaped —
   * but also not passed through bypassSecurityTrustHtml, so Angular's own
   * sanitizer still runs on [innerHTML] and strips <script>, event handlers and
   * javascript: URLs.
   *
   * That boundary matters here: this text is a model's summary of OCR'd archive
   * documents, which are untrusted input. Sanitized HTML is the widest this may
   * ever get — anything that trusts the string directly reopens XSS through a
   * poisoned document.
   */
  // Page references are linked on the markdown, then the whole answer is
  // rendered: an anchor passes through renderMarkdown untouched, while matching
  // page numbers inside generated href/title attributes cannot happen.
  linked = (text: string) => renderMarkdown(linkifyPages(text, this.docNames(), this.openableDocNames()));

  onBubbleClick(e: MouseEvent) {
    const hit = readPageClick(e, this.docNames());
    if (hit) this.openOriginal.emit(hit);
  }

  msgs = signal<ChatMsg[]>([]);
  input = signal('');
  pending = signal(false);
  private body = viewChild<ElementRef<HTMLElement>>('body');

  /* ---- Move and resize ----
     The panel is read side by side with the document it is about, so it has to
     get out of the way. Resizing is CSS `resize` on .chat-panel — no code at
     all; only the move needs any, because nothing native drags an element.

     Position survives closing and reopening: having placed the panel once, an
     operator does not want it back over the document on the next question.
     Double-clicking the header snaps it back to the right edge.

     ponytail: inline left/top and the pointer events, no drag library and no
     ghost element. */
  pos = signal<{ x: number; y: number } | null>(null);
  dragging = signal(false);
  private grab: { dx: number; dy: number; w: number; h: number } | null = null;

  startDrag(e: PointerEvent) {
    // The close button lives in the header; a click on it is not a drag.
    if ((e.target as HTMLElement).closest('button')) return;
    const head = e.currentTarget as HTMLElement;
    const panel = head.closest('.chat-panel') as HTMLElement | null;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    // Measured rather than read from pos(): the first drag starts from the
    // right-edge default, which has no left/top of its own yet.
    this.grab = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height };
    this.pos.set({ x: r.left, y: r.top });
    this.dragging.set(true);
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  onDrag(e: PointerEvent) {
    const g = this.grab;
    if (!g) return;
    // Clamped to keep the whole panel on screen, so the header stays grabbable
    // and the input bar never lands past the bottom edge. An axis with no room
    // left simply does not move: a full-height panel slides sideways until it
    // is resized, which is also what the header's tooltip says.
    this.pos.set({
      x: clampWithin(e.clientX - g.dx, g.w, window.innerWidth),
      y: clampWithin(e.clientY - g.dy, g.h, window.innerHeight),
    });
  }

  endDrag(e: PointerEvent) {
    if (!this.grab) return;
    this.grab = null;
    this.dragging.set(false);
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  }

  constructor() {
    effect(() => {
      if (this.open()) {
        this.msgs.set([
          {
            who: 'ai',
            text: "I've loaded the selected documents into context. Ask me anything about this claim — dates, amounts, parties, or inconsistencies.",
            dir: 'ltr',
          },
        ]);
        this.input.set('');
        this.pending.set(false);
      }
    });
    effect(() => {
      this.msgs();
      const el = this.body()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  async send() {
    const q = this.input().trim();
    if (!q || this.pending()) return;
    // Asked in Hebrew, answered in Hebrew: the whole turn lays out RTL, including
    // any table or list the model returns. Read off the question rather than the
    // reply, so a Hebrew answer opening with a claim number still reads right.
    const dir = directionOf(q);
    this.msgs.update((m) => [...m, { who: 'user', text: q, dir }]);
    this.input.set('');
    this.pending.set(true);
    // One placeholder bubble, rewritten in place as tokens arrive, so the answer
    // reads as it is written instead of appearing all at once at the end.
    let streaming = false;
    const replaceLast = (text: string) => this.msgs.update((m) => [...m.slice(0, -1), { who: 'ai', text, dir }]);
    try {
      const reply = await this.ask()(q, (partial) => {
        // Reasoning arrives before the answer; show only its tail so the bubble
        // stays a progress indicator rather than a wall of the model's notes.
        const text = partial.startsWith(THINKING_PREFIX)
          ? `${THINKING_PREFIX}${partial.slice(THINKING_PREFIX.length).replace(/\s+/g, ' ').trim().slice(-140)}`
          : partial;
        if (!streaming) {
          streaming = true;
          this.msgs.update((m) => [...m, { who: 'ai', text, dir }]);
        } else {
          replaceLast(text);
        }
      });
      const text = reply || 'No answer came back for that question.';
      if (streaming) replaceLast(text);
      else this.msgs.update((m) => [...m, { who: 'ai', text, dir }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The question failed.';
      // Keep whatever was already streamed and say it was cut short, rather than
      // replacing a partial answer with a bare error.
      if (streaming) this.msgs.update((m) => [...m, { who: 'ai', text: `⚠ ${message}`, dir }]);
      else this.msgs.update((m) => [...m, { who: 'ai', text: message, dir }]);
    } finally {
      this.pending.set(false);
    }
  }
}

@Component({
  selector: 'di-toasts',
  imports: [IconComponent],
  template: `
    <div class="toast-wrap">
      @for (t of toasts(); track t.id) {
        <div class="toast {{ t.kind || 'info' }}">
          <span class="ti"><di-icon [name]="t.kind === 'success' ? 'check' : 'info'" [size]="16" /></span>
          {{ t.text }}
        </div>
      }
    </div>
  `,
})
export class ToastsComponent {
  toasts = input.required<Toast[]>();
}
