import { describe, expect, it } from 'vitest';

import { describeQmdFailure, STDERR_TAIL_CHARS, stderrTail } from '../executor/describe-failure.js';
import { parseTimeoutMs, resolveMaintenanceTimeoutMs } from '../config.js';

describe('stderrTail', () => {
  it('keeps the last 20 non-empty lines', () => {
    const s = Array.from({ length: 30 }, (_v, i) => `l${i}`).join('\n');
    const t = stderrTail(s).split('\n');
    expect(t).toHaveLength(20);
    expect(t[0]).toBe('l10');
    expect(t[19]).toBe('l29');
  });

  it('normalises carriage-return progress redraws into lines', () => {
    expect(stderrTail('Indexing 1/3\rIndexing 2/3\rIndexing 3/3\r\n\n')).toBe(
      'Indexing 1/3\nIndexing 2/3\nIndexing 3/3',
    );
  });

  it('bounds the character count', () => {
    const t = stderrTail('x'.repeat(STDERR_TAIL_CHARS * 3));
    expect(t.length).toBe(STDERR_TAIL_CHARS + 1);
    expect(t.startsWith('…')).toBe(true);
  });
});

describe('describeQmdFailure', () => {
  it('timeout of an interactive command does not suggest the maintenance knob', () => {
    const e = describeQmdFailure(['search', '--json', '--', 'q'], {
      stdout: '',
      stderr: '',
      exitCode: 124,
      failure: { kind: 'timeout', elapsedMs: 30_012, timeoutMs: 30_000, groupTerminated: true },
    });
    expect(e.code).toBe('timeout');
    expect(e.message).toContain('timed out after 30.0s (limit 30000 ms)');
    expect(e.message).not.toContain('TEAMKB_QMD_TIMEOUT_MS');
  });

  it('a timeout whose group could not be confirmed gone says so', () => {
    const e = describeQmdFailure(['update'], {
      stdout: '',
      stderr: '',
      exitCode: 124,
      failure: { kind: 'timeout', elapsedMs: 1_000, timeoutMs: 900, groupTerminated: false },
    });
    expect(e.message).toContain('could not be confirmed gone');
  });

  it('spawn failure and exit 127 map to not_available with the executor message', () => {
    const e = describeQmdFailure(['update'], {
      stdout: '',
      stderr: 'qmd binary not found (searched: PATH)',
      exitCode: 127,
    });
    expect(e).toMatchObject({ code: 'not_available', command: 'qmd update' });
    expect(e.message).toBe('qmd binary not found (searched: PATH)');
    const s = describeQmdFailure(['update'], {
      stdout: '',
      stderr: 'qmd binary "/x" failed to start (EMFILE): too many open files',
      exitCode: 127,
      failure: { kind: 'spawn', code: 'EMFILE', message: 'too many open files' },
    });
    expect(s.code).toBe('not_available');
  });

  it('a non-zero exit with empty stderr says so explicitly', () => {
    const e = describeQmdFailure(['collection', 'add', '/e/guides', '--name', 'kb-guides'], {
      stdout: '',
      stderr: '',
      exitCode: 2,
    });
    expect(e.code).toBe('command_failed');
    expect(e.message).toBe(
      'qmd collection add /e/guides --name kb-guides exited with code 2 (no stderr output)',
    );
  });
});

describe('parseTimeoutMs / resolveMaintenanceTimeoutMs', () => {
  it('accepts positive integers only', () => {
    expect(parseTimeoutMs(' 900000 ')).toBe(900_000);
    for (const bad of [undefined, '', '0', '-5', '1.5', '10m', '1e6', '99999999999999999999']) {
      expect(parseTimeoutMs(bad)).toBeNull();
    }
  });

  it('falls back to the 10-minute default when unset or invalid', () => {
    expect(resolveMaintenanceTimeoutMs({})).toBe(600_000);
    expect(resolveMaintenanceTimeoutMs({ TEAMKB_QMD_TIMEOUT_MS: 'nope' })).toBe(600_000);
    expect(resolveMaintenanceTimeoutMs({ TEAMKB_QMD_TIMEOUT_MS: '45000' })).toBe(45_000);
  });
});
