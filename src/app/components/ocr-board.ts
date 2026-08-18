import { Component, computed, input, output } from '@angular/core';
import { DI_CONFIG, findEngine, OcrEngine } from '../config/di.config';
import { Job } from '../models/models';
import { FileIconComponent, IconComponent, StatusPillComponent } from './shared';

@Component({
  selector: 'di-ocr-board',
  imports: [IconComponent, FileIconComponent, StatusPillComponent],
  template: `
    <section class="zone">
      <div class="zone-mark"><span class="n">01</span><span class="l">OCR</span></div>
      <div class="zone-head">
        <div class="z-icon"><di-icon name="cpu" [size]="16" /></div>
        <div>
          <div class="z-title">Status Board</div>
          <div class="z-sub">{{ engine().label }} · parallel processing</div>
        </div>
        <div class="spacer"></div>
        <div class="select-wrap ocr-engine">
          <select [value]="engineId()" (change)="engineChange.emit($any($event.target).value)" aria-label="OCR engine">
            @for (e of engines(); track e.id) {
              <option [value]="e.id">OCR: {{ e.label }}</option>
            }
          </select>
          <span class="chev"><di-icon name="chevron" [size]="15" /></span>
        </div>
        <span class="pill completed"><span class="dot"></span>{{ completed() }} done</span>
        @if (processing() > 0) {
          <span class="pill processing"><span class="dot"></span>{{ processing() }} live</span>
        }
        @if (queued() > 0) {
          <span class="pill queued"><span class="dot"></span>{{ queued() }} queued</span>
        }
      </div>
      <div class="zone-body">
        <div class="ocr-scroll">
        <table class="ocr-table">
          <thead>
            <tr>
              <th>Document</th>
              <th>Status</th>
              <th class="num">Confidence</th>
              <th class="num">Pages</th>
              <th class="num">Total time</th>
              <th>Timestamp</th>
              <th>Raw</th>
            </tr>
          </thead>
          <tbody>
            @for (j of jobs(); track j.jobId) {
              <tr [class.row-processing]="j.status === 'processing'">
                <td>
                  <div class="doc-cell">
                    <di-file-icon [type]="j.type" />
                    <span class="nm">{{ j.name }}</span>
                  </div>
                </td>
                <td>
                  <di-status-pill [status]="j.status" />
                  @if (j.status === 'failed' && j.error) {
                    <!-- The toast is long gone by the time anyone reads the board; hover for the untruncated reason. -->
                    <div class="fail-note" [title]="j.error">{{ j.error }}</div>
                  }
                </td>
                <td class="num">
                  @if (j.status === 'completed') {
                    <!-- No score to show rather than a made-up number: an Ollama build without
                         logprobs, or a document whose text was reused from the index. -->
                    @if (j.confidence === null) {
                      <span class="muted" title="No confidence score for this run">—</span>
                    } @else {
                      <span class="conf-strong">{{ j.confidence }}%</span>
                    }
                  } @else if (j.status === 'processing') {
                    <div class="mini-prog">
                      <div class="track"><div class="fill" [style.width.%]="j.progress"></div></div>
                      <span class="pct">{{ round(j.progress) }}%</span>
                    </div>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td class="num">
                  @if (j.status === 'queued') {
                    <span class="muted">{{ j.pages }}</span>
                  } @else {
                    {{ j.pages }}
                  }
                </td>
                <td class="num">
                  @if (j.status === 'completed' && j.totalMs !== null) {
                    <span class="ts">{{ duration(j.totalMs) }}</span>
                  } @else {
                    <span class="muted">—</span>
                  }
                </td>
                <td><span class="ts">{{ j.ts }}</span></td>
                <td>
                  @if (j.status === 'completed') {
                    <button class="raw-link" (click)="viewRaw.emit(j)">
                      <di-icon name="eye" [size]="12" /> View Raw OCR
                    </button>
                    <button class="raw-link" (click)="saveOcr.emit(j)" [disabled]="!j.ocr" title="Save full OCR result to gnr.archive_OCR">
                      <di-icon name="save" [size]="12" /> Save OCR data
                    </button>
                  } @else {
                    <span class="muted" style="font-size:11.5px">—</span>
                  }
                  @if (j.status !== 'processing') {
                    <button class="raw-link" (click)="rerun.emit(j)" [title]="'Run OCR again with ' + engine().label">
                      <di-icon name="refresh" [size]="12" /> Re-run OCR
                    </button>
                  }
                  <button class="raw-link" (click)="removeJob.emit(j)" title="Remove file from the board">
                    <di-icon name="trash" [size]="12" /> Remove
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
        </div>
      </div>
    </section>
  `,
})
export class OcrBoardComponent {
  jobs = input.required<Job[]>();
  engineId = input.required<string>();

  viewRaw = output<Job>();
  saveOcr = output<Job>();
  removeJob = output<Job>();
  rerun = output<Job>();
  engineChange = output<string>();

  /** Cloud and local modes offer different engines; the caller passes the live list. */
  engines = input<OcrEngine[]>(DI_CONFIG.ocr.engines);
  engine = computed(() => findEngine(this.engines(), this.engineId()));

  completed = computed(() => this.jobs().filter((j) => j.status === 'completed').length);
  processing = computed(() => this.jobs().filter((j) => j.status === 'processing').length);
  queued = computed(() => this.jobs().filter((j) => j.status === 'queued').length);

  round(n: number) {
    return Math.round(n);
  }

  /** Sub-second work reads better in ms; a multi-minute vision run reads better as m:ss. */
  duration(ms: number) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
}
