import { Injectable } from '@angular/core';
import { DI_CONFIG } from '../config/di.config';
import { fileType, fmtDate, uid } from '../data/data';
import { Doc } from '../models/models';
import { AuthService } from './auth.service';

export interface CustomerHit {
  id: number;
  name: string; // "adi Taller (12345678)" — display name + external ref
}

/** One gnr.archive row. Column names come straight from the table. */
export type ArchiveRow = Record<string, unknown>;

/** TALDAR metadata API: customer typeahead + their archived documents. */
@Injectable({ providedIn: 'root' })
export class CustomerService {
  constructor(private auth: AuthService) {}

  async search(term: string): Promise<CustomerHit[]> {
    const url = new URL(DI_CONFIG.taldar.autocompleteEndpoint, location.origin);
    url.searchParams.set('tablename', DI_CONFIG.taldar.customerTable);
    url.searchParams.set('param', term);
    url.searchParams.set('getcol', 'null');
    return this.get<CustomerHit[]>(url, 'Customer search');
  }

  /** Archived documents linked to a customer (gnr.archive, objectid = customer id). */
  async documents(customerId: number): Promise<ArchiveRow[]> {
    const url = new URL(DI_CONFIG.taldar.entityEndpoint, location.origin);
    url.searchParams.set('entity', DI_CONFIG.taldar.archiveEntity);
    url.searchParams.set('rows', String(DI_CONFIG.taldar.archiveRows));
    url.searchParams.set('page', '0');
    url.searchParams.set('orderby', 'null');
    url.searchParams.set('parentname', 'objectid');
    url.searchParams.set('parentid', String(customerId));
    url.searchParams.set('whereparm', `object_type='${DI_CONFIG.taldar.customerTable}' `);
    url.searchParams.set('userid', String(DI_CONFIG.taldar.userId));
    url.searchParams.set('id', '');

    const body = await this.get<unknown>(url, 'Archive lookup');
    // ponytail: endpoint may return a bare array or a paged envelope; accept both
    // rather than guessing wrong. Pin to one shape once confirmed.
    if (Array.isArray(body)) return body as ArchiveRow[];
    const env = body as Record<string, unknown>;
    return ((env?.['rows'] ?? env?.['data'] ?? env?.['items'] ?? []) as ArchiveRow[]);
  }

  // credentials: 'include' sends the TALDAR auth cookie — the API answers
  // "JWT was empty" without it. Backend CORS already sets AllowCredentials().
  private async get<T>(url: URL, what: string): Promise<T> {
    const res = await fetch(url.toString(), {
      credentials: 'include',
      headers: this.auth.authHeader(),
    });
    if (res.status === 401) {
      this.auth.logout(); // cookie expired — bounce back to the login screen
      throw new Error(`${what} failed: session expired`);
    }
    if (!res.ok) throw new Error(`${what} failed (${res.status} ${res.statusText})`);
    return (await res.json()) as T;
  }
}

const pick = (r: ArchiveRow, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = r[k];
    if (v !== null && v !== undefined && v !== '') return String(v);
  }
  return undefined;
};

// ponytail: gnr.archive's column names aren't pinned down yet, so read through
// the likely aliases. Replace with the real three once a row is confirmed.
export const archiveToDoc = (r: ArchiveRow): Doc => {
  const name = pick(r, 'filename', 'file_name', 'name', 'title', 'subject') ?? `document-${pick(r, 'id') ?? uid()}`;
  const raw = pick(r, 'createdate', 'create_date', 'insert_date', 'date', 'doc_date');
  const d = raw ? new Date(raw) : null;
  return {
    id: pick(r, 'id', 'archiveid') ?? uid(),
    name,
    type: fileType(name),
    date: d && !isNaN(d.getTime()) ? fmtDate(d) : '—',
    category: pick(r, 'doc_type', 'category', 'archive_type') ?? 'Archive',
    selected: false,
    path: pick(r, 'fullpath'), // disk path the main app's openfile() feeds to getarchivedata
  };
};
