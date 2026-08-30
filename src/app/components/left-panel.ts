import { Component, computed, input, output, signal } from '@angular/core';
import { DI_CONFIG } from '../config/di.config';
import { Doc } from '../models/models';
import { CustomerHit, CustomerService } from '../services/customer.service';
import { FileIconComponent, IconComponent } from './shared';

@Component({
  selector: 'di-left-panel',
  imports: [IconComponent, FileIconComponent],
  template: `
    <aside class="left-panel">
      <div class="panel-head">
        <div class="eyebrow"> Process Context</div>
        <div class="ctx-bar">
          <div class="segmented" role="tablist">
            @for (t of types; track t) {
              <button
                [attr.data-testid]="'object-type-' + t.toLowerCase().replace(' ', '-')"
                [class.active]="objectType() === t"
                (click)="objectTypeChange.emit(t)"
              >{{ t }}</button>
            }
          </div>
          <div class="id-row">
            <div class="id-input-wrap">
              <span class="lead">{{ prefix() }}-</span>
              <input
                class="id-input"
                data-testid="object-id"
                [value]="display() ?? objectId()"
                (input)="onId($any($event.target).value)"
                list="process-hits"
                spellcheck="false"
                aria-label="Object ID"
              />
              <datalist id="process-hits">
                @for (c of hits(); track c.id) {
                  <option [value]="c.name"></option>
                }
              </datalist>
            </div>
            <button class="icon-btn" data-testid="object-id-lookup" title="Look up process" aria-label="Look up process">
              <di-icon name="search" />
            </button>
          </div>
          <span class="linked-badge">
            <span class="dot"></span>
            {{ linkedCount() }} documents linked to this process
          </span>
        </div>
      </div>

      <div class="list-toolbar">
        <span class="count"><b>{{ docs().length }}</b> documents · <b>{{ selectedCount() }}</b> selected</span>
        <label class="ghost-btn" data-testid="load-from-server" style="cursor:pointer">
          <di-icon name="refresh" [size]="14" />
          Load from Server
          <input
            type="file"
            data-testid="file-input"
            (change)="onFiles($any($event.target).files); $any($event.target).value = ''"
            style="position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0 0 0 0)"
          />
        </label>
      </div>

      <div class="doc-list">
        @for (d of docs(); track d.id) {
          <!-- testids are positional: the recorder/replay needs a handle that means the
               same thing on both runs, and d.id is regenerated per session. -->
          <div class="doc-card" [attr.data-testid]="'doc-card-' + $index" [class.selected]="d.selected">
            <div
              class="checkbox"
              [attr.data-testid]="'doc-checkbox-' + $index"
              role="checkbox"
              [attr.aria-checked]="d.selected"
              (click)="$event.stopPropagation(); toggle.emit(d.id)"
              [title]="d.selected ? 'Deselect' : 'Select for OCR'"
            >
              <di-icon name="check" [size]="13" />
            </div>
            <di-file-icon [type]="d.type" />
            <div class="doc-meta">
              <div
                class="name"
                [attr.data-testid]="'doc-preview-' + $index"
                role="button"
                tabindex="0"
                [title]="d.name"
                (click)="preview.emit(d)"
                (keydown.enter)="preview.emit(d)"
              >{{ d.name }}</div>
              <div class="sub">
                <span class="date">{{ d.date }}</span>
                <span class="cat-tag">{{ d.category }}</span>
                @if (d.file && !d.isFromArchive) {
                  <span class="not-arch">Not Archived</span>
                }
              </div>

            </div>
            @if (d.file && !d.isFromArchive) {
              <button
                class="arch-btn"
                [attr.data-testid]="'doc-archive-' + $index"
                [disabled]="archiving().includes(d.id)"
                title="Save this file to the record archive"
                (click)="$event.stopPropagation(); archive.emit(d.id)"
              >
                <di-icon name="save" [size]="12" />
                {{ archiving().includes(d.id) ? 'Archiving…' : 'Archive' }}
              </button>
            }
            <span
              class="doc-open"
              [attr.data-testid]="'doc-open-' + $index"
              role="button"
              tabindex="0"
              [title]="d.file ? 'Open file' : 'Preview'"
              (click)="$event.stopPropagation(); open.emit(d)"
            ><di-icon name="eye" [size]="15" /></span>
            <span
              class="doc-open"
              [attr.data-testid]="'doc-remove-' + $index"
              role="button"
              tabindex="0"
              [title]="d.isFromArchive ? 'Delete from archive' : 'Remove file'"
              (click)="$event.stopPropagation(); remove.emit(d.id)"
            ><di-icon name="trash" [size]="15" /></span>
          </div>
        }
      </div>

      <div class="left-footer">
        <button class="btn-primary" data-testid="attach-send-ocr" (click)="attach.emit()" [disabled]="selectedCount() === 0">
          <di-icon name="bolt" [size]="17" />
          Attach &amp; Send to OCR
          @if (selectedCount() > 0) {
            <span class="pill-count">{{ selectedCount() }}</span>
          }
        </button>
      </div>
    </aside>
  `,
})
export class LeftPanelComponent {
  objectType = input.required<string>();
  objectId = input.required<string>();
  linkedCount = input.required<number>();
  docs = input.required<Doc[]>();
  selectedCount = input.required<number>();
  archiving = input<string[]>([]); // docIds currently being archived

  objectTypeChange = output<string>();
  archive = output<string>();
  objectIdChange = output<string>();
  processPicked = output<CustomerHit>();
  toggle = output<string>();
  filesPicked = output<File[]>();
  attach = output<void>();
  preview = output<Doc>();
  open = output<Doc>();
  remove = output<string>();

  onFiles(list: FileList | null) {
    if (list && list.length) this.filesPicked.emit(Array.from(list));
  }

  // ---- Customer typeahead ----
  hits = signal<CustomerHit[]>([]);
  /** What the box shows once the user has typed; null = still mirroring objectId. */
  display = signal<string | null>(null);
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private customers: CustomerService) {}

  // ponytail: native <datalist> instead of a custom dropdown; 250ms debounce and
  // no request cancellation — add an AbortController if the backend gets slow.
  onId(v: string) {
    this.display.set(v);

    // Exact hit name means the user picked from the datalist: keep the name on
    // screen, hand the parent the customer id, and don't search for it again.
    const picked = this.hits().find((h) => h.name === v);
    if (picked) {
      clearTimeout(this.timer);
      this.objectIdChange.emit(String(picked.id));
      this.processPicked.emit(picked);
      return;
    }

    this.objectIdChange.emit(v);
    clearTimeout(this.timer);
    const term = v.trim();
    if (term.length < 2) return this.hits.set([]);
    const table = DI_CONFIG.taldar.entityTables[this.objectType()];
    if (!table) return this.hits.set([]);
    this.timer = setTimeout(async () => {
      try {
        this.hits.set(await this.customers.search(term, table));
      } catch (err) {
        console.error('Process search failed:', err);
        this.hits.set([]);
      }
    }, 250);
  }

  readonly types = ['Customer', 'Policy', 'Claim','Risk Event'];
  private prefixes: Record<string, string> = { Claim: 'CLM', Policy: 'POL', Customer: 'CST', 'Risk Event': 'RISK' };
  prefix = computed(() => this.prefixes[this.objectType()]);
}
