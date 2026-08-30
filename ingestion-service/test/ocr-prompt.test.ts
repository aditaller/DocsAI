import assert from 'node:assert/strict';
import test from 'node:test';

import { ocrPromptFor } from '../src/ollama.js';

/**
 * The prompt is the whole difference between DeepSeek-OCR working and not. Given
 * the freeform OCR_PROMPT it echoes the instruction until num_ctx runs out —
 * measured at 192s and 7671 tokens for zero transcribed words, against 5.4s and
 * 98% word recall on the same Hebrew page with the prompt below. So this asserts
 * the routing, not the wording.
 */
test('deepseek-ocr tags get the fixed native prompt', () => {
  for (const model of ['deepseek-ocr:latest', 'deepseek-ocr:3b', 'DeepSeek-OCR:latest']) {
    assert.equal(ocrPromptFor(model), '<image>\nFree OCR.', model);
  }
});

test('every other vision model keeps the Language:-line prompt', () => {
  for (const model of ['qwen2.5vl:7b', 'qwen3-vl:4b', 'qwen3.6:35b-a3b']) {
    assert.match(ocrPromptFor(model), /^Transcribe every piece of text/, model);
    assert.match(ocrPromptFor(model), /Language:/, model);
  }
});

/**
 * `deepseek-ocr` is the prefix that routes, so a model merely containing it must
 * not be caught — otherwise a future `qwen-deepseek-ocr-distill` would silently
 * be handed a prompt it was never trained on.
 */
test('the match is anchored to the start of the model name', () => {
  assert.notEqual(ocrPromptFor('qwen-deepseek-ocr:7b'), '<image>\nFree OCR.');
});
