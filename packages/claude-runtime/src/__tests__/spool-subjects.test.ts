import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import { writeToSpool } from '../spool/spool-writer.js';
import { readSpoolFile, verifySpoolManifest } from '../spool/spool-reader.js';
import { buildCandidate } from '../capture/candidate-builder.js';
import type { GitContext, RawCaptureEvent } from '../types.js';

/**
 * `metadata.subjects` (subject-keyed supersession) must survive the spool
 * boundary byte-for-byte: writer -> JSONL line -> reader -> MemoryCandidate, and
 * the manifest hash covers the line that carries it.
 */
const event: RawCaptureEvent = {
  content: 'We host everything on the Contabo VPS now.',
  title: 'Hosting decision',
  source: 'mcp',
  category: 'decision',
  sessionId: 'sess-subjects',
};
const git: GitContext = {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'main',
  userName: 'tester',
  tenantId: 'org-repo',
};

describe('spool round-trip — metadata.subjects', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spool-subjects-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function spoolWith(subjects: string[] | undefined): Promise<string> {
    const built = buildCandidate(event, git);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    const c = built.value.candidate;
    const candidate = MemoryCandidate.parse({
      ...c,
      metadata: { ...c.metadata, ...(subjects !== undefined ? { subjects } : {}) },
    });
    const w = await writeToSpool(candidate, dir);
    expect(w.ok).toBe(true);
    if (!w.ok) throw new Error('unreachable');
    return w.value;
  }

  it('preserves subjects, in order, through write and read', async () => {
    const file = await spoolWith(['hosting.vps', 'deploy-pipeline']);
    expect(await readFile(file, 'utf8')).toContain('"subjects":["hosting.vps","deploy-pipeline"]');
    const read = await readSpoolFile(file);
    expect(read.ok && read.value[0]!.metadata.subjects).toEqual(['hosting.vps', 'deploy-pipeline']);
  });

  it('omits the key entirely when no subjects were declared (legacy shape)', async () => {
    const file = await spoolWith(undefined);
    expect(await readFile(file, 'utf8')).not.toContain('"subjects"');
    const read = await readSpoolFile(file);
    expect(read.ok && read.value[0]!.metadata.subjects).toBeUndefined();
  });

  it('manifest verification covers the subjects line (edit => tampered)', async () => {
    const file = await spoolWith(['hosting.vps']);
    const body = await readFile(file, 'utf8');
    await writeFile(
      `${file}.manifest.json`,
      JSON.stringify({ spoolFileSha256: createHash('sha256').update(body).digest('hex') }),
    );
    const ok = await verifySpoolManifest(file);
    expect(ok.ok && ok.value.status).toBe('verified');

    await writeFile(file, body.replace('hosting.vps', 'hosting.gcp'));
    const bad = await verifySpoolManifest(file);
    expect(bad.ok && bad.value.status).toBe('tampered');
  });

  it('a spooled line with an invalid or oversized subjects array is rejected by the reader', async () => {
    const file = await spoolWith(['hosting.vps']);
    const line = JSON.parse((await readFile(file, 'utf8')).trim()) as {
      metadata: { subjects: string[] };
    };
    line.metadata.subjects = Array.from({ length: 9 }, (_, i) => `s-${i}`);
    await writeFile(file, JSON.stringify(line) + '\n');
    const tooMany = await readSpoolFile(file);
    expect(tooMany.ok && tooMany.value.length).toBeFalsy();

    line.metadata.subjects = ['Not A Slug'];
    await writeFile(file, JSON.stringify(line) + '\n');
    const badSlug = await readSpoolFile(file);
    expect(badSlug.ok && badSlug.value.length).toBeFalsy();
  });
});
