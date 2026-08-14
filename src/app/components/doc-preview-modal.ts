import { Component, HostListener, input, output } from '@angular/core';
import { PREVIEWS } from '../data/data';
import { Doc, Preview } from '../models/models';
import { FileIconComponent, IconComponent } from './shared';

@Component({
  selector: 'di-doc-preview-modal',
  imports: [IconComponent, FileIconComponent],
  template: `
    <div class="modal-scrim" [class.open]="!!doc()" (click)="close.emit()"></div>
    <div class="modal-wrap" [class.open]="!!doc()" [attr.aria-hidden]="!doc()">
      @if (doc(); as d) {
        <div class="doc-modal" role="dialog" [attr.aria-label]="'Preview of ' + d.name" (click)="$event.stopPropagation()">
          <div class="doc-modal-head">
            <di-file-icon [type]="d.type" />
            <div class="dm-titles">
              <div class="dm-name">{{ d.name }}</div>
              <div class="dm-sub">
                <span class="cat-tag">{{ d.category }}</span>
                <span class="dm-date">{{ d.date }}</span>
                @if (p()) { <span class="dm-ref">{{ p()!.ref }}</span> }
              </div>
            </div>
            <button class="drawer-close" (click)="close.emit()" aria-label="Close preview"><di-icon name="close" /></button>
          </div>

          <div class="doc-modal-body">
            <div class="paper">
              @if (p(); as pv) {
                <div class="sheet">
                  <div class="sheet-letterhead">
                    <div class="lh-org">{{ pv.org }}</div>
                    <div class="lh-title">{{ pv.title }}</div>
                    <div class="lh-ref">{{ pv.ref }}</div>
                  </div>

                  @if (pv.meta) {
                    <div class="sheet-meta">
                      @for (m of pv.meta; track $index) {
                        <div class="sm"><span class="smk">{{ m[0] }}</span><span class="smv">{{ m[1] }}</span></div>
                      }
                    </div>
                  }

                  @if (pv.kind === 'form') {
                    <div class="sheet-fields">
                      @for (f of pv.fields ?? []; track $index) {
                        <div class="sf"><span class="sfk">{{ f[0] }}</span><span class="sfv">{{ f[1] }}</span></div>
                      }
                    </div>
                    @if (pv.narrative) {
                      <div class="sheet-block">
                        <div class="sb-title">{{ pv.narrativeTitle }}</div>
                        <p class="sb-text">{{ pv.narrative }}</p>
                      </div>
                    }
                  }

                  @if (pv.kind === 'doc') {
                    <div class="sheet-block">
                      @for (para of pv.paragraphs ?? []; track $index) {
                        <p class="sb-text">{{ para }}</p>
                      }
                    </div>
                  }

                  @if (pv.kind === 'table') {
                    <table class="sheet-table">
                      <thead><tr><th>Line Item</th><th class="r">Amount</th></tr></thead>
                      <tbody>
                        @for (l of pv.lines ?? []; track $index) {
                          <tr><td>{{ l[0] }}</td><td class="r">{{ l[1] }}</td></tr>
                        }
                      </tbody>
                    </table>
                  }

                  @if (pv.kind === 'image') {
                    <div class="sheet-photos">
                      @for (shot of pv.shots ?? []; track $index) {
                        <div class="photo-slot">
                          <di-icon name="image" [size]="26" />
                          <span class="ps-label">{{ shot }}</span>
                        </div>
                      }
                      @if (pv.caption) { <div class="photo-caption">{{ pv.caption }}</div> }
                    </div>
                  }

                  @if (pv.totals) {
                    <div class="sheet-totals">
                      @for (t of pv.totals; track $index; let last = $last) {
                        <div class="st" [class.grand]="last"><span class="stk">{{ t[0] }}</span><span class="stv">{{ t[1] }}</span></div>
                      }
                    </div>
                  }

                  <div class="sheet-foot">
                    <span>TALDAR · Document Intelligence</span>
                    <span class="mono">Rendered preview · OCR source of record</span>
                  </div>
                </div>
              } @else {
                <div class="paper-empty">No preview available for this document.</div>
              }
            </div>
          </div>

          <div class="doc-modal-foot">
            <button class="dm-select" [class.on]="selected()" (click)="toggleSelect.emit(d.id)">
              <span class="cb"><di-icon name="check" [size]="12" /></span>
              {{ selected() ? 'Selected for OCR' : 'Select for OCR' }}
            </button>
            <div class="grow"></div>
            <button class="act-btn" (click)="close.emit()"><di-icon name="download" [size]="15" /> Download</button>
            <button class="act-btn primary" (click)="close.emit()">Close</button>
          </div>
        </div>
      }
    </div>
  `,
})
export class DocPreviewModalComponent {
  doc = input.required<Doc | null>();
  selected = input.required<boolean>();

  toggleSelect = output<string>();
  close = output<void>();

  p(): Preview | undefined {
    const d = this.doc();
    return d ? PREVIEWS[d.id] : undefined;
  }

  @HostListener('window:keydown.escape')
  onEsc() {
    if (this.doc()) this.close.emit();
  }
}
