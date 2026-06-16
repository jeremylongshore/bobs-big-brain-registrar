import { describe, it, expect } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  parseQueryAccessLine,
  summarizeCitedQueries,
  rollingWindow,
  formatReport,
  QUERY_ACCESS_EVENT,
  type ReportWindow,
} from '../reports/cited-queries.js';
import {
  parseArgs,
  runReport,
  readJournalLines,
  formatSince,
  DEFAULT_UNIT,
  type SpawnFn,
} from '../reports/weekly-cited-queries-cli.js';

/** Build a query-access access-log line like routes/search.ts emits. */
function accessLine(o: {
  actor: string;
  time: number;
  citations?: string[];
  event?: string;
}): string {
  return JSON.stringify({
    level: 30,
    event: o.event ?? QUERY_ACCESS_EVENT,
    actor: o.actor,
    query: 'q',
    scope: 'curated',
    resultCount: o.citations?.length ?? 0,
    citations: o.citations ?? [],
    time: o.time,
    msg: 'teamkb query',
  });
}

const WIDE: ReportWindow = { sinceMs: 0, untilMs: 1e15 };

describe('parseQueryAccessLine', () => {
  it('parses a well-formed query-access line', () => {
    const line = accessLine({ actor: 'ope', time: 1781492917643, citations: ['qmd://a.md'] });
    expect(parseQueryAccessLine(line)).toEqual({
      actor: 'ope',
      citations: ['qmd://a.md'],
      time: 1781492917643,
    });
  });

  it('returns undefined for an empty / whitespace line', () => {
    expect(parseQueryAccessLine('')).toBeUndefined();
    expect(parseQueryAccessLine('   ')).toBeUndefined();
  });

  it('returns undefined for non-JSON', () => {
    expect(parseQueryAccessLine('Server listening on 3847')).toBeUndefined();
  });

  it('returns undefined for JSON that is not an object', () => {
    expect(parseQueryAccessLine('42')).toBeUndefined();
    expect(parseQueryAccessLine('null')).toBeUndefined();
    expect(parseQueryAccessLine('"a string"')).toBeUndefined();
  });

  it('returns undefined for other pino events', () => {
    expect(
      parseQueryAccessLine(accessLine({ actor: 'ope', time: 1, event: 'request' })),
    ).toBeUndefined();
  });

  it('returns undefined when actor is missing or non-string', () => {
    expect(
      parseQueryAccessLine(JSON.stringify({ event: QUERY_ACCESS_EVENT, time: 1 })),
    ).toBeUndefined();
    expect(
      parseQueryAccessLine(JSON.stringify({ event: QUERY_ACCESS_EVENT, actor: 5, time: 1 })),
    ).toBeUndefined();
  });

  it('returns undefined when time is missing or non-number', () => {
    expect(
      parseQueryAccessLine(JSON.stringify({ event: QUERY_ACCESS_EVENT, actor: 'ope' })),
    ).toBeUndefined();
    expect(
      parseQueryAccessLine(JSON.stringify({ event: QUERY_ACCESS_EVENT, actor: 'ope', time: '1' })),
    ).toBeUndefined();
  });

  it('defaults citations to [] when absent and filters non-string entries', () => {
    expect(
      parseQueryAccessLine(JSON.stringify({ event: QUERY_ACCESS_EVENT, actor: 'ope', time: 1 })),
    ).toEqual({ actor: 'ope', citations: [], time: 1 });
    expect(
      parseQueryAccessLine(
        JSON.stringify({
          event: QUERY_ACCESS_EVENT,
          actor: 'ope',
          time: 1,
          citations: ['ok', 7, null],
        }),
      ),
    ).toEqual({ actor: 'ope', citations: ['ok'], time: 1 });
  });
});

describe('summarizeCitedQueries', () => {
  it('counts total, cited, and citations-returned per actor', () => {
    const lines = [
      accessLine({ actor: 'ope', time: 10, citations: ['qmd://a.md', 'qmd://b.md'] }),
      accessLine({ actor: 'ope', time: 11, citations: [] }),
      accessLine({ actor: 'jeremy', time: 12, citations: ['qmd://c.md'] }),
    ];
    const report = summarizeCitedQueries(lines, WIDE);

    expect(report.totalQueries).toBe(3);
    expect(report.totalCitedQueries).toBe(2);
    // ope & jeremy tie at citedQueries=1 → alphabetical tiebreak (jeremy first).
    expect(report.perActor).toEqual([
      { actor: 'jeremy', totalQueries: 1, citedQueries: 1, citationsReturned: 1 },
      { actor: 'ope', totalQueries: 2, citedQueries: 1, citationsReturned: 2 },
    ]);
  });

  it('ignores lines that are not query-access events', () => {
    const lines = ['boot banner', accessLine({ actor: 'ope', time: 5, citations: ['qmd://a.md'] })];
    expect(summarizeCitedQueries(lines, WIDE).totalQueries).toBe(1);
  });

  it('includes events exactly on both window boundaries and excludes those outside', () => {
    const window: ReportWindow = { sinceMs: 100, untilMs: 200 };
    const lines = [
      accessLine({ actor: 'a', time: 99, citations: ['x'] }), // just before — excluded
      accessLine({ actor: 'a', time: 100, citations: ['x'] }), // on since — included
      accessLine({ actor: 'a', time: 200, citations: ['x'] }), // on until — included
      accessLine({ actor: 'a', time: 201, citations: ['x'] }), // just after — excluded
    ];
    expect(summarizeCitedQueries(lines, window).totalQueries).toBe(2);
  });

  it('sorts actors by citedQueries desc, then actor name asc', () => {
    const lines = [
      accessLine({ actor: 'zoe', time: 1, citations: ['x'] }),
      accessLine({ actor: 'zoe', time: 2, citations: ['x'] }),
      accessLine({ actor: 'amy', time: 3, citations: ['x'] }),
      accessLine({ actor: 'bob', time: 4, citations: ['x'] }), // amy & bob tie at 1 → amy first
    ];
    expect(summarizeCitedQueries(lines, WIDE).perActor.map((a) => a.actor)).toEqual([
      'zoe',
      'amy',
      'bob',
    ]);
  });

  it('returns an empty report for no in-window events', () => {
    const report = summarizeCitedQueries([], WIDE);
    expect(report).toEqual({
      sinceMs: WIDE.sinceMs,
      untilMs: WIDE.untilMs,
      perActor: [],
      totalQueries: 0,
      totalCitedQueries: 0,
    });
  });
});

describe('rollingWindow', () => {
  it('spans exactly `days` ending at now (default 7)', () => {
    const now = 1_000_000_000_000;
    expect(rollingWindow(now)).toEqual({ sinceMs: now - 7 * 86_400_000, untilMs: now });
    expect(rollingWindow(now, 1)).toEqual({ sinceMs: now - 86_400_000, untilMs: now });
  });
});

describe('formatReport', () => {
  it('shows the no-data sentinel when no actors', () => {
    const text = formatReport(summarizeCitedQueries([], WIDE));
    expect(text).toContain('(no queries in window)');
    expect(text).toContain('Total: 0 cited / 0 queries');
  });

  it('renders one row per actor with cited/total and citation totals', () => {
    const text = formatReport(
      summarizeCitedQueries([accessLine({ actor: 'ope', time: 1, citations: ['x', 'y'] })], WIDE),
    );
    expect(text).toContain('ope');
    expect(text).toContain('1 / 1');
    expect(text).toContain('Total: 1 cited / 1 queries');
  });
});

describe('parseArgs', () => {
  it('uses sensible defaults', () => {
    expect(parseArgs([])).toEqual({ days: 7, json: false, unit: DEFAULT_UNIT, stdin: false });
  });

  it('accepts --json, --stdin, --days N, --unit NAME', () => {
    expect(parseArgs(['--json', '--stdin', '--days', '30', '--unit', 'x.service'])).toEqual({
      days: 30,
      json: true,
      unit: 'x.service',
      stdin: true,
    });
  });

  it('rejects a non-positive or non-integer --days', () => {
    expect(() => parseArgs(['--days', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--days', '-3'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--days', 'abc'])).toThrow(/positive integer/);
  });

  it('rejects a missing --unit value', () => {
    expect(() => parseArgs(['--unit'])).toThrow(/requires a unit name/);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

describe('formatSince', () => {
  it('formats a local instant as YYYY-MM-DD HH:MM:SS (TZ-stable via local Date parts)', () => {
    const local = new Date(2026, 5, 14, 9, 5, 3); // 2026-06-14 09:05:03 local
    expect(formatSince(local.getTime())).toBe('2026-06-14 09:05:03');
  });
});

describe('runReport', () => {
  const lines = [accessLine({ actor: 'ope', time: 50, citations: ['x'] })];

  it('emits a human table by default', () => {
    const out = runReport(lines, 100, { days: 7, json: false, unit: DEFAULT_UNIT, stdin: false });
    expect(out).toContain('Weekly cited-query count per teammate');
    expect(out).toContain('ope');
  });

  it('emits parseable JSON with --json', () => {
    const out = runReport(lines, 100, { days: 7, json: true, unit: DEFAULT_UNIT, stdin: false });
    const parsed = JSON.parse(out);
    expect(parsed.totalCitedQueries).toBe(1);
    expect(parsed.perActor[0].actor).toBe('ope');
  });
});

describe('readJournalLines', () => {
  function fakeSpawn(ret: Partial<SpawnSyncReturns<string>>): SpawnFn {
    return () =>
      ({
        pid: 1,
        output: [],
        stdout: '',
        stderr: '',
        status: 0,
        signal: null,
        ...ret,
      }) as SpawnSyncReturns<string>;
  }

  it('passes the unit and a --since bound to journalctl and splits stdout into lines', () => {
    let capturedArgs: readonly string[] = [];
    const spawn: SpawnFn = (_cmd, args) => {
      capturedArgs = args;
      return {
        pid: 1,
        output: [],
        stdout: 'a\nb',
        stderr: '',
        status: 0,
        signal: null,
      } as SpawnSyncReturns<string>;
    };
    const lines = readJournalLines('u.service', 0, spawn);
    expect(lines).toEqual(['a', 'b']);
    expect(capturedArgs).toContain('u.service');
    expect(capturedArgs).toContain('--since');
  });

  it('throws when spawn reports an error', () => {
    const spawn = fakeSpawn({ error: new Error('ENOENT') });
    expect(() => readJournalLines('u', 0, spawn)).toThrow(/failed to read journal: ENOENT/);
  });

  it('throws on a non-zero exit status', () => {
    const spawn = fakeSpawn({ status: 1, stderr: 'no such unit' });
    expect(() => readJournalLines('u', 0, spawn)).toThrow(/journalctl exited 1: no such unit/);
  });
});
