import { Injectable, signal } from '@angular/core';
import { DI_CONFIG } from '../config/di.config';

const FLAG = 'di.authed';
const TOKEN = 'di.jwt';
const USER = 'di.user';

/**
 * checktoken() takes the JWT from either the `jwt` cookie or an
 * `Authorization: Bearer` header, so we feed both: `credentials: 'include'`
 * replays the cookie (HttpOnly — JS can't read it), and any token the login
 * response hands back is kept here and sent as a header.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  authed = signal(localStorage.getItem(FLAG) === '1');
  username = signal(localStorage.getItem(USER) ?? '');
  private token = localStorage.getItem(TOKEN);

  /** Bearer header when we hold a token; empty when the cookie is doing the work. */
  authHeader(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async login(username: string, password: string): Promise<void> {
    const res = await fetch(DI_CONFIG.taldar.loginEndpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      // 401 body: { Message, IsBlocked, RemainingAttempts } — surface the countdown,
      // the account locks out once it hits zero.
      const err = (await res.json().catch(() => ({}))) as { Message?: string; RemainingAttempts?: number };
      const msg = err.Message ?? `Login failed (${res.status} ${res.statusText})`;
      throw new Error(
        err.RemainingAttempts != null ? `${msg} — ${err.RemainingAttempts} attempt(s) left` : msg
      );
    }

    // A JWT is always `eyJ….….…` (base64url header.payload.signature), so scan
    // the raw response for that shape — works no matter what field name TALDAR
    // uses or how deeply it's nested. Fall back to the Authorization header.
    const raw = await res.text();
    const jwt =
      raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0] ??
      res.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ??
      null;
    this.token = jwt;
    if (this.token) {
      localStorage.setItem(TOKEN, this.token);
      // The login response carries no Set-Cookie — TALDAR's front end plants the
      // cookie itself, which is why checktoken() finds Request.Cookies["jwt"].
      // Same-origin thanks to the proxy, so it rides along on every /api call.
      document.cookie = `jwt=${this.token}; path=/; SameSite=Lax`;
    }

    localStorage.setItem(FLAG, '1');
    localStorage.setItem(USER, username);
    this.username.set(username);
    this.authed.set(true);
  }

  logout() {
    localStorage.removeItem(FLAG);
    localStorage.removeItem(TOKEN);
    localStorage.removeItem(USER);
    document.cookie = 'jwt=; path=/; max-age=0';
    this.token = null;
    this.username.set('');
    this.authed.set(false);
  }
}
