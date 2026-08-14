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

  async search(term: string, table: string): Promise<CustomerHit[]> {
    const url = new URL(DI_CONFIG.taldar.autocompleteEndpoint, location.origin);
    url.searchParams.set('tablename', table);
    url.searchParams.set('param', term);
    url.searchParams.set('getcol', 'null');
    return this.get<CustomerHit[]>(url, 'Process search');
  }

  /** Archived documents linked to a process (gnr.archive, objectid = the process id).
   *  `table` is the source entity (bp.customer / pol.policy / clm.claimevent) and doubles
   *  as the object_type that ties archive rows to it. */
  async documents(objectId: number, table: string): Promise<ArchiveRow[]> {
    const url = new URL(DI_CONFIG.taldar.entityEndpoint, location.origin);
    url.searchParams.set('entity', DI_CONFIG.taldar.archiveEntity);
    url.searchParams.set('rows', String(DI_CONFIG.taldar.archiveRows));
    url.searchParams.set('page', '0');
    url.searchParams.set('orderby', 'null');
    url.searchParams.set('parentname', 'objectid');
    url.searchParams.set('parentid', String(objectId));
    url.searchParams.set('whereparm', `object_type='${table}' `);
    url.searchParams.set('userid', String(DI_CONFIG.taldar.userId));
    url.searchParams.set('id', '');

    const body = await this.get<unknown>(url, 'Archive lookup');
    // ponytail: endpoint may return a bare array or a paged envelope; accept both
    // rather than guessing wrong. Pin to one shape once confirmed.
    if (Array.isArray(body)) return body as ArchiveRow[];
    const env = body as Record<string, unknown>;
    return ((env?.['rows'] ?? env?.['data'] ?? env?.['items'] ?? []) as ArchiveRow[]);
  }

  /** Insert one row via the generic TALDAR savedata route (?entity=table, JSON body).
   *  Returns the new identity id when the route reports one (bare number, or an
   *  id/ID/newid field), else null — callers that don't need the id ignore it. */
  async saveData(entity: string, row: Record<string, unknown>): Promise<number | null> {
    const url = new URL(DI_CONFIG.taldar.saveDataEndpoint, location.origin);
    url.searchParams.set('entity', entity);
    const res = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { ...this.auth.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    });
    const text = await res.text();
    if (this.auth.sessionExpired(res.status, text)) throw new Error('Save failed: session expired');
    if (!res.ok) throw new Error(`Save failed (${res.status} ${res.statusText})`);
    return newId(text);
  }

  /** Master+detail insert via insertdatacomplex. `data` is the master row with each
   *  child collection embedded under a key equal to the child entity name; the server
   *  inserts the master, links each child (FK + createuser/dates auto-filled) and
   *  returns the new master id. */
  async insertComplex(entity: string, data: Record<string, unknown>): Promise<number | null> {
    const url = new URL(DI_CONFIG.taldar.insertComplexEndpoint, location.origin);
    url.searchParams.set('entity', entity);
    const res = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { ...this.auth.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const text = await res.text();
    if (this.auth.sessionExpired(res.status, text)) throw new Error('Save failed: session expired');
    if (!res.ok) throw new Error(`Save failed (${res.status} ${res.statusText})`);
    return newId(text);
  }

  /** Upload a file into gnr.archive via the multipart upload route: the server saves it
   *  to disk (fullpath), inserts the archive row and returns the new archive id
   *  (`{ count, ids, id }`). Returns that id so the caller can link it right away. */
  async uploadFile(entityName: string, entityId: number, file: File, note = '', documentTypeId = DI_CONFIG.taldar.defaultDocumentTypeId): Promise<number | null> {
    const url = new URL(DI_CONFIG.taldar.uploadEndpoint, location.origin);
    url.searchParams.set('entityname', entityName);
    url.searchParams.set('entityid', String(entityId));
    url.searchParams.set('documenttypeid', String(documentTypeId));
    url.searchParams.set('note', note);
    const form = new FormData();
    form.append('file', file, file.name);
    // No Content-Type header: the browser sets multipart/form-data with the boundary.
    const res = await fetch(url.toString(), {
      method: 'POST',
      credentials: 'include',
      headers: { ...this.auth.authHeader() },
      body: form,
    });
    const text = await res.text();
    if (this.auth.sessionExpired(res.status, text)) throw new Error('Upload failed: session expired');
    if (!res.ok) throw new Error(`Upload failed (${res.status} ${res.statusText})`);
    return newId(text);
  }

  // credentials: 'include' sends the TALDAR auth cookie — the API answers
  // "JWT was empty" without it. Backend CORS already sets AllowCredentials().
  private async get<T>(url: URL, what: string): Promise<T> {
    const res = await fetch(url.toString(), {
      credentials: 'include',
      headers: this.auth.authHeader(),
    });
    const text = await res.text();
    if (this.auth.sessionExpired(res.status, text)) throw new Error(`${what} failed: session expired`);
    if (!res.ok) throw new Error(`${what} failed (${res.status} ${res.statusText})`);
    return JSON.parse(text) as T;
  }
}

// savedata's reply shape isn't pinned: a bare id, or a JSON scalar/object. Pull the
// first thing that looks like an identity id; null if none (caller falls back).
const newId = (text: string): number | null => {
  const t = text.trim();
  if (/^\d+$/.test(t)) return Number(t);
  try {
    const j = JSON.parse(t);
    if (typeof j === 'number') return j;
    const v = j?.id ?? j?.ID ?? j?.newid ?? j?.Id;
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  } catch { /* not json */ }
  return null;
};

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
  const name = pick(r, 'filename', 'file_name', 'name', 'title', 'subject') ?? `document-${pick(r, 'archiveid') ?? uid()}`;
  const raw = pick(r, 'createdate', 'create_date', 'insert_date', 'date', 'doc_date');
  const d = raw ? new Date(raw) : null;
  const archiveId = pick(r, 'archiveid', 'id'); // gnr.v_Archive exposes the gnr.archive id as archiveid
  return {
    id: archiveId ?? uid(),
    name,
    type: fileType(name),
    date: d && !isNaN(d.getTime()) ? fmtDate(d) : '—',
    category: pick(r, 'doc_type', 'category', 'archive_type') ?? 'Archive',
    selected: false,
    path: pick(r, 'fullpath'), // disk path the main app's openfile() feeds to getarchivedata
    isFromArchive: true,
    archiveId: archiveId ? Number(archiveId) : null,
  };
};
