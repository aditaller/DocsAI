import { createHash } from 'node:crypto';

import type { TextChunk, TextPage } from './types.js';

export function contentHash(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function chunkPages(pages: TextPage[], maximumCharacters: number, overlapCharacters: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  let current = '';
  let startPage = 1;
  let endPage = 1;

  const emit = (): void => {
    const content = current.trim();
    if (content) chunks.push({ index: chunks.length, pageStart: startPage, pageEnd: endPage, content });
  };

  for (const page of pages) {
    const text = page.text.trim();
    if (!text) continue;
    const decorated = `\n[Page ${page.pageIndex}]\n${text}\n`;
    if (!current) {
      current = decorated;
      startPage = page.pageIndex;
      endPage = page.pageIndex;
    } else if (current.length + decorated.length <= maximumCharacters) {
      current += decorated;
      endPage = page.pageIndex;
    } else {
      emit();
      const overlap = current.slice(Math.max(0, current.length - overlapCharacters)).trim();
      current = `${overlap}\n${decorated}`;
      startPage = page.pageIndex;
      endPage = page.pageIndex;
    }

    while (current.length > maximumCharacters) {
      const boundary = findBoundary(current, maximumCharacters);
      const head = current.slice(0, boundary).trim();
      if (head) chunks.push({ index: chunks.length, pageStart: startPage, pageEnd: page.pageIndex, content: head });
      current = current.slice(Math.max(0, boundary - overlapCharacters)).trim();
      startPage = page.pageIndex;
      endPage = page.pageIndex;
    }
  }
  emit();
  return chunks;
}

function findBoundary(text: string, max: number): number {
  const slice = text.slice(0, max);
  return Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('. '), slice.lastIndexOf(' '), Math.min(max, text.length));
}
