import { Injectable } from '@angular/core';
import { DI_CONFIG } from '../config/di.config';

export interface CustomerHit {
  id: number;
  name: string; // "adi Taller (12345678)" — display name + external ref
}

/** Typeahead against TALDAR's metadata autocomplete. */
@Injectable({ providedIn: 'root' })
export class CustomerService {
  async search(term: string): Promise<CustomerHit[]> {
    const url = new URL(DI_CONFIG.taldar.autocompleteEndpoint);
    url.searchParams.set('tablename', DI_CONFIG.taldar.customerTable);
    url.searchParams.set('param', term);
    url.searchParams.set('getcol', 'null');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Customer search failed (${res.status} ${res.statusText})`);
    return (await res.json()) as CustomerHit[];
  }
}
