import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isMemoryCaptureEnabled } from '../cycle.js';

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'daemon-settings-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});
describe('owned enterprise memory capture settings', () => {
  it.each([
    ['{"memoryCapture":{"enabled":false}}', false],
    ['{"memoryCapture":{"enabled":true}}', true],
    ['malformed', true],
    [undefined, true],
  ])('preserves production semantics for owned config %s', (content, expected) => {
    const path = join(scratch, 'settings.json');
    if (content !== undefined) writeFileSync(path, content);
    expect(isMemoryCaptureEnabled(path)).toBe(expected);
  });
});
