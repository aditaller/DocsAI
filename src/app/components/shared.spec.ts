import { describe, expect, it } from 'vitest';
import { linkifyPages, renderMarkdown } from './shared';

/* The chat model writes markdown, so the bubble's whole appearance rests on
   renderMarkdown. These cover the two halves that are easy to get wrong: what
   counts as a fence worth unwrapping, and what must never be read as markup. */

describe('renderMarkdown', () => {
  it('renders an answer the model wrapped in a ```markdown fence', () => {
    const html = renderMarkdown(
      '```markdown\n## Findings\n\n- Claim **4471** filed p. 3\n- Amount: 1,250 ILS\n\n| Field | Value |\n| --- | --- |\n| Date | 2024-01-02 |\n```',
    );
    expect(html).not.toContain('<pre');
    expect(html).toContain('<h2>Findings</h2>');
    expect(html).toContain('<li>Claim <strong>4471</strong> filed p. 3</li>');
    expect(html).toContain('<table><thead><tr><th>Field</th><th>Value</th></tr></thead>');
    expect(html).toContain('<td>Date</td><td>2024-01-02</td>');
  });

  it('unwraps an untagged fence that reads as markdown, but not a snippet', () => {
    expect(renderMarkdown('```\n# Title\ntext\n```')).toContain('<h1>Title</h1>');
    expect(renderMarkdown('```\nconst a = 1;\n```')).toContain('<pre><code>const a = 1;');
  });

  it('keeps a real code block as escaped code, outside the paragraph', () => {
    const html = renderMarkdown('Here:\n\n```sql\nSELECT * FROM rag.document WHERE x < 3 AND y > 1\n```');
    expect(html).toContain('<pre><code>SELECT');
    // Escaped, because a model quoting a document must never inject markup.
    expect(html).toContain('x &lt; 3 AND y &gt; 1');
    expect(html).not.toMatch(/<p><pre/);
  });

  it('leaves the page-ref anchors linkifyPages inserted intact', () => {
    const html = renderMarkdown(linkifyPages('See p. 3 for the date.', ['claim.pdf'], ['claim.pdf']));
    expect(html).toContain('class="page-ref"');
    expect(html).toContain('#pgopen=0.3');
  });

  it('handles a Hebrew answer, its numbers and its lists', () => {
    expect(renderMarkdown('1. סכום: 1,250\n2. תאריך: 02/01/2024')).toBe(
      '<ol><li>סכום: 1,250</li><li>תאריך: 02/01/2024</li></ol>',
    );
  });

  it('keeps soft line breaks, inline code and emphasis', () => {
    const html = renderMarkdown('Use `rag.claim`\nnot *the view*.');
    expect(html).toContain('<code>rag.claim</code>');
    expect(html).toContain('<br>');
    expect(html).toContain('<em>the view</em>');
  });

  it('leaves plain prose as one paragraph', () => {
    expect(renderMarkdown('No answer came back for that question.')).toBe(
      '<p>No answer came back for that question.</p>',
    );
  });
});
