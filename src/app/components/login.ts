import { Component, signal } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { IconComponent } from './shared';

@Component({
  selector: 'di-login',
  imports: [IconComponent],
  // Native <form> with template refs — no FormsModule needed for two fields.
  template: `
    <div class="login-shell">
      <form class="login-card" (submit)="submit($event, u.value, p.value)">
        <div class="eyebrow">
        <di-icon name="layers" [size]="20" /> &nbsp;
        <img src="assets/taldar-logo-white.png" alt="TALDAR" width="80" style="top: 4px; position: relative;" /> · Document Ingest</div>
        <h1>Sign in</h1>

        <label class="login-field">
          <span>Username</span>
          <input #u class="login-input" name="username" autocomplete="username" spellcheck="false" autofocus />
        </label>

        <label class="login-field">
          <span>Password</span>
          <input #p class="login-input" name="password" type="password" autocomplete="current-password" />
        </label>

        @if (error()) {
          <p class="login-error" role="alert">{{ error() }}</p>
        }

        <button class="btn-primary" type="submit" [disabled]="busy()">
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  `,
  styles: [
    `
      .login-shell {
        min-height: 100vh;
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        background: var(--canvas);
      }
      .login-card {
        width: 100%; max-width: 360px;
        display: flex; flex-direction: column; gap: 14px;
        background: var(--doc);
        border: 1px solid var(--rule-strong);
        border-radius: var(--r);
        padding: 32px;
      }
      .eyebrow {
        display: flex; align-items: center;
        font-family: var(--font-mono);
        font-size: 10px; font-weight: 500; letter-spacing: 0.13em; text-transform: uppercase;
        color: var(--ink-3);
      }
      /* the only logo asset is white-on-transparent — render it as ink */
      .eyebrow img { filter: brightness(0); opacity: 0.92; }
      h1 {
        font-family: var(--font-display);
        font-variation-settings: 'SOFT' 0, 'WONK' 0, 'opsz' 40;
        font-size: 26px; font-weight: 500; letter-spacing: -0.015em;
        color: var(--ink);
        margin: 4px 0 6px;
      }
      .login-field { display: flex; flex-direction: column; gap: 6px; }
      .login-field span {
        font-family: var(--font-mono);
        font-size: 9.5px; font-weight: 500; letter-spacing: 0.11em; text-transform: uppercase;
        color: var(--ink-4);
      }
      .login-input {
        font-family: var(--font-sans);
        font-size: 14px;
        color: var(--ink);
        background: var(--canvas);
        border: 1px solid var(--rule-strong);
        border-radius: var(--r);
        padding: 10px 12px;
        outline: none;
        transition: border-color 140ms ease, background 140ms ease;
      }
      .login-input:hover { border-color: var(--ink-4); }
      .login-input:focus { border-color: var(--ink); background: var(--doc); }
      .login-error { font-size: 13px; color: var(--flag); margin: 0; }
    `,
  ],
})
export class LoginComponent {
  busy = signal(false);
  error = signal('');

  constructor(private auth: AuthService) {}

  async submit(e: Event, username: string, password: string) {
    e.preventDefault();
    if (!username || !password) return this.error.set('Username and password are required');
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(username, password);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Login failed');
    } finally {
      this.busy.set(false);
    }
  }
}
