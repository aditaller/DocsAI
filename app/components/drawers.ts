import { Component, effect, ElementRef, input, output, signal, viewChild } from '@angular/core';
import { RAW_OCR } from '../data/data';
import { Job, RawOcr, Toast } from '../models/models';
import { FileIconComponent, IconComponent } from './shared';

@Component({
  selector: 'di-raw-ocr-drawer',
  imports: [IconComponent, FileIconComponent],
  template: `
    <div class="drawer-scrim" [class.open]="!!job()" (click)="close.emit()"></div>
    <div class="drawer" [class.open]="!!job()" role="dialog" aria-label="Raw OCR output">
      @if (job(); as j) {
        <div class="drawer-head">
          <di-file-icon [type]="j.type" />
          <div class="titles">
            <div class="t">{{ j.name }}</div>
            <div class="s">Raw OCR · {{ j.confidence }}% avg confidence</div>
          </div>
          <button class="drawer-close" (click)="close.emit()" aria-label="Close"><di-icon name="close" /></button>
        </div>
        <div class="drawer-body">
          <div class="raw-stats">
            <div class="raw-stat"><div class="k">Pages</div><div class="v">{{ data()?.pages ?? j.pages }}</div></div>
            <div class="raw-stat"><div class="k">Avg Confidence</div><div class="v good">{{ data()?.avgConf ?? j.confidence }}%</div></div>
            <div class="raw-stat"><div class="k">Low-conf Tokens</div><div class="v">{{ data()?.lowConf ?? 0 }}</div></div>
          </div>
          <div class="raw-tabs">
            <button class="raw-tab" [class.active]="tab() === 'text'" (click)="tab.set('text')">Extracted Text</button>
            <button class="raw-tab" [class.active]="tab() === 'json'" (click)="tab.set('json')">Layout JSON</button>
          </div>
          @if (tab() === 'text') {
            <div class="raw-ocr-text">
              @for (ln of data()?.lines ?? []; track $index) {
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
  close = output<void>();

  tab = signal<'text' | 'json'>('text');
  data = signal<RawOcr | undefined>(undefined);

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

interface ChatMsg {
  who: 'ai' | 'user';
  text: string;
}

@Component({
  selector: 'di-chat-drawer',
  imports: [IconComponent],
  template: `
    <div class="drawer-scrim" [class.open]="open()" (click)="close.emit()"></div>
    <div class="drawer" [class.open]="open()" role="dialog" aria-label="Document chat">
      <div class="drawer-head">
        <div class="z-icon" style="width:34px;height:34px"><di-icon name="chat" [size]="17" /></div>
        <div class="titles">
          <div class="t">Chat on Documents</div>
          <div class="s">RAG · {{ docNames().length }} doc{{ docNames().length !== 1 ? 's' : '' }} in context</div>
        </div>
        <button class="drawer-close" (click)="close.emit()" aria-label="Close"><di-icon name="close" /></button>
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
              <div class="chat-bubble">{{ m.text }}</div>
            </div>
          }
        </div>
      </div>
      <div class="chat-input-bar">
        <input
          [value]="input()"
          (input)="input.set($any($event.target).value)"
          (keydown.enter)="send()"
          placeholder="Ask about these documents…"
        />
        <button class="chat-send" (click)="send()" aria-label="Send"><di-icon name="send" [size]="17" /></button>
      </div>
    </div>
  `,
})
export class ChatDrawerComponent {
  open = input.required<boolean>();
  docNames = input.required<string[]>();
  close = output<void>();

  msgs = signal<ChatMsg[]>([]);
  input = signal('');
  private body = viewChild<ElementRef<HTMLElement>>('body');

  private readonly cannedReply =
    'Based on the FNOL, the loss occurred on 2026-05-28 and was reported on 2026-06-02 — a 5-day gap that exceeds the 72-hour notification window. The estimated damage is $14,250 against a $1,000 deductible.';

  constructor() {
    effect(() => {
      if (this.open()) {
        this.msgs.set([
          { who: 'ai', text: "I've loaded the selected documents into context. Ask me anything about this claim — dates, amounts, parties, or inconsistencies." },
        ]);
        this.input.set('');
      }
    });
    effect(() => {
      this.msgs();
      const el = this.body()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });
  }

  send() {
    const q = this.input().trim();
    if (!q) return;
    this.msgs.update((m) => [...m, { who: 'user', text: q }]);
    this.input.set('');
    setTimeout(() => this.msgs.update((m) => [...m, { who: 'ai', text: this.cannedReply }]), 650);
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
