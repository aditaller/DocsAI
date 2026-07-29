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
        <div class="eyebrow"><di-icon name="layers" [size]="13" /> TALDAR · Document Intelligence</div>
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
      }
      .login-card {
        width: 100%; max-width: 360px;
        display: flex; flex-direction: column; gap: 14px;
        background: var(--bg-panel);
        border: 1px solid var(--glass-border);
        border-radius: var(--r-md);
        padding: 28px;
      }
      h1 { font-size: 20px; font-weight: 700; color: var(--fg1); margin: 0 0 4px; }
      .login-field { display: flex; flex-direction: column; gap: 6px; }
      .login-field span { font-size: 12px; color: var(--fg3); }
      .login-input {
        font-family: var(--font-sans);
        font-size: 14px;
        color: var(--fg1);
        background: var(--bg-deep);
        border: 1px solid var(--glass-border);
        border-radius: var(--r-sm);
        padding: 10px 12px;
        outline: none;
        transition: border-color .2s, box-shadow .2s;
      }
      .login-input:focus { border-color: var(--accent); box-shadow: var(--accent-glow); }
      .login-error { font-size: 13px; color: var(--danger); margin: 0; }
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
