import { Component, computed, OnDestroy, signal } from '@angular/core';
import {
  clone,
  DEFAULT_PROMPT,
  fileType,
  fmtDate,
  INITIAL_DOCS,
  INITIAL_JOBS,
  nowClock,
  randomConfidence,
  SEED_RESPONSE,
  TEMPLATES,
  uid,
} from './data/data';
import { DI_CONFIG, findAi, findOcr } from './config/di.config';
import { AnalysisResponse, Doc, Job, Toast } from './models/models';
import { OcrService } from './services/ocr.service';

import { ChatDrawerComponent, RawOcrDrawerComponent, ToastsComponent } from './components/drawers';
import { DocPreviewModalComponent } from './components/doc-preview-modal';
import { LeftPanelComponent } from './components/left-panel';
import { LlmPanelComponent, ResponseCardComponent } from './components/llm-panel';
import { OcrBoardComponent } from './components/ocr-board';
import { TopBarComponent } from './components/top-bar';

@Component({
  selector: 'app-root',
  imports: [
    TopBarComponent,
    LeftPanelComponent,
    OcrBoardComponent,
    LlmPanelComponent,
    ResponseCardComponent,
    DocPreviewModalComponent,
    RawOcrDrawerComponent,
    ChatDrawerComponent,
    ToastsComponent,
  ],
  template: `
    <div class="app-shell">
      <di-top-bar [contextLabel]="contextLabel()" />

      <div class="main">
        <di-left-panel
          [objectType]="objectType()"
          [objectId]="objectId()"
          [linkedCount]="linkedCount()"
          [docs]="docs()"
          [selectedCount]="selectedDocs().length"
          (objectTypeChange)="objectType.set($event)"
          (objectIdChange)="objectId.set($event)"
          (toggle)="onToggleDoc($event)"
          (filesPicked)="onFilesPicked($event)"
          (attach)="onAttach()"
          (preview)="previewDoc.set($event)"
          (open)="onOpenDoc($event)"
          (remove)="onRemoveDoc($event)"
        />

        <div class="right-panel">
          <di-ocr-board
            [jobs]="jobs()"
            [engineId]="ocrEngineId()"
            (viewRaw)="rawJob.set($event)"
            (engineChange)="ocrEngineId.set($event)"
          />
          <di-llm-panel
            [jobs]="jobs()"
            [llmSelected]="llmSelected()"
            [prompt]="prompt()"
            [template]="template()"
            [analyzing]="analyzing()"
            [contextLabel]="contextLabel()"
            [aiModelId]="aiModelId()"
            (toggleLlm)="toggleLlm($event)"
            (promptChange)="onPromptChange($event)"
            (templateChange)="onTemplateChange($event)"
            (aiModelChange)="aiModelId.set($event)"
            (analyze)="onAnalyze()"
          />
          <di-response-card
            [response]="response()"
            [analyzing]="analyzing()"
            (exportPdf)="onExport()"
            (save)="onSave()"
            (rerun)="onRerun()"
            (chat)="chatOpen.set(true)"
          />
        </div>
      </div>

      <di-doc-preview-modal
        [doc]="previewDoc()"
        [selected]="previewSelected()"
        (toggleSelect)="onToggleDoc($event)"
        (close)="previewDoc.set(null)"
      />
      <di-raw-ocr-drawer [job]="rawJob()" [ocrModelId]="ocrEngine().modelId" (close)="rawJob.set(null)" />
      <di-chat-drawer [open]="chatOpen()" [docNames]="chatDocs()" (close)="chatOpen.set(false)" />
      <di-toasts [toasts]="toasts()" />
    </div>
  `,
})
export class App implements OnDestroy {
  // ---- Process context ----
  objectType = signal('Claim');
  objectId = signal('2026-08817');

  // ---- Documents / OCR jobs ----
  docs = signal<Doc[]>(INITIAL_DOCS.map((d) => ({ ...d })));
  jobs = signal<Job[]>(INITIAL_JOBS.map((j) => ({ ...j })));

  // ---- Config-driven tool selection ----
  ocrEngineId = signal(DI_CONFIG.ocr.defaultId);
  aiModelId = signal(DI_CONFIG.ai.defaultId);
  ocrEngine = computed(() => findOcr(this.ocrEngineId()));

  // ---- LLM ----
  llmSelected = signal<string[]>(['j1']);
  prompt = signal(DEFAULT_PROMPT);
  template = signal('custom');
  analyzing = signal(false);
  response = signal<AnalysisResponse | null>({ ...SEED_RESPONSE, model: this.modelLabel() });

  // ---- Drawers / modal / toasts ----
  rawJob = signal<Job | null>(null);
  chatOpen = signal(false);
  previewDoc = signal<Doc | null>(null);
  toasts = signal<Toast[]>([]);

  // ---- Derived ----
  selectedDocs = computed(() => this.docs().filter((d) => d.selected));
  completedJobs = computed(() => this.jobs().filter((j) => j.status === 'completed'));
  linkedCount = computed(() => this.completedJobs().length);
  contextLabel = computed(() => {
    const prefix = { Claim: 'CLM', Policy: 'POL', Customer: 'CST' }[this.objectType()];
    return `${this.objectType()} #${prefix}-${this.objectId()}`;
  });
  previewSelected = computed(() => {
    const d = this.previewDoc();
    return d ? !!this.docs().find((x) => x.id === d.id && x.selected) : false;
  });
  chatDocs = computed(() => (this.response() ? this.response()!.docNames : this.completedJobs().map((j) => j.name)));

  private pipeline: ReturnType<typeof setInterval>;

  constructor(private ocrService: OcrService) {
    // Fixed appearance defaults (the standalone build's Tweaks panel is host-only tooling).
    const root = document.documentElement;
    root.style.setProperty('--accent', '#4C9AFF');
    root.style.setProperty('--accent-soft', 'rgba(76, 154, 255, 0.14)');
    root.style.setProperty('--accent-line', 'rgba(76, 154, 255, 0.42)');
    root.style.setProperty('--accent-glow', '0 0 0 3px rgba(76, 154, 255, 0.22)');
    root.style.setProperty('--anim-speed', '1');
    root.setAttribute('data-density', 'comfortable');

    // OCR pipeline engine: 2 parallel slots, advance processing jobs, promote queued.
    this.pipeline = setInterval(() => {
      this.jobs.update((prev) => {
        if (!prev.some((j) => j.status === 'processing' || j.status === 'queued')) return prev;
        const next = prev.map((j) => ({ ...j }));
        for (const j of next) {
          if (j.status === 'processing') {
            j.progress = Math.min(100, j.progress + 2.3);
            if (j.progress >= 100) {
              j.status = 'completed';
              j.confidence = randomConfidence();
              j.ts = nowClock();
            }
          }
        }
        let slots = Math.max(0, 2 - next.filter((j) => j.status === 'processing').length);
        for (const j of next) {
          if (slots <= 0) break;
          if (j.status === 'queued') {
            j.status = 'processing';
            j.progress = 0;
            j.ts = nowClock();
            slots--;
          }
        }
        return next;
      });
    }, 130);
  }

  ngOnDestroy() {
    clearInterval(this.pipeline);
  }

  private modelLabel(): string {
    const m = findAi(this.aiModelId());
    return `${m.label} · ${m.version}`;
  }

  private addToast(text: string, kind: Toast['kind']) {
    const id = uid();
    this.toasts.update((t) => [...t, { id, text, kind }]);
    setTimeout(() => this.toasts.update((t) => t.filter((x) => x.id !== id)), 2900);
  }

  // ---- Handlers ----
  onToggleDoc(id: string) {
    this.docs.update((ds) => ds.map((d) => (d.id === id ? { ...d, selected: !d.selected } : d)));
  }

  onFilesPicked(files: File[]) {
    const added: Doc[] = files.map((f) => ({
      id: uid(),
      name: f.name,
      type: fileType(f.name),
      date: fmtDate(new Date(f.lastModified || Date.now())),
      category: 'Uploaded',
      selected: true,
      file: f,
    }));
    this.docs.update((ds) => [...ds, ...added]);
  }

  onRemoveDoc(id: string) {
    const d = this.docs().find((x) => x.id === id);
    if (!d?.file) return; // only server-loaded uploads are removable
    this.docs.update((ds) => ds.filter((x) => x.id !== id));
    this.jobs.update((js) => js.filter((j) => j.docId !== id)); // drop any OCR job for it
  }

  onOpenDoc(d: Doc) {
    // Files loaded from server: let the browser open by MIME type (PDF/image inline, Word downloads).
    // Seed docs have no File, so fall back to the canned preview modal.
    if (d.file) {
      const url = URL.createObjectURL(d.file);
      window.open(url, '_blank');
      // ponytail: fixed 60s before revoke; enough for the new tab to load any doc type.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else {
      this.previewDoc.set(d);
    }
  }

  onAttach() {
    const sel = this.docs().filter((d) => d.selected);
    if (!sel.length) return;
    const existing = new Set(this.jobs().map((j) => j.docId));
    const fresh = sel.filter((d) => !existing.has(d.id));
    if (!fresh.length) {
      this.addToast('Selected documents are already in the OCR queue', 'info');
      return;
    }
    const newJobs: Job[] = fresh.map((d) => ({
      jobId: 'j_' + d.id + '_' + uid(),
      docId: d.id,
      name: d.name,
      type: d.type,
      status: 'queued',
      confidence: null,
      pages: 2 + Math.floor(Math.random() * 11),
      ts: '—',
      progress: 0,
    }));
    this.jobs.update((js) => [...js, ...newJobs]);
    this.addToast(`${fresh.length} document${fresh.length > 1 ? 's' : ''} sent to ${this.ocrEngine().short}`, 'success');

    // For uploaded files, call the real OCR API and update the job on completion.
    for (const doc of fresh.filter((d) => d.file)) {
      const job = newJobs.find((j) => j.docId === doc.id)!;
      this.ocrService.recognize(doc.file!, this.ocrEngineId()).then((result) => {
        this.jobs.update((js) =>
          js.map((j) =>
            j.jobId === job.jobId
              ? { ...j, status: 'completed', confidence: result.confidence, pages: result.pages, progress: 100, ts: nowClock(), raw: result.raw }
              : j
          )
        );
      }).catch((err) => {
        console.error(`OCR failed for ${doc.name}:`, err);
        this.jobs.update((js) =>
          js.map((j) => (j.jobId === job.jobId ? { ...j, status: 'failed', ts: nowClock() } : j))
        );
        this.addToast(`OCR failed for ${doc.name}`, 'error');
      });
    }
  }

  toggleLlm(jobId: string) {
    this.llmSelected.update((s) => (s.includes(jobId) ? s.filter((x) => x !== jobId) : [...s, jobId]));
  }

  onPromptChange(v: string) {
    this.prompt.set(v);
    if (this.template() !== 'custom') this.template.set('custom');
  }

  onTemplateChange(v: string) {
    this.template.set(v);
    const t = TEMPLATES[v];
    if (t && t.text) this.prompt.set(t.text);
  }

  onAnalyze() {
    const sel = this.jobs().filter((j) => this.llmSelected().includes(j.jobId) && j.status === 'completed');
    if (!sel.length || !this.prompt().trim()) return;
    this.analyzing.set(true);
    this.response.set(null);
    setTimeout(() => {
      this.response.set(this.buildResponse(sel));
      this.analyzing.set(false);
      this.addToast('Analysis complete', 'success');
    }, 2100);
  }

  private buildResponse(selJobs: Job[]): AnalysisResponse {
    const names = selJobs.map((j) => j.name);
    const hasAdjuster = names.some((n) => /Adjuster/i.test(n));
    const base = clone(SEED_RESPONSE);
    base.id = uid();
    base.docNames = names.length ? names : ['FNOL_Report_08817.pdf'];
    base.timestamp = this.fmtNow();
    base.model = this.modelLabel();
    base.saved = false;
    if (hasAdjuster) {
      base.summary =
        'Cross-document analysis of the <span class="hl">FNOL</span> and <span class="hl">adjuster statement</span> confirms a single-vehicle collision involving policyholder <span class="hl">Daniel R. Okonkwo</span> (2022 Honda CR-V). Loss date <span class="hl">May 28, 2026</span>, reported <span class="hl">5 days later</span>. The adjuster revised the repair estimate upward to <span class="hl">$16,800</span>, exceeding the original FNOL figure of $14,250.';
      base.flags = [
        { sev: 'warn', title: 'Late reporting', body: 'Loss reported 5 days after the incident — exceeds the 72-hour policy notification window.' },
        { sev: 'danger', title: 'Amount discrepancy', body: 'FNOL estimates $14,250 in damage; the adjuster statement records $16,800 — a $2,550 variance requiring reconciliation before settlement.' },
        { sev: 'info', title: 'Parties consistent', body: 'Policyholder name and policy number (POL-2024-44910) match across both documents.' },
      ];
    }
    return base;
  }

  private fmtNow(): string {
    const d = new Date();
    const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    const p = (n: number) => String(n).padStart(2, '0');
    return `${mo} ${p(d.getDate())}, ${d.getFullYear()} · ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  onExport() {
    this.addToast('Exporting analysis to PDF…', 'info');
  }

  onSave() {
    this.response.update((r) => (r ? { ...r, saved: true } : r));
    this.addToast(`Saved to ${this.contextLabel()}`, 'success');
  }

  onRerun() {
    this.addToast('Edit your instructions, then Analyze again', 'info');
    const el = document.querySelector('.prompt-area') as HTMLTextAreaElement | null;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }
}
