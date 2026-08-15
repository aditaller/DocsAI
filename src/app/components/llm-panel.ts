import { Component, computed, input, output } from '@angular/core';
import { TEMPLATES } from '../data/data';
import { DI_CONFIG } from '../config/di.config';
import { AnalysisResponse, Job } from '../models/models';
import { IconComponent } from './shared';

@Component({
  selector: 'di-llm-panel',
  imports: [IconComponent],
  template: `
    <section class="zone">
      <div class="zone-mark"><span class="n">02</span><span class="l">Analysis</span></div>
      <div class="zone-head">
        <div class="z-icon"><di-icon name="sparkles" [size]="16" /></div>
        <div>
          <div class="z-title">Instructions</div>
          <div class="z-sub">Select completed documents, then describe what to extract</div>
        </div>
      </div>
      <div class="zone-body">
        <div class="field-label">
          Documents
          <span style="color:var(--fg3);font-weight:400">{{ llmSelected().length }} selected · OCR-completed only</span>
        </div>
        <div class="llm-checklist">
          @for (j of jobs(); track j.jobId) {
            <span class="llm-chip-wrap">
              <button
                class="llm-chip"
                [class.on]="llmSelected().includes(j.jobId)"
                [class.disabled]="j.status !== 'completed'"
                (click)="j.status === 'completed' && toggleLlm.emit(j.jobId)"
                [disabled]="j.status !== 'completed'"
                [title]="j.status === 'completed' ? '' : 'Awaiting OCR completion'"
              >
                <span class="cb"><di-icon name="check" [size]="11" /></span>
                <span class="ft-dot" [style.background]="ftColor(j.type)"></span>
                {{ j.name }}
              </button>
              @if (!j.isFromArchive) {
                <span class="not-arch">Not Archived</span>
                <button
                  class="arch-btn"
                  (click)="archiveFile.emit(j.docId)"
                  [disabled]="archiving().includes(j.docId)"
                  title="Save this file to the record archive"
                >
                  <di-icon name="save" [size]="12" />
                  {{ archiving().includes(j.docId) ? 'Archiving…' : 'Archive' }}
                </button>
              }
            </span>
          }
        </div>

        <div class="field-label" style="margin-top:6px">Analysis Instructions</div>
        <textarea
          class="prompt-area"
          [value]="prompt()"
          (input)="promptChange.emit($any($event.target).value)"
          placeholder="e.g. Extract all claim dates, amounts, and party names…"
        ></textarea>

        <div class="llm-controls">
          <div class="select-wrap">
            <select [value]="template()" (change)="templateChange.emit($any($event.target).value)">
              @for (t of templateEntries; track t[0]) {
                <option [value]="t[0]">{{ t[0] === 'custom' ? 'Prompt Templates: Custom…' : 'Template: ' + t[1].label }}</option>
              }
            </select>
            <span class="chev"><di-icon name="chevron" [size]="15" /></span>
          </div>
          <div class="select-wrap">
            <select [value]="aiModelId()" (change)="aiModelChange.emit($any($event.target).value)" aria-label="AI model">
              @for (m of aiModels; track m.id) {
                <option [value]="m.id">Model: {{ m.label }}</option>
              }
            </select>
            <span class="chev"><di-icon name="chevron" [size]="15" /></span>
          </div>
          <div class="spacer"></div>
          <span class="save-note">Saved &amp; linked to <b>{{ contextLabel() }}</b></span>
          @if (canChat()) {
            <button class="act-btn primary" (click)="chat.emit()"><di-icon name="chat" [size]="15" /> Chat on Documents</button>
          }
          <button class="btn-analyze" (click)="analyze.emit()" [disabled]="!canAnalyze()">
            <di-icon name="sparkles" [size]="16" />
            {{ analyzing() ? 'Analyzing…' : 'Analyze with AI' }}
          </button>
        </div>
      </div>
    </section>
  `,
})
export class LlmPanelComponent {
  jobs = input.required<Job[]>();
  llmSelected = input.required<string[]>();
  prompt = input.required<string>();
  template = input.required<string>();
  analyzing = input.required<boolean>();
  contextLabel = input.required<string>();
  aiModelId = input.required<string>();
  archiving = input<string[]>([]); // jobIds currently being archived

  toggleLlm = output<string>();
  archiveFile = output<string>();
  promptChange = output<string>();
  templateChange = output<string>();
  aiModelChange = output<string>();
  analyze = output<void>();
  chat = output<void>();

  readonly templateEntries = Object.entries(TEMPLATES);
  readonly aiModels = DI_CONFIG.ai.models;

  canAnalyze = computed(() => this.llmSelected().length > 0 && this.prompt().trim().length > 0 && !this.analyzing());
  /** Chat only answers from indexed chunks, so it appears once a document has RAG data. */
  canChat = computed(() => this.jobs().some((j) => j.ragDocumentId != null));

  ftColor(type: string) {
    return { pdf: 'var(--ft-pdf)', word: 'var(--ft-word)', image: 'var(--ft-image)' }[type] ?? 'var(--ft-pdf)';
  }
}

@Component({
  selector: 'di-response-card',
  imports: [IconComponent],
  template: `
    <section class="zone">
      <div class="zone-mark"><span class="n">03</span><span class="l">Result</span></div>
      <div class="zone-head">
        <div class="z-icon"><di-icon name="fileText" [size]="16" /></div>
        <div>
          <div class="z-title">Analysis Result</div>
          <div class="z-sub">AI-generated · review before saving to record</div>
        </div>
      </div>

      @if (analyzing()) {
        <div class="analyzing">
          <div class="spinner"></div>
          <div>
            Running extraction across selected documents
            <span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>
          </div>
        </div>
      } @else if (!response()) {
        <div class="empty-state">
          <di-icon name="sparkles" [size]="30" />
          <div class="t">No analysis yet</div>
          <div class="d">Select OCR-completed documents above, enter your instructions, and run <b>Analyze with AI</b> to generate a result.</div>
        </div>
      } @else {
        @let r = response()!;
        <div class="response-card">
          <div class="resp-head">
            <div class="ai-badge"><di-icon name="sparkles" [size]="19" /></div>
            <div class="resp-meta">
              <div class="line1">Extraction &amp; risk analysis complete</div>
              <div class="line2">
                <span class="k"><di-icon name="file" [size]="13" /> <b>{{ r.docNames.length }}</b> doc{{ r.docNames.length > 1 ? 's' : '' }}: {{ r.docNames.join(', ') }}</span>
                <span class="k mono"><di-icon name="clock" [size]="13" /> {{ r.timestamp }}</span>
                <span class="model-chip">{{ r.model }}</span>
              </div>
            </div>
          </div>

          <div class="resp-body">
            <p class="summary" dir="auto" [innerHTML]="r.summary"></p>

            <div class="resp-section-title">Extracted Fields</div>
            <div class="kv-grid">
              @for (f of r.fields; track $index) {
                <div class="kv">
                  <div class="k">{{ f.k }}</div>
                  <div class="v" [class.amount]="f.amount">{{ f.v }}</div>
                </div>
              }
            </div>

            <div class="resp-section-title">Risk Flags</div>
            <div class="flags">
              @for (fl of r.flags; track $index) {
                <div class="flag {{ fl.sev }}">
                  <span class="fi"><di-icon [name]="sevIcon(fl.sev)" [size]="16" /></span>
                  <div><b>{{ fl.title }}.</b> {{ fl.body }}</div>
                </div>
              }
            </div>
          </div>

          <div class="resp-actions">
            <button class="act-btn" (click)="exportPdf.emit()"><di-icon name="download" [size]="15" /> Export to PDF</button>
            <button class="act-btn" [class.saved]="r.saved" (click)="save.emit()" [disabled]="r.saved">
              <di-icon [name]="r.saved ? 'check' : 'save'" [size]="15" /> {{ r.saved ? 'Saved to Record' : 'Save to Record' }}
            </button>
            <button class="act-btn" (click)="rerun.emit()"><di-icon name="rerun" [size]="15" /> Re-run with New Prompt</button>
            <div class="grow"></div>
            @if (canChat()) {
              <button class="act-btn primary" (click)="chat.emit()"><di-icon name="chat" [size]="15" /> Chat on Documents</button>
            }
          </div>
        </div>
      }
    </section>
  `,
})
export class ResponseCardComponent {
  response = input.required<AnalysisResponse | null>();
  analyzing = input.required<boolean>();
  canChat = input(false);

  exportPdf = output<void>();
  save = output<void>();
  rerun = output<void>();
  chat = output<void>();

  sevIcon(sev: string) {
    return { warn: 'alert', danger: 'alert', info: 'info' }[sev] ?? 'info';
  }
}
