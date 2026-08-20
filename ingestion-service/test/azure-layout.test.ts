import assert from 'node:assert/strict';
import test from 'node:test';

import { describeAnswers, splitLabel, toAnswers, toTextPages } from '../src/azure-layout.js';

/**
 * Shaped like the Layout container's `analyzeResult` for the metabolic-diseases
 * questionnaire this engine was added for: a right-to-left grid whose two
 * leftmost columns are כן and לא, and whose questions sit in the rightmost cell.
 *
 * Column 0 is כן and column 1 is לא, deliberately in that order, because the
 * printed form puts כן on the left. A reader that assumed "first column is the
 * affirmative one" would pass this and still invert a form that swapped them,
 * which is why toAnswers reads the header instead.
 */
function cell(rowIndex: number, columnIndex: number, content: string, pageNumber = 1) {
  return { rowIndex, columnIndex, content, boundingRegions: [{ pageNumber }] };
}

const GRID = {
  tables: [
    {
      rowCount: 6,
      columnCount: 3,
      boundingRegions: [{ pageNumber: 1 }],
      cells: [
        cell(0, 0, 'כן'),
        cell(0, 1, 'לא'),
        cell(0, 2, 'שאלון מומים/מחלות ו/או הפרעות מטבוליות'),
        // Answered yes.
        cell(1, 0, ':selected:'),
        cell(1, 1, ':unselected:'),
        cell(1, 2, '1. סוכרת'),
        // Answered no.
        cell(2, 0, ':unselected:'),
        cell(2, 1, ':selected:'),
        cell(2, 2, '1.4 קיימת פגיעה בעיניים או בראייה (רטינופתיה)'),
        // Not answered at all: neither cell marked.
        cell(3, 0, ':unselected:'),
        cell(3, 1, ':unselected:'),
        cell(3, 2, '2.3 האם נוטל טיפול תרופתי'),
        // Lettered sub-clause, answered yes.
        cell(4, 0, ':selected:'),
        cell(4, 1, ':unselected:'),
        cell(4, 2, '1.א סוכרת נעורים - סוג 1'),
      ],
    },
  ],
};

test('toAnswers reads the marked column for each answered row', () => {
  const answers = toAnswers(GRID);
  assert.deepEqual(
    answers.map((answer) => [answer.label, answer.value]),
    [
      ['1', 'כן'],
      ['1.4', 'לא'],
      ['1.א', 'כן'],
    ],
  );
});

test('toAnswers skips a row with no mark rather than recording it as negative', () => {
  // An unanswered question is not a declared "no". Recording one would invent a
  // statement the candidate never made, which on an underwriting form is the
  // most expensive kind of wrong.
  const answers = toAnswers(GRID);
  assert.equal(
    answers.some((answer) => answer.label === '2.3'),
    false,
  );
});

test('toAnswers reads the header rather than assuming which column is affirmative', () => {
  // The same grid with the columns swapped must produce the same answers.
  const swapped = {
    tables: [
      {
        cells: GRID.tables[0]!.cells.map((source) =>
          source.columnIndex === 0
            ? { ...source, columnIndex: 1 }
            : source.columnIndex === 1
              ? { ...source, columnIndex: 0 }
              : source,
        ),
      },
    ],
  };
  assert.deepEqual(
    toAnswers(swapped).map((answer) => [answer.label, answer.value]),
    toAnswers(GRID).map((answer) => [answer.label, answer.value]),
  );
});

test('toAnswers ignores a table that is not an answer grid', () => {
  const details = {
    tables: [{ cells: [cell(0, 0, 'שם משפחה'), cell(0, 1, 'שם פרטי'), cell(1, 0, 'מאיר'), cell(1, 1, 'שירלי')] }],
  };
  assert.deepEqual(toAnswers(details), []);
});

test('splitLabel separates numeric and lettered question labels', () => {
  assert.deepEqual(splitLabel('1.5.1 האם ערכי הסוכר לאחר הלידה חזרו לנורמה'), {
    label: '1.5.1',
    text: 'האם ערכי הסוכר לאחר הלידה חזרו לנורמה',
  });
  assert.deepEqual(splitLabel('1. סוכרת'), { label: '1', text: 'סוכרת' });
  assert.deepEqual(splitLabel('1.א סוכרת נעורים - סוג 1'), { label: '1.א', text: 'סוכרת נעורים - סוג 1' });
  // No printed number: the whole cell is the question.
  assert.deepEqual(splitLabel('הזעת יתר'), { label: '', text: 'הזעת יתר' });
});

test('toTextPages averages word confidence and rebuilds text from lines', () => {
  const pages = toTextPages({
    pages: [
      {
        pageNumber: 1,
        lines: [{ content: 'שאלון יב' }, { content: '' }, { content: 'סוכרת' }],
        words: [{ confidence: 0.9 }, { confidence: 0.7 }],
      },
    ],
  });
  assert.equal(pages[0]?.text, 'שאלון יב\nסוכרת');
  assert.equal(pages[0]?.confidence, 0.8);
});

test('toTextPages reports null confidence when the engine scored no words', () => {
  const pages = toTextPages({ pages: [{ pageNumber: 1, lines: [{ content: 'x' }] }] });
  assert.equal(pages[0]?.confidence, null);
});

test('describeAnswers renders a retrievable block naming the positive questions', () => {
  const block = describeAnswers(1, toAnswers(GRID));
  // The whole point: asking "which questions were answered yes" has to match
  // text that actually exists in the chunk, not a structured row the vector
  // search never sees.
  assert.match(block, /שאלות שנענו בחיוב: 1, 1\.א/u);
  assert.match(block, /1\.4 קיימת פגיעה בעיניים או בראייה \(רטינופתיה\) — לא/u);
});

test('describeAnswers says so explicitly when nothing was answered yes', () => {
  const block = describeAnswers(1, [
    { page: 1, label: '6', text: 'גאוט', kind: 'boolean', value: 'לא' },
  ]);
  assert.match(block, /לא נענתה אף שאלה בחיוב/u);
});

test('describeAnswers returns nothing for a page with no answers', () => {
  assert.equal(describeAnswers(2, toAnswers(GRID)), '');
});
