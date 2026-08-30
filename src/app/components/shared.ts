/* Document Intelligence — icons & small shared components */

import { Component, inject, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FileType, JobStatus } from '../models/models';

/* Lucide-style line-icon inner markup, keyed by name. */
const ICON_PATHS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/>',
  check: '<path d="m5 12 5 5 9-11"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  sparkles: '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8Z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  rerun: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8C6 2 8 2 10 3s4 1 6 0l.6-.3a1 1 0 0 1 1.4.9V14a1 1 0 0 1-.4.8C16 16 14 16 12 15s-4-1-6 0"/>',
  db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
};

@Component({
  selector: 'di-icon',
  template: `<span class="di-icon" [style]="hostStyle()" [innerHTML]="svg()"></span>`,
  styles: [':host{display:inline-flex;line-height:0}.di-icon{display:inline-flex;line-height:0}'],
})
export class IconComponent {
  name = input.required<string>();
  size = input<number>(18);
  svgStyle = input<string>('');

  private san = inject(DomSanitizer);

  hostStyle() {
    return this.svgStyle();
  }

  svg(): SafeHtml {
    const s = this.size();
    const inner = ICON_PATHS[this.name()] ?? '';
    const html =
      `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" ` +
      `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    return this.san.bypassSecurityTrustHtml(html);
  }
}

@Component({
  selector: 'di-file-icon',
  imports: [IconComponent],
  template: `
    <div class="file-icon {{ type() }}{{ extra() ? ' ' + extra() : '' }}">
      <di-icon [name]="ic()" />
      <span class="ext">{{ ext() }}</span>
    </div>
  `,
})
export class FileIconComponent {
  type = input.required<FileType>();
  extra = input<string>('');

  private map: Record<FileType, { ic: string; ext: string }> = {
    pdf: { ic: 'file', ext: 'PDF' },
    word: { ic: 'fileText', ext: 'DOC' },
    image: { ic: 'image', ext: 'IMG' },
  };

  ic() {
    return this.map[this.type()].ic;
  }
  ext() {
    return this.map[this.type()].ext;
  }
}

@Component({
  selector: 'di-status-pill',
  template: `<span class="pill {{ status() }}"><span class="dot"></span>{{ label() }}</span>`,
})
export class StatusPillComponent {
  status = input.required<JobStatus>();

  private labels: Record<JobStatus, string> = {
    queued: 'Queued',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
  };

  label() {
    return this.labels[this.status()];
  }
}

/* ---- Page references in an AI answer ----
   Shared by the analysis result and the chat drawer: both turn `p. 3` into a link
   that opens the original document — the PDF at that page, or the image. */

/** `p.3`, `pp. 3-5`, `page 3`, `pages 3–5`, `עמוד 3`, `עמ' 3` — as the answer or the Sources line writes them. */
export const PAGE_REF = /(?:\bpp?\.\s?|\bpages?\s+|עמ(?:ודים|וד|')\s*)(\d+)(?:\s*[-–]\s*(\d+))?/gi;

/**
 * Writing direction for a piece of text, by the same Hebrew block the ingestion
 * service reads a page's script with.
 *
 * Used instead of `dir="auto"`, which decides on the first strong character in
 * the element: an answer to a Hebrew question that opens with a claim number, an
 * English term or a `<table>` whose first cell is a date would be laid out LTR.
 * The question settles the direction for the whole exchange instead.
 */
export const directionOf = (text: string): 'rtl' | 'ltr' => (/[֐-׿]/.test(text) ? 'rtl' : 'ltr');

/**
 * Every page reference becomes an anchor. The href carries the range because
 * Angular's sanitizer drops data- attributes and inline handlers from
 * [innerHTML]; a delegated click reads it back with readPageClick().
 */
export function linkifyPages(text: string, docNames: string[], openableDocNames: string[] = []): string {
  return text.replace(PAGE_REF, (match, from: string, _to: string | undefined, offset: number, whole: string) => {
    // The nearest document name written before the reference owns it — that is
    // how both the Sources line and a model naming a file read.
    const before = whole.slice(0, offset);
    let doc = 0;
    let at = -1;
    docNames.forEach((n, i) => {
      const found = before.lastIndexOf(n);
      if (found > at) {
        at = found;
        doc = i;
      }
    });
    // A document that can't be fetched has nothing to open — leave the text plain
    // rather than offering a link that only produces an error toast.
    if (!openableDocNames.includes(docNames[doc])) return match;
    return `<a class="page-ref" href="#pgopen=${doc}.${from}" title="Open the original at page ${from}">${match}</a>`;
  });
}

export type PageClick = { docName: string; page: number } | null;

/** Reads a click on linkified text back into the document + page it points at. */
export function readPageClick(e: MouseEvent, docNames: string[]): PageClick {
  const href = (e.target as HTMLElement).closest('a.page-ref')?.getAttribute('href') ?? '';
  const m = /#pgopen=(\d+)\.(\d+)/.exec(href);
  if (!m) return null;
  e.preventDefault();
  const docName = docNames[+m[1]];
  return docName ? { docName, page: +m[2] } : null;
}
