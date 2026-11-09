import { Component, computed, inject, input, output } from '@angular/core';
import { IconComponent } from './shared';
import { AuthService } from '../services/auth.service';
import { LocalHealth } from '../services/local-rag.service';

@Component({
  selector: 'di-top-bar',
  imports: [IconComponent],
  template: `
    <header class="topbar">
     
      <div class="brand">
       <di-icon name="layers" [size]="18" />
        <img src="assets/taldar-logo-white.png" alt="TALDAR" />
        -
        <span class="screen-title">Document Ingest</span>
      </div>
      <div class="crumbs">
        <di-icon name="chevron" [size]="14" svgStyle="transform:rotate(-90deg);opacity:.5" />
        <span class="seg">Intake &amp; Analysis</span>
        <span class="chev">·</span>
        <span style="font-family:var(--font-mono);font-size:12px">{{ contextLabel() }}</span>
      </div>
      <div class="spacer"></div>
      <div class="mode-switch" role="group" aria-label="Processing engine">
        <button data-testid="mode-azure" [class.on]="mode() === 'azure'" (click)="modeChange.emit('azure')">Use Azure</button>
        <button
          data-testid="mode-local"
          [class.on]="mode() === 'local'"
          [disabled]="!health()?.ok"
          [title]="localHint()"
          (click)="modeChange.emit('local')"
        >
          Use Local RAG
        </button>
      </div>
      <span class="module-tag">Claims Workspace</span>
      <div
        class="avatar"
        data-testid="user-avatar"
        [title]="auth.username() + ' — right-click to log out'"
        (contextmenu)="logout($event)"
      >
        {{ auth.username() || 'Guest' }}
      </div>
    </header>
  `,
})
export class TopBarComponent {
  contextLabel = input.required<string>();
  mode = input.required<'azure' | 'local'>();
  health = input<LocalHealth | null>(null);

  modeChange = output<'azure' | 'local'>();

  protected auth = inject(AuthService);

  /** Says which piece is missing, so an unstarted service is not mistaken for a bug. */
  localHint = computed(() => {
    const h = this.health();
    if (!h) return 'Checking the local RAG service…';
    if (!h.postgres && !h.ollama) return 'Local RAG service is not running (npm run serve in ingestion-service)';
    if (!h.postgres) return 'PostgreSQL/pgvector is unreachable or the rag schema is not migrated';
    if (!h.ollama) return 'Ollama is unreachable at its configured loopback address';
    if (h.missingModels.length) return `Ollama is missing: ${h.missingModels.join(', ')}`;
    // The tesseract container is optional: Ollama can still read the pages, so
    // this warns rather than disabling the mode.
    if (!h.tesseract) return 'Ready, but the tesseract container is not answering — pick Ollama Vision in the OCR board';
    // Same shape as the tesseract warning: images still work, so this informs
    // rather than blocks. Without it a PDF only fails once it is already uploaded.
    if (!h.pdftoppm) return 'Ready for images, but PDFs cannot be read — install Poppler and set PDFTOPPM_PATH';
    // No per-record check: the scope row is created on first ingest.
    return 'Local OCR into pgvector, answers from the local model';
  });

  logout(e: MouseEvent) {
    e.preventDefault(); // suppress the browser context menu
    this.auth.logout();
  }
}
