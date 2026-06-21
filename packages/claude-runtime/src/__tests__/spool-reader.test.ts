import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeToSpool } from '../spool/spool-writer.js';
import { listSpoolFiles, readSpoolFile, verifySpoolManifest } from '../spool/spool-reader.js';
import { buildCandidate } from '../capture/candidate-builder.js';
import type { RawCaptureEvent, GitContext } from '../types.js';

const makeEvent = (title = 'Test candidate'): RawCaptureEvent => ({
  content: 'Test memory candidate content',
  title,
  source: 'claude_session',
  category: 'convention',
  sessionId: 'sess-test',
});

const gitCtx: GitContext = {
  repoUrl: 'https://github.com/org/repo.git',
  branch: 'main',
  userName: 'tester',
  tenantId: 'org-repo',
};

describe('spool-reader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spool-read-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('readSpoolFile', () => {
    it('reads and parses candidates from spool file', async () => {
      const r = buildCandidate(makeEvent(), gitCtx);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const writeResult = await writeToSpool(r.value.candidate, tmpDir);
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) return;

      const readResult = await readSpoolFile(writeResult.value);
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).toHaveLength(1);
      expect(readResult.value[0]!.title).toBe('Test candidate');
    });

    it('returns error for non-existent file', async () => {
      const result = await readSpoolFile('/nonexistent/file.jsonl');
      expect(result.ok).toBe(false);
    });
  });

  describe('listSpoolFiles', () => {
    it('lists spool files in directory', async () => {
      const r = buildCandidate(makeEvent(), gitCtx);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      await writeToSpool(r.value.candidate, tmpDir);

      const result = await listSpoolFiles(tmpDir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.length).toBeGreaterThanOrEqual(1);
      expect(result.value[0]).toMatch(/spool-\d{4}-\d{2}-\d{2}\.jsonl$/);
    });

    it('returns empty array for empty directory', async () => {
      const result = await listSpoolFiles(tmpDir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it('returns error for non-existent directory', async () => {
      const result = await listSpoolFiles('/nonexistent/dir');
      expect(result.ok).toBe(false);
    });

    // ICO → INTKB handoff: when no explicit spoolDir is passed, the reader
    // derives its default from getSpoolPath() == <teamkb-base>/spool. ICO's
    // emitter writes to the SAME base via TEAMKB_HOME (its pre-existing
    // allowlist root). This test proves INTKB reads exactly where ICO writes
    // when only TEAMKB_HOME is configured — the default-path mismatch the Epic
    // 0 spool grounding flagged is closed.
    describe('default read path tracks the ICO write base (TEAMKB_HOME)', () => {
      const origBasePath = process.env['TEAMKB_BASE_PATH'];
      const origHome = process.env['TEAMKB_HOME'];

      afterEach(() => {
        if (origBasePath === undefined) delete process.env['TEAMKB_BASE_PATH'];
        else process.env['TEAMKB_BASE_PATH'] = origBasePath;
        if (origHome === undefined) delete process.env['TEAMKB_HOME'];
        else process.env['TEAMKB_HOME'] = origHome;
      });

      it('lists ICO-written spool files from $TEAMKB_HOME/spool with no explicit spoolDir', async () => {
        // Simulate an operator who only set ICO's TEAMKB_HOME root. ICO would
        // emit to `<tmpDir>/spool`; INTKB's reader must default to the same.
        delete process.env['TEAMKB_BASE_PATH'];
        process.env['TEAMKB_HOME'] = tmpDir;

        const r = buildCandidate(makeEvent('ICO handoff candidate'), gitCtx);
        expect(r.ok).toBe(true);
        if (!r.ok) return;

        // Write into <TEAMKB_HOME>/spool — the ICO write path.
        const icoSpoolDir = join(tmpDir, 'spool');
        const writeResult = await writeToSpool(r.value.candidate, icoSpoolDir);
        expect(writeResult.ok).toBe(true);

        // Read with NO explicit dir — must resolve to <TEAMKB_HOME>/spool.
        const result = await listSpoolFiles();
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        expect(result.value[0]).toContain(icoSpoolDir);
      });
    });
  });

  // -------------------------------------------------------------------------
  // verifySpoolManifest (bead dmj.4 — threat-model control C11)
  // -------------------------------------------------------------------------

  describe('verifySpoolManifest', () => {
    const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

    it("returns 'no_manifest' when no manifest sidecar exists", async () => {
      const spool = join(tmpDir, 'spool-1.jsonl');
      await writeFile(spool, '{"x":1}\n', 'utf8');
      const result = await verifySpoolManifest(spool);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('no_manifest');
    });

    it("returns 'verified' when the manifest SHA-256 matches file content", async () => {
      const spool = join(tmpDir, 'spool-2.jsonl');
      const body = '{"id":"abc","content":"hello"}\n';
      await writeFile(spool, body, 'utf8');
      await writeFile(
        `${spool}.manifest.json`,
        JSON.stringify({ spoolFileSha256: sha256(body) }),
        'utf8',
      );
      const result = await verifySpoolManifest(spool);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('verified');
        expect(result.value.expected).toBe(result.value.actual);
      }
    });

    it("returns 'tampered' when the file content no longer matches the manifest", async () => {
      const spool = join(tmpDir, 'spool-3.jsonl');
      await writeFile(spool, 'tampered content\n', 'utf8');
      await writeFile(
        `${spool}.manifest.json`,
        JSON.stringify({ spoolFileSha256: sha256('original content') }),
        'utf8',
      );
      const result = await verifySpoolManifest(spool);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('tampered');
        expect(result.value.expected).toBe(sha256('original content'));
        expect(result.value.actual).not.toBe(result.value.expected);
      }
    });

    it('errors when the manifest JSON is malformed', async () => {
      const spool = join(tmpDir, 'spool-4.jsonl');
      await writeFile(spool, 'body\n', 'utf8');
      await writeFile(`${spool}.manifest.json`, 'NOT JSON {{{', 'utf8');
      const result = await verifySpoolManifest(spool);
      expect(result.ok).toBe(false);
    });

    it('errors when the manifest is missing the spoolFileSha256 field', async () => {
      const spool = join(tmpDir, 'spool-5.jsonl');
      await writeFile(spool, 'body\n', 'utf8');
      await writeFile(`${spool}.manifest.json`, JSON.stringify({ other: 'field' }), 'utf8');
      const result = await verifySpoolManifest(spool);
      expect(result.ok).toBe(false);
    });

    it('errors when the manifest exists but the spool file is unreadable', async () => {
      const spool = join(tmpDir, 'spool-6.jsonl');
      // Manifest present, but no spool file written at that path.
      await writeFile(
        `${spool}.manifest.json`,
        JSON.stringify({ spoolFileSha256: sha256('x') }),
        'utf8',
      );
      const result = await verifySpoolManifest(spool);
      expect(result.ok).toBe(false);
    });
  });
});
