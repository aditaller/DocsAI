import { Component, computed, signal } from '@angular/core';
import {
  clone,
  DEFAULT_PROMPT,
  fileType,
  fmtDate,
  nowClock,
  SEED_RESPONSE,
  TEMPLATES,
  uid,
} from './data/data';
import { DI_CONFIG, findAi, findEngine } from './config/di.config';
import { AnalysisResponse, Doc, Job, THINKING_PREFIX, Toast } from './models/models';
import { AuthService } from './services/auth.service';
import { archiveToDoc, CustomerHit, CustomerService } from './services/customer.service';
import { LocalHealth, LocalRagService, RagScope } from './services/local-rag.service';
import { OcrResult, OcrService } from './services/ocr.service';

import { ChatDrawerComponent, RawOcrDrawerComponent, ToastsComponent } from './components/drawers';
import { DocPreviewModalComponent } from './components/doc-preview-modal';
import { LeftPanelComponent } from './components/left-panel';
import { LoginComponent } from './components/login';
import { LlmPanelComponent, ResponseCardComponent } from './components/llm-panel';
import { OcrBoardComponent } from './components/ocr-board';
import { TopBarComponent } from './components/top-bar';

/**
 * Appended by the HEB button. Kept as an instruction rather than a translated
 * prompt so the user's own wording still drives what gets extracted — only the
 * language of the answer changes.
 */
const HEBREW_INSTRUCTION =
  'Answer entirely in Hebrew. Write every heading, label, field name and value in Hebrew, ' +
  'except for figures, dates, and identifiers, which stay exactly as they appear in the document.';

@Component({
  selector: 'app-root',
  imports: [
    TopBarComponent,
    LeftPanelComponent,
    LoginComponent,
    OcrBoardComponent,
    LlmPanelComponent,
    ResponseCardComponent,
    DocPreviewModalComponent,
    RawOcrDrawerComponent,
    ChatDrawerComponent,
    ToastsComponent,
  ],
  template: `
    @if (!auth.authed()) {
      <di-login />
    } @else {
    <div class="app-shell">
      <di-top-bar
        [contextLabel]="contextLabel()"
        [mode]="mode()"
        [health]="localHealth()"
        (modeChange)="onModeChange($event)"
      />

      <div class="main">
        <di-left-panel
          [objectType]="objectType()"
          [objectId]="objectId()"
          [linkedCount]="linkedCount()"
          [docs]="docs()"
          [selectedCount]="selectedDocs().length"
          [archiving]="archivingIds()"
          (objectTypeChange)="objectType.set($event)"
          (archive)="onArchiveDoc($event)"
          (objectIdChange)="objectId.set($event)"
          (processPicked)="onProcessPicked($event)"
          (toggle)="onToggleDoc($event)"
          (filesPicked)="onFilesPicked($event)"
          (attach)="onAttach()"
          (preview)="onOpenDoc($event)"
          (open)="onOpenDoc($event)"
          (remove)="onRemoveDoc($event)"
        />

        <div class="right-panel">
          <di-ocr-board
            [jobs]="jobs()"
            [engines]="engineOptions()"
            [engineId]="activeEngineId()"
            (viewRaw)="openRaw($event)"
            (saveOcr)="onSaveOcr($event)"
            (removeJob)="onRemoveJob($event)"
            (rerun)="onRerunOcr($event)"
            (engineChange)="onEngineChange($event)"
          />
          <di-llm-panel
            [jobs]="jobs()"
            [llmSelected]="llmSelected()"
            [prompt]="prompt()"
            [template]="template()"
            [analyzing]="analyzing()"
            [contextLabel]="contextLabel()"
            [aiModelId]="aiModelId()"
            [archiving]="archivingIds()"
            (toggleLlm)="toggleLlm($event)"
            (selectAll)="selectAllLlm($event)"
            (promptChange)="onPromptChange($event)"
            (templateChange)="onTemplateChange($event)"
            (aiModelChange)="aiModelId.set($event)"
            (analyze)="onAnalyze()"
            (analyzeHebrew)="onAnalyze(true)"
            (chat)="chatOpen.set(true)"
            (archiveFile)="onArchiveDoc($event)"
          />
          <di-response-card
            [response]="response()"
            [analyzing]="analyzing()"
            [canChat]="canChat()"
            [openableDocNames]="openableDocNames()"
            (exportPdf)="onExport()"
            (save)="onSave()"
            (rerun)="onRerun()"
            (chat)="chatOpen.set(true)"
            (openOriginal)="onOpenOriginal($event)"
          />
        </div>
      </div>

      <di-doc-preview-modal
        [doc]="previewDoc()"
        [selected]="previewSelected()"
        (toggleSelect)="onToggleDoc($event)"
        (close)="previewDoc.set(null)"
      />
      <di-chat-drawer
        [open]="chatOpen()"
        [docNames]="chatDocs()"
        [openableDocNames]="openableDocNames()"
        [ask]="askDocs"
        (close)="chatOpen.set(false)"
        (openOriginal)="onOpenOriginal($event)"
      />
      <di-raw-ocr-drawer [job]="rawJob()" [pages]="rawPages()" [ocrModelId]="ocrEngine().modelId" (close)="openRaw(null)" />
      <di-toasts [toasts]="toasts()" />
    </div>
    }
  `,
})
export class App {
  // ---- Process context ----
  objectType = signal('Customer');
  objectId = signal('');
  // The picked record's display name; becomes rag.claim.claimnumber on first ingest.
  objectName = signal('');

  // ---- Documents / OCR jobs ---- (empty until real docs are loaded/uploaded)
  docs = signal<Doc[]>([]);
  jobs = signal<Job[]>([]);

  // ---- Config-driven tool selection ----
  ocrEngineId = signal(DI_CONFIG.ocr.defaultId);
  // Local mode picks between the two engines the ingestion service can run.
  // Kept separate from ocrEngineId so switching modes does not lose the choice.
  localEngineId = signal(DI_CONFIG.local.defaultEngineId);
  aiModelId = signal(DI_CONFIG.ai.defaultId);

  // ---- Engine mode ---- 'azure' keeps the cloud OCR + chat pair; 'local' runs
  // OCR into pgvector and answers from retrieved chunks. Local is the default;
  // the constructor drops back to 'azure' if health says the service is not up,
  // because its own toggle is disabled while that is true.
  mode = signal<'azure' | 'local'>('local');
  localHealth = signal<LocalHealth | null>(null);

  // The two vision engines are named by whichever model the service has
  // configured, so the picker says `qwen2.5vl:7b` rather than "Ollama Vision" and
  // stays honest when the env var is swapped. Falls back to the static labels
  // until health has answered, and on a service too old to report the names.
  engineOptions = computed(() => {
    if (this.mode() !== 'local') return DI_CONFIG.ocr.engines;
    const health = this.localHealth();
    const named: Record<string, string | undefined> = {
      ollama: health?.ocrModel,
      'deepseek-ocr': health?.deepseekOcrModel,
    };
    return DI_CONFIG.local.engines.map((engine) => {
      const model = named[engine.id];
      return model ? { ...engine, label: model, short: model } : engine;
    });
  });
  activeEngineId = computed(() => (this.mode() === 'local' ? this.localEngineId() : this.ocrEngineId()));
  ocrEngine = computed(() => findEngine(this.engineOptions(), this.activeEngineId()));
  engineLabel = computed(() => (this.mode() === 'local' ? `${DI_CONFIG.local.label} · ${this.ocrEngine().short}` : this.ocrEngine().short));

  // ---- LLM ----
  llmSelected = signal<string[]>([]);
  prompt = signal(DEFAULT_PROMPT);
  template = signal('custom');
  /** System prompt of the last picked template; survives prompt edits, cleared by "Custom…". */
  sysPrompt = signal('');
  analyzing = signal(false);
  response = signal<AnalysisResponse | null>(null);
  archivingIds = signal<string[]>([]); // jobIds mid-archive, to disable their Archive button

  // ---- Drawers / modal / toasts ----
  rawJob = signal<Job | null>(null);
  rawPages = signal<[number, number] | null>(null); // set when the drawer was opened from a page reference
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
  // The docs the chat drawer answers over: the ones an analysis ran on, else everything OCR'd.
  chatJobs = computed(() => {
    const r = this.response();
    const done = this.completedJobs();
    return r ? done.filter((j) => r.docNames.includes(j.name)) : done;
  });
  chatDocs = computed(() => this.chatJobs().map((j) => j.name));
  // Docs a page reference can open: the original bytes must be reachable (an upload's
  // File, or an archive path). PDFs land on the referenced page; an image is one page,
  // so it just opens.
  openableDocNames = computed(() => this.docs().filter((d) => d.file || d.path).map((d) => d.name));
  canChat = computed(() => this.chatJobs().some((j) => j.ragDocumentId != null));

  /** Bound so the drawer can hold it as a plain input; routes questions through the active engine. */
  askDocs = async (question: string, onPartial?: (partial: string) => void): Promise<string> => {
    const sel = this.chatJobs();
    if (!sel.length) return 'No OCR-completed documents are in context yet.';
    if (this.mode() === 'local') {
      if (!sel.some((j) => j.ragDocumentId)) return 'These documents were not indexed locally — re-run OCR in local mode first.';
      // Retrieval, not full documents: a follow-up is narrow, and the drawer is
      // used repeatedly, so re-reading every page per question would not pay.
      return this.analyzeLocal(sel, question, { full: false, ...(onPartial ? { onPartial } : {}) });
    }
    return this.analyzeCloud(sel, performance.now(), question);
  };

  constructor(
    private ocrService: OcrService,
    private localRag: LocalRagService,
    private customerService: CustomerService,
    public auth: AuthService,
  ) {
    // Appearance is owned entirely by styles.scss now. The old inline --accent
    // overrides set here would win over the stylesheet's cascade, so they're gone.
    // Only at startup: an unreachable ingestion service would otherwise leave the
    // app in local mode with the local toggle disabled and nothing able to run.
    // A later failure is left alone — the user chose that mode deliberately.
    void this.refreshLocalHealth().then(() => {
      if (!this.localHealth()?.ok) this.mode.set('azure');
    });
  }

  /** Keeps the toggle honest about whether Postgres and Ollama are both ready. */
  private async refreshLocalHealth() {
    this.localHealth.set(await this.localRag.health());
  }

  onModeChange(next: 'azure' | 'local') {
    if (next === this.mode()) return;
    this.mode.set(next);
    if (next === 'local') {
      void this.refreshLocalHealth();
      this.addToast(`Local RAG: ${this.ocrEngine().short} OCR into pgvector`, 'info');
    } else {
      this.addToast(`Cloud: ${this.ocrEngine().short}`, 'info');
    }
  }

  /** One dropdown, two independent selections — the mode decides which it sets. */
  onEngineChange(id: string) {
    if (this.mode() === 'local') this.localEngineId.set(id);
    else this.ocrEngineId.set(id);
  }

  /** The record documents are scoped to; created in rag.claim on first ingest. */
  private ragScope(): RagScope {
    return {
      objectType: DI_CONFIG.taldar.entityTables[this.objectType()] ?? this.objectType(),
      objectId: Number(this.objectId()),
      label: this.objectName() || this.contextLabel(),
    };
  }

  private modelLabel(): string {
    if (this.mode() === 'local') return this.engineLabel();
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
      isFromArchive: false,
      archiveId: null,
    }));
    this.docs.update((ds) => [...ds, ...added]);
  }

  async onProcessPicked(c: CustomerHit) {
    const table = DI_CONFIG.taldar.entityTables[this.objectType()];
    try {
      const rows = await this.customerService.documents(c.id, table);
      if (rows.length) console.log('gnr.archive row sample:', rows[0]);
      this.objectName.set(c.name);
      this.docs.set(rows.map(archiveToDoc));
      this.jobs.set([]); // seed/previous OCR jobs belong to the old context
      this.llmSelected.set([]); // and so does the LLM selection pointing at them
      this.addToast(`${rows.length} document${rows.length === 1 ? '' : 's'} for ${c.name}`, rows.length ? 'success' : 'info');
      // Re-check against the newly picked record: local ingest needs a matching rag.claim row.
      void this.refreshLocalHealth();
    } catch (err) {
      console.error('Loading customer documents failed:', err);
      this.addToast('Could not load customer documents', 'error');
    }
  }

  // Uploads are dropped from the list only; an archived doc is really deleted from
  // gnr.archive first — behind a confirm, since that one can't be undone.
  async onRemoveDoc(id: string) {
    const d = this.docs().find((x) => x.id === id);
    if (!d) return;
    if (d.archiveId != null) {
      if (!confirm('Are you sure you want to delete this document from archive ?')) return;
      try {
        await this.customerService.deleteRow(DI_CONFIG.taldar.archiveTable, d.archiveId);
        this.addToast(`Deleted ${d.name} from archive`, 'success');
      } catch (err) {
        console.error('Archive delete failed:', err);
        this.addToast(`Could not delete ${d.name} from archive`, 'error');
        return; // leave the row on screen — the server still has it
      }
    }
    this.docs.update((ds) => ds.filter((x) => x.id !== id));
    this.jobs.update((js) => js.filter((j) => j.docId !== id)); // drop any OCR job for it
  }

  // Drop a row off the status board. ponytail: board-only — the document stays in the
  // left panel (and in gnr.archive), so Attach can queue it again.
  onRemoveJob(job: Job) {
    this.jobs.update((js) => js.filter((j) => j.jobId !== job.jobId));
    this.llmSelected.update((s) => s.filter((id) => id !== job.jobId));
  }

  onOpenDoc(d: Doc) {
    // Archive docs carry a server-side path (c:/temp/x.png) the browser can't read.
    // Open it exactly like the main TALDAR app's table-grid openfile(): xlsx via the
    // ms-excel: protocol, everything else through the getarchivedata route (the jwt
    // cookie rides along, same-origin, so the backend authorizes it).
    if (d.path) {
      if (d.path.toLowerCase().endsWith('.xlsx')) {
        window.open('ms-excel:ofe|u|' + d.path, '_blank');
      } else {
        const url = new URL(DI_CONFIG.taldar.archiveFileEndpoint, location.origin);
        url.searchParams.set('path', d.path);
        window.open(url.toString(), '_blank');
      }
      return;
    }
    // Files loaded from server: let the browser open by MIME type (PDF/image inline, Word downloads).
    // Seed docs have no File, so fall back to the canned preview modal.
    if (d.file) {
      this.openBlob(d.file);
    } else {
      this.previewDoc.set(d);
    }
  }

  /**
   * What a page reference in an answer opens: the original document itself — a PDF
   * scrolled to that page, an image as-is (one page, nothing to scroll to).
   *
   * Deliberately not onOpenDoc's route. The archive endpoint answers as a
   * download, and a downloaded file is handed to Adobe, which never sees a
   * #page= fragment. Fetching the bytes and typing them application/pdf puts
   * the document in Chrome's own viewer, where the fragment means something.
   */
  async onOpenOriginal(ref: { docName: string; page: number }) {
    const doc = this.docs().find((d) => d.name === ref.docName);
    if (!doc) {
      this.addToast(`${ref.docName} is no longer loaded`, 'info');
      return;
    }
    try {
      const file = await this.resolveFile(doc);
      const pdf = doc.type === 'pdf';
      // The File carries the server's own type for archive downloads; fall back to
      // the extension so an image still opens inline instead of downloading.
      const type = pdf ? 'application/pdf' : file.type || mimeOf(doc.name);
      this.openBlob(new Blob([file], { type }), pdf ? `#page=${ref.page}` : '', doc.name);
    } catch (err) {
      this.addToast(err instanceof Error ? err.message : `Could not open ${ref.docName}`, 'error');
    }
  }

  private openBlob(blob: Blob, hash = '', name = '') {
    const url = URL.createObjectURL(blob);
    // Chrome ignores #page= when a blob: URL is the tab's own document, but
    // honours it on a frame's src — so a page-targeted open gets a blank
    // same-origin tab holding the PDF in a full-bleed iframe. Embedding also
    // survives the "download PDFs instead of opening them" Chrome setting.
    // Without a page, the blob opens directly and the tab keeps its normal URL.
    const win = window.open(hash ? '' : url, '_blank');
    if (hash && win) {
      win.document.write(
        `<title>${name}</title>` +
          `<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>` +
          `<iframe src="${url}${hash}"></iframe>`,
      );
      win.document.close();
    }
    // ponytail: fixed 60s before revoke; enough for the new tab to load any doc type.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  onAttach() {
    const sel = this.docs().filter((d) => d.selected);
    if (!sel.length) return;
    const existing = new Set(this.jobs().map((j) => j.docId));
    let fresh = sel.filter((d) => !existing.has(d.id));
    if (!fresh.length) {
      this.addToast('Selected documents are already in the OCR queue', 'info');
      return;
    }

    // Local ingest keys rag.document on the gnr.archive id and links it to the
    // record's rag.claim row, so an un-archived upload has no identity to index
    // under. Archive it first — the left panel and LLM panel both offer that.
    if (this.mode() === 'local') {
      if (!this.objectId()) {
        this.addToast('Pick a record first — local RAG indexes against it', 'info');
        return;
      }
      const unarchived = fresh.filter((d) => d.archiveId == null);
      if (unarchived.length) {
        this.addToast(`Archive ${unarchived.map((d) => d.name).join(', ')} first`, 'error');
        fresh = fresh.filter((d) => d.archiveId != null);
      }
      if (!fresh.length) return;
    }

    const newJobs: Job[] = fresh.map((d) => ({
      jobId: 'j_' + d.id + '_' + uid(),
      docId: d.id,
      name: d.name,
      type: d.type,
      status: 'processing',
      confidence: null,
      pages: 0,
      totalMs: null,
      ts: nowClock(),
      progress: 0,
      isFromArchive: d.isFromArchive,
      archiveId: d.archiveId,
    }));
    this.jobs.update((js) => [...js, ...newJobs]);
    this.addToast(`${fresh.length} document${fresh.length > 1 ? 's' : ''} sent to ${this.engineLabel()}`, 'success');

    // Run OCR on every fresh doc: uploads carry their File directly; archive docs
    // stream their bytes from the getarchivedata route first.
    //
    // Azure is a hosted service and absorbs the whole batch at once. One local
    // model serves one request at a time, so firing them together only makes
    // them queue inside Ollama: measured here, three concurrent pages turned a
    // 10s page into 52s, and a large enough batch pushes the later ones past
    // the request timeout. Local mode therefore runs them one after another.
    if (this.mode() === 'local') {
      void (async () => {
        for (const doc of fresh) await this.runOcrForJob(doc, newJobs.find((j) => j.docId === doc.id)!);
      })();
    } else {
      for (const doc of fresh) void this.runOcrForJob(doc, newJobs.find((j) => j.docId === doc.id)!);
    }
  }

  /**
   * Runs OCR again for a row already on the board — after a failure, or to read
   * the same document with the other engine. The service treats a re-submit as a
   * retry, so a terminally failed run is reclaimed rather than refused.
   */
  onRerunOcr(job: Job) {
    const doc = this.docs().find((d) => d.id === job.docId);
    if (!doc) {
      this.addToast(`${job.name} is no longer in the document list`, 'error');
      return;
    }
    if (this.mode() === 'local' && doc.archiveId == null) {
      this.addToast(`Archive ${doc.name} first — local RAG indexes against it`, 'error');
      return;
    }
    this.jobs.update((js) =>
      js.map((j) => (j.jobId === job.jobId ? { ...j, status: 'processing', progress: 0, confidence: null, totalMs: null, ts: nowClock(), error: undefined } : j)),
    );
    this.addToast(`Re-running ${doc.name} on ${this.engineLabel()}`, 'info');
    void this.runOcrForJob(doc, job);
  }

  /** OCRs one document and folds the outcome into its job row. Never rejects. */
  private async runOcrForJob(doc: Doc, job: Job): Promise<void> {
    try {
      const result = await this.runOcr(doc);
      this.jobs.update((js) =>
        js.map((j) =>
          j.jobId === job.jobId
            ? { ...j, status: 'completed', confidence: result.confidence, pages: result.pages, totalMs: result.totalMs, progress: 100, ts: nowClock(), raw: result.raw, ocr: result.api, ragDocumentId: result.ragDocumentId ?? null, error: undefined }
            : j
        )
      );
    } catch (err) {
      console.error(`OCR failed for ${doc.name}:`, err);
      // Both services sanitize their own errors, so the message is safe to show.
      const reason = err instanceof Error ? err.message : String(err);
      this.jobs.update((js) =>
        js.map((j) => (j.jobId === job.jobId ? { ...j, status: 'failed', ts: nowClock(), error: reason } : j))
      );
      this.addToast(`${this.mode() === 'local' ? 'Local OCR' : 'OCR'} failed for ${doc.name}`, 'error');
    }
  }

  /** The single point where the two OCR engines diverge. */
  private async runOcr(doc: Doc): Promise<OcrResult & { ragDocumentId?: number | null }> {
    const file = await this.resolveFile(doc);
    if (this.mode() === 'local') return this.localRag.ingest(file, doc.archiveId!, this.ragScope(), this.localEngineId());
    return this.ocrService.recognize(file, this.ocrEngineId());
  }

  // Uploads already hold a File; archive docs stream from getarchivedata (jwt cookie
  // rides along, same-origin) and get wrapped into a File for the OCR call.
  private async resolveFile(doc: Doc): Promise<File> {
    if (doc.file) return doc.file;
    if (!doc.path) throw new Error(`${doc.name} has no file or path to OCR`);
    const url = new URL(DI_CONFIG.taldar.archiveFileEndpoint, location.origin);
    url.searchParams.set('path', doc.path);
    const res = await fetch(url.toString(), { credentials: 'include' });
    // A real archive file is binary; a text/json body here is the "JWT was empty" error.
    const ct = res.headers.get('Content-Type') ?? '';
    if (!res.ok || /json|text/i.test(ct)) {
      const text = await res.text().catch(() => '');
      if (this.auth.sessionExpired(res.status, text)) throw new Error(`Fetching ${doc.name} failed: session expired`);
      throw new Error(`Fetching ${doc.name} failed (${res.status} ${res.statusText})`);
    }
    const blob = await res.blob();
    return new File([blob], doc.name, { type: blob.type });
  }

  // Persist a completed job's full OCR payload into gnr.archive_OCR.
  async onSaveOcr(job: Job) {
    const api = job.ocr as Record<string, unknown> | undefined;
    if (!api) {
      this.addToast('No OCR data to save for this document', 'info');
      return;
    }
    const str = (v: unknown) => (v == null ? null : typeof v === 'string' ? v : JSON.stringify(v));
    const row = {
      archiveid: job.docId, // archive docs carry their gnr.archive id as docId
      correlationId: api['correlationId'] ?? null,
      modelid: api['modelid'] ?? this.ocrEngine().modelId,
      content: str(api['content'] ?? api['text']),
      tables: str(api['tables']),
      keyValuePairs: str(api['keyValuePairs']),
      fullResult: str(api['fullResult'] ?? api),
      elapsedTimeMs: api['elapsedTimeMs'] ?? null,
      createuser: this.auth.username() || null,
    };
    try {
      await this.customerService.saveData('gnr.archive_OCR', row);
      this.addToast(`Saved OCR data for ${job.name}`, 'success');
    } catch (err) {
      console.error('Saving OCR data failed:', err);
      this.addToast(`Could not save OCR data for ${job.name}`, 'error');
    }
  }

  // Archive an uploaded (not-yet-archived) file into gnr.archive via the upload route (saves
  // the file to disk + inserts the archive row), then flip its doc + job to archived so it
  // can be linked to the AI response on Save to Record. Keyed by docId so the LLM panel and
  // the left document list both drive it.
  async onArchiveDoc(docId: string) {
    const doc = this.docs().find((d) => d.id === docId);
    if (!doc?.file) {
      this.addToast('No uploaded file to archive', 'info');
      return;
    }
    if (!this.objectId()) {
      this.addToast('Pick a record first — an archived file must link to a process', 'info');
      return;
    }
    if (this.archivingIds().includes(docId)) return; // already in flight

    const table = DI_CONFIG.taldar.entityTables[this.objectType()] ?? this.objectType();
    this.archivingIds.update((s) => [...s, docId]);
    try {
      // The upload route returns the new gnr.archive id — keep it so Save to Record
      // links this file without a re-fetch and without the "not archived" alert.
      const archiveId = await this.customerService.uploadFile(table, Number(this.objectId()), doc.file);

      this.docs.update((ds) => ds.map((d) => (d.id === docId ? { ...d, isFromArchive: true, archiveId } : d)));
      this.jobs.update((js) => js.map((j) => (j.docId === docId ? { ...j, isFromArchive: true, archiveId } : j)));
      this.addToast(archiveId ? `Archived ${doc.name}` : `Archived ${doc.name} (id not resolved)`, archiveId ? 'success' : 'info');
    } catch (err) {
      console.error('Archiving file failed:', err);
      this.addToast(`Could not archive ${doc.name}`, 'error');
    } finally {
      this.archivingIds.update((s) => s.filter((x) => x !== docId));
    }
  }

  selectAllLlm(on: boolean) {
    this.llmSelected.set(on ? this.jobs().filter((j) => j.status === 'completed').map((j) => j.jobId) : []);
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
    this.sysPrompt.set(t?.system ?? '');
    if (t && t.text) this.prompt.set(t.text);
  }

  /** One entry point for the raw-OCR drawer, so a page range never survives the next open. */
  openRaw(job: Job | null, pages: [number, number] | null = null) {
    this.rawPages.set(pages);
    this.rawJob.set(job);
  }

  /** A page reference clicked in the answer: open that document's OCR at those pages. */
  async onAnalyze(hebrew = false) {
    const sel = this.jobs().filter((j) => this.llmSelected().includes(j.jobId) && j.status === 'completed');
    if (!sel.length) {
      this.addToast('Select an OCR-completed document to analyze', 'info');
      return;
    }
    if (!this.prompt().trim()) return;
    if (this.mode() === 'local' && !sel.some((j) => j.ragDocumentId)) {
      this.addToast('These documents were not indexed locally — re-run OCR in local mode first', 'error');
      return;
    }
    this.analyzing.set(true);
    this.response.set(null);

    const startedAt = performance.now();
    const instruction = [this.sysPrompt(), this.prompt(), hebrew ? HEBREW_INSTRUCTION : ''].filter(Boolean).join('\n\n');
    try {
      // Local streams: the answer card is created empty and filled as tokens
      // land, so a long extraction is readable while it is still being written.
      // Cloud has no streaming endpoint, so it still resolves in one piece.
      const reply =
        this.mode() === 'local'
          ? await this.analyzeLocal(sel, instruction, { full: true, onPartial: (p) => this.streamInto(p) })
          : await this.analyzeCloud(sel, startedAt, instruction);

      const base = clone(SEED_RESPONSE);
      base.id = uid();
      base.docNames = sel.map((j) => j.name);
      base.timestamp = this.fmtNow();
      base.model = this.modelLabel();
      base.saved = false;
      base.summary = String(reply).replace(/\n/g, '<br>');
      base.fields = [];
      base.flags = [];
      // these docs' OCR text is what went to AI; carry each one's archive state for save
      base.relatedFiles = sel.map((j) => {
        const d = this.docs().find((x) => x.id === j.docId);
        return { docId: j.docId, name: j.name, isFromArchive: !!d?.isFromArchive, archiveId: d?.archiveId ?? null };
      });
      base.elapsedMs = Math.round(performance.now() - startedAt);
      // snapshot the instruction as sent — the textarea can be edited before Save
      base.prompt = instruction;
      this.response.set(base);
      this.addToast('Analysis complete', 'success');
    } catch (err) {
      console.error('AI analysis failed:', err);
      this.addToast(err instanceof Error ? err.message : 'AI analysis failed', 'error');
    } finally {
      this.analyzing.set(false);
    }
  }

  /** Cloud path: the whole OCR text of every selected doc goes to the hosted model. */
  private async analyzeCloud(sel: Job[], startedAt: number, instruction = this.prompt()): Promise<string> {
    // OCR text of the selected docs (strip the seed markup); prompt is the instruction.
    const userMessage = sel
      .map((j) => `# ${j.name}\n${(j.raw?.lines ?? []).map((l) => (Array.isArray(l) ? l.join(': ') : l)).join('\n').replace(/<[^>]+>/g, '')}`)
      .join('\n\n');
    const body = JSON.stringify({ userMessage, systemMessage: instruction, enableWebSearch: false });
    const res = await fetch(DI_CONFIG.ai.chatEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const tHeaders = performance.now();
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(
      `chat: sent ${body.length}B (user ${userMessage.length}, system ${instruction.length}), ` +
      `ttfb ${Math.round(tHeaders - startedAt)}ms, body ${Math.round(performance.now() - tHeaders)}ms`
    );
    // ponytail: endpoint may reply with bare text or a JSON envelope; accept both.
    try {
      const j = JSON.parse(text);
      return j.reply ?? j.content ?? j.message ?? j.response ?? text;
    } catch {
      return text; // plain text
    }
  }

  /**
   * Local path: only the chunks the prompt actually retrieves are sent, so a long
   * PDF costs the same context as a short one. Citations are appended so every
   * claim in the answer can be traced back to a page.
   */
  /**
   * `full` and `onPartial` are independent on purpose: Analyze sends every OCR
   * page, the chat drawer retrieves, and both stream their reply.
   */
  private async analyzeLocal(
    sel: Job[],
    instruction = this.prompt(),
    options: { full?: boolean; onPartial?: (partial: string) => void } = {},
  ): Promise<string> {
    const ids = sel.map((j) => j.ragDocumentId).filter((id): id is number => typeof id === 'number');
    const { full = false, onPartial } = options;
    let streamed = '';
    let reasoning = '';
    const result = await this.localRag.chat(instruction, ids, {
      full,
      ...(onPartial
        ? {
            onToken: (t) => onPartial((streamed += t)),
            // Reasoning shows first and is replaced the moment the answer starts,
            // since onToken always reports the full answer text so far.
            onThinking: (t) => onPartial(`${THINKING_PREFIX}${(reasoning += t)}`),
          }
        : {}),
    });
    console.log(
      `local ${full ? 'analyze' : 'chat'}: ${ids.length} doc(s), ${result.citations.length} source(s), server ${result.elapsedTimeMs}ms`,
    );

    // A document too large for the context is answered from its nearest excerpts
    // instead of every page. That is a weaker answer than Analyze normally gives,
    // so it is stated rather than left for the reader to infer from the citations.
    const note =
      full && result.mode === 'retrieval'
        ? `_Answered from the most relevant excerpts: this document is ${result.fellBack?.chars.toLocaleString() ?? 'too many'} characters, over the ${result.fellBack?.budget.toLocaleString() ?? ''} the model can read at once._

`
        : '';
    if (note) this.addToast('Document too large to read whole - answered from the closest excerpts', 'info');
    if (!result.citations.length) return note + result.reply;

    const names = new Map(sel.map((j) => [j.ragDocumentId, j.name]));
    const sources = result.citations
      .map((c) => {
        const pages = c.pageStart === c.pageEnd ? `p.${c.pageStart}` : `p.${c.pageStart}-${c.pageEnd}`;
        return `${names.get(c.documentId) ?? `document ${c.documentId}`} ${pages}`;
      })
      .filter((value, index, all) => all.indexOf(value) === index);
    return `${note}${result.reply}\n\nSources: ${sources.join(' · ')}`;
  }

  /**
   * Shows the answer as it is written. The first token creates the card so the
   * user stops looking at a spinner; every later one just rewrites the summary.
   * The final object built in onAnalyze replaces this with the complete record.
   */
  private streamInto(partial: string): void {
    // Reasoning is condensed to its tail: it is progress, not content, and the
    // first answer token replaces it wholesale.
    const summary = (
      partial.startsWith(THINKING_PREFIX)
        ? `${THINKING_PREFIX}${partial.slice(THINKING_PREFIX.length).replace(/\s+/g, ' ').trim().slice(-160)}`
        : partial
    ).replace(/\n/g, '<br>');
    const existing = this.response();
    if (existing) {
      this.response.set({ ...existing, summary });
      return;
    }
    const base = clone(SEED_RESPONSE);
    base.id = uid();
    base.docNames = this.jobs().filter((j) => this.llmSelected().includes(j.jobId)).map((j) => j.name);
    base.timestamp = this.fmtNow();
    base.model = this.modelLabel();
    base.saved = false;
    base.fields = [];
    base.flags = [];
    base.relatedFiles = [];
    base.summary = summary;
    this.response.set(base);
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

  async onSave() {
    const r = this.response();
    if (!r) return;

    // Resolve each related file's archive id from the LIVE docs (not the analyze-time
    // snapshot), so a file archived after analysis is recognised. Any still without an
    // id must be archived first — block and tell the user which one.
    const resolved = (r.relatedFiles ?? []).map((f) => ({
      f,
      archiveId: this.docs().find((d) => d.id === f.docId)?.archiveId ?? f.archiveId,
    }));
    const unarchived = resolved.find((x) => x.archiveId == null);
    if (unarchived) {
      this.addToast(`Archive ${unarchived.f.name} first`, 'error');
      alert(`"${unarchived.f.name}" is not archived yet. Archive it first, then save the analysis response.`);
      return;
    }

    // Link the docs whose OCR content was sent to AI.
    const related = resolved.map((x) => ({ ArchiveId: x.archiveId! }));

    // One insertdatacomplex call: the response is the master, the related-archive rows
    // ride along under the child-entity key. The server inserts the master, then links
    // each child (AIDocumentsResponseID FK + createuser/dates auto-filled).
    // ObjectType mirrors gnr.archive's object_type (the source entity table); ObjectId
    // is the searched process id.
    const payload = {
      ObjectId: Number(this.objectId()),
      ObjectType: DI_CONFIG.taldar.entityTables[this.objectType()] ?? this.objectType(),
      ResponseText: r.summary.replace(/<br>/g, '\n'),
      PromptText: r.prompt ?? null, // the instruction the answer replies to
      ResponseTime: r.elapsedMs ?? null,
      ModelName: r.model,
      'GNR.AIDocuments_RelatedArchive': related,
    };
    try {
      await this.customerService.insertComplex('GNR.AIDocumentsResponse', payload);
      this.response.update((cur) => (cur ? { ...cur, saved: true } : cur));
      this.addToast(`Saved to ${this.contextLabel()}`, 'success');
    } catch (err) {
      console.error('Saving AI response failed:', err);
      this.addToast('Could not save to record', 'error');
    }
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

// ponytail: just the image types an OCR document can be; anything else keeps whatever
// type the fetch reported and the browser decides (inline or download).
const mimeOf = (name: string) => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp' }[ext] ?? '';
};
