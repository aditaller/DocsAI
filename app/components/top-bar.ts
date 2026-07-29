import { Component, input } from '@angular/core';
import { IconComponent } from './shared';

@Component({
  selector: 'di-top-bar',
  imports: [IconComponent],
  template: `
    <header class="topbar">
      <div class="brand">
        <img src="assets/taldar-logo-white.png" alt="TALDAR" />
        <span class="divider"></span>
        <span class="screen-title">Document Intelligence</span>
      </div>
      <div class="crumbs">
        <di-icon name="chevron" [size]="14" svgStyle="transform:rotate(-90deg);opacity:.5" />
        <span class="seg">Intake &amp; Analysis</span>
        <span class="chev">·</span>
        <span style="font-family:var(--font-mono);font-size:12px">{{ contextLabel() }}</span>
      </div>
      <div class="spacer"></div>
      <span class="module-tag">Claims Workspace</span>
      <div class="avatar">DO</div>
    </header>
  `,
})
export class TopBarComponent {
  contextLabel = input.required<string>();
}
