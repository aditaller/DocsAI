import assert from 'node:assert/strict';
import test from 'node:test';

import { systemPromptFor } from '../src/ollama.js';

/**
 * The grounding rules are English, and a model with English instructions around
 * Hebrew excerpts answers in English. The language instruction is what stops
 * that, so this asserts it is attached exactly when the question is Hebrew.
 */
test('a Hebrew question asks for a Hebrew answer', () => {
  const prompt = systemPromptFor('מה סכום הנזק בתביעה?');
  assert.match(prompt, /Answer entirely in Hebrew/);
  // The grounding rules must survive alongside it, not be replaced by it.
  assert.match(prompt, /Answer only from the document excerpts/);
});

test('an English question is left alone', () => {
  const prompt = systemPromptFor('What is the damage amount on this claim?');
  assert.doesNotMatch(prompt, /Answer entirely in Hebrew/);
  assert.match(prompt, /Answer only from the document excerpts/);
});

/**
 * A Hebrew document name or a stray Hebrew word in an otherwise English question
 * is still a Hebrew question as far as the reader is concerned — the trigger is
 * deliberately any Hebrew character, not a majority.
 */
test('any Hebrew character in the question is enough', () => {
  assert.match(systemPromptFor('Summarise חרטה_20240707.jpg'), /Answer entirely in Hebrew/);
});

test('the question itself stays at the front of the prompt', () => {
  assert.ok(systemPromptFor('מה התאריך?').startsWith('מה התאריך?'));
});
