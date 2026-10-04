import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CurationBatchResult } from '@qmd-team-intent-kb/curator';

// ---------------------------------------------------------------------------
// Feedback module tests
//
// writeFeedback and readRecentFeedback use resolveTeamKbPath internally, which
// reads TEAMKB_BASE_PATH from the environment. We override that env var to
// point at a temp directory so tests are fully isolated and self-cleaning.
// ---------------------------------------------------------------------------

const NOW = '2026-01-15T10:00:00.000Z';

function makeBatchResult(overrides?: Partial<CurationBatchResult>): CurationBatchResult {
  return {
    processed: 0,
    promoted: 0,
    rejected: 0,
    flagged: 0,
    duplicates: 0,
    held: 0,
    holdCapBlocked: 0,
    results: [],
    ...overrides,
  };
}

describe('writeFeedback', () => {
  let baseDir: string;
  let feedbackDir: string;
  let originalBase: string | undefined;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'feedback-base-'));
    feedbackDir = join(baseDir, 'feedback');
    originalBase = process.env['TEAMKB_BASE_PATH'];
    process.env['TEAMKB_BASE_PATH'] = baseDir;
  });

  afterEach(() => {
    if (originalBase === undefined) {
      delete process.env['TEAMKB_BASE_PATH'];
    } else {
      process.env['TEAMKB_BASE_PATH'] = originalBase;
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('creates a JSONL file in the feedback directory for rejected candidates', async () => {
    const { writeFeedback } = await import('../feedback.js');

    const batchResult = makeBatchResult({
      processed: 1,
      rejected: 1,
      results: [
        {
          candidateId: randomUUID(),
          outcome: 'rejected',
          reason: 'Contains sensitive data',
        },
      ],
    });

    writeFeedback(batchResult, () => NOW);

    const files = readdirSync(feedbackDir).filter((f) => f.startsWith('feedback-'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^feedback-.*\.jsonl$/);
  });

  it('writes one JSONL line per rejected or flagged candidate', async () => {
    const { writeFeedback } = await import('../feedback.js');
    const { readFileSync } = await import('node:fs');

    const batchResult = makeBatchResult({
      processed: 3,
      rejected: 2,
      flagged: 1,
      results: [
        { candidateId: randomUUID(), outcome: 'rejected', reason: 'Secret detected' },
        { candidateId: randomUUID(), outcome: 'flagged', reason: 'Low relevance' },
        { candidateId: randomUUID(), outcome: 'rejected', reason: 'Content too short' },
      ],
    });

    writeFeedback(batchResult, () => NOW);

    const files = readdirSync(feedbackDir).filter((f) => f.startsWith('feedback-'));
    expect(files).toHaveLength(1);

    const content = readFileSync(join(feedbackDir, files[0]!), 'utf8');
    const lines = content
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const entry = JSON.parse(line) as {
        candidateId: string;
        outcome: string;
        reason: string;
        timestamp: string;
      };
      expect(entry.timestamp).toBe(NOW);
      expect(['rejected', 'flagged']).toContain(entry.outcome);
    }
  });

  it('does not create a file when all candidates are promoted (no rejections)', async () => {
    const { writeFeedback } = await import('../feedback.js');

    const batchResult = makeBatchResult({
      processed: 2,
      promoted: 2,
      results: [
        { candidateId: randomUUID(), outcome: 'promoted', reason: 'Passed all rules' },
        { candidateId: randomUUID(), outcome: 'promoted', reason: 'Passed all rules' },
      ],
    });

    writeFeedback(batchResult, () => NOW);

    // Feedback dir may not even exist — no file should be created
    let files: string[] = [];
    try {
      files = readdirSync(feedbackDir).filter((f) => f.startsWith('feedback-'));
    } catch {
      // Directory does not exist — that is also correct
    }
    expect(files).toHaveLength(0);
  });

  it('uses the timestamp from nowFn for each entry in the file', async () => {
    const { writeFeedback } = await import('../feedback.js');
    const { readFileSync } = await import('node:fs');

    const customNow = '2026-03-19T12:00:00.000Z';
    const batchResult = makeBatchResult({
      processed: 1,
      rejected: 1,
      results: [{ candidateId: randomUUID(), outcome: 'rejected', reason: 'Test' }],
    });

    writeFeedback(batchResult, () => customNow);

    const files = readdirSync(feedbackDir).filter((f) => f.startsWith('feedback-'));
    const content = readFileSync(join(feedbackDir, files[0]!), 'utf8');
    const entry = JSON.parse(content.trim().split('\n')[0]!) as { timestamp: string };
    expect(entry.timestamp).toBe(customNow);
  });
});

describe('readRecentFeedback', () => {
  let baseDir: string;
  let feedbackDir: string;
  let originalBase: string | undefined;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'feedback-read-'));
    feedbackDir = join(baseDir, 'feedback');
    mkdirSync(feedbackDir, { recursive: true });
    originalBase = process.env['TEAMKB_BASE_PATH'];
    process.env['TEAMKB_BASE_PATH'] = baseDir;
  });

  afterEach(() => {
    if (originalBase === undefined) {
      delete process.env['TEAMKB_BASE_PATH'];
    } else {
      process.env['TEAMKB_BASE_PATH'] = originalBase;
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('returns empty array when no feedback files exist', async () => {
    const { readRecentFeedback } = await import('../feedback.js');
    // feedbackDir exists but is empty
    const entries = readRecentFeedback();
    expect(entries).toHaveLength(0);
  });

  it('returns empty array when feedback directory does not exist', async () => {
    const { readRecentFeedback } = await import('../feedback.js');
    // Point base at a nonexistent path
    process.env['TEAMKB_BASE_PATH'] = join(baseDir, 'nonexistent');
    const entries = readRecentFeedback();
    expect(entries).toHaveLength(0);
  });

  it('returns entries from feedback files, most recent first', async () => {
    const { readRecentFeedback } = await import('../feedback.js');

    // Write two files with timestamps that sort differently
    const older = '2026-01-01T10:00:00.000Z';
    const newer = '2026-03-01T10:00:00.000Z';

    const olderFilename = `feedback-2026-01-01T10-00-00-000Z.jsonl`;
    const newerFilename = `feedback-2026-03-01T10-00-00-000Z.jsonl`;

    writeFileSync(
      join(feedbackDir, olderFilename),
      JSON.stringify({
        candidateId: 'c-old',
        outcome: 'rejected',
        reason: 'old',
        timestamp: older,
      }) + '\n',
      'utf8',
    );
    writeFileSync(
      join(feedbackDir, newerFilename),
      JSON.stringify({
        candidateId: 'c-new',
        outcome: 'flagged',
        reason: 'new',
        timestamp: newer,
      }) + '\n',
      'utf8',
    );

    const entries = readRecentFeedback(10);

    // Files are sorted in reverse — newer file read first
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // First entry should come from the newer file (sorted alphabetically, reversed)
    const candidateIds = entries.map((e) => e.candidateId);
    expect(candidateIds).toContain('c-new');
    expect(candidateIds).toContain('c-old');
    // Newer should appear before older because files are sorted DESC
    expect(candidateIds.indexOf('c-new')).toBeLessThan(candidateIds.indexOf('c-old'));
  });

  it('respects the limit parameter and returns at most limit entries', async () => {
    const { readRecentFeedback } = await import('../feedback.js');

    // Write a file with 5 entries
    const lines =
      Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({
          candidateId: `cand-${i}`,
          outcome: 'rejected',
          reason: `Reason ${i}`,
          timestamp: NOW,
        }),
      ).join('\n') + '\n';

    writeFileSync(join(feedbackDir, 'feedback-2026-01-15T10-00-00-000Z.jsonl'), lines, 'utf8');

    const entries = readRecentFeedback(3);
    expect(entries).toHaveLength(3);
  });
});

describe('writeFeedback — file pruning', () => {
  let baseDir: string;
  let feedbackDir: string;
  let originalBase: string | undefined;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'feedback-prune-'));
    feedbackDir = join(baseDir, 'feedback');
    mkdirSync(feedbackDir, { recursive: true, mode: 0o700 });
    originalBase = process.env['TEAMKB_BASE_PATH'];
    process.env['TEAMKB_BASE_PATH'] = baseDir;
  });

  afterEach(() => {
    if (originalBase === undefined) {
      delete process.env['TEAMKB_BASE_PATH'];
    } else {
      process.env['TEAMKB_BASE_PATH'] = originalBase;
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('prunes oldest files when total exceeds MAX_FEEDBACK_FILES (50)', async () => {
    const { writeFeedback } = await import('../feedback.js');

    // Pre-populate with 50 existing feedback files (at the limit)
    for (let i = 0; i < 50; i++) {
      const ts = `2025-${String(i + 1).padStart(2, '0')}-01T00-00-00-000Z`;
      const filename = `feedback-${ts}.jsonl`;
      writeFileSync(
        join(feedbackDir, filename),
        JSON.stringify({
          candidateId: `cand-existing-${i}`,
          outcome: 'rejected',
          reason: 'old',
          timestamp: NOW,
        }) + '\n',
        'utf8',
      );
    }

    // Verify we have exactly 50 files
    const before = readdirSync(feedbackDir).filter((f) => f.startsWith('feedback-'));
    expect(before).toHaveLength(50);

    // Write one more — should trigger pruning of the oldest
    const batchResult = makeBatchResult({
      processed: 1,
      rejected: 1,
      results: [{ candidateId: randomUUID(), outcome: 'rejected', reason: 'New rejection' }],
    });

    // Use a timestamp that will sort AFTER the existing ones
    writeFeedback(batchResult, () => '2026-01-15T10:00:00.000Z');

    const after = readdirSync(feedbackDir).filter((f) => f.startsWith('feedback-'));
    // Should still be at most 50 files after pruning
    expect(after.length).toBeLessThanOrEqual(50);
  });
});
