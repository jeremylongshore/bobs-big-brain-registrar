import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Only --self-test creates files, exclusively in its own disposable synthetic directory. */
export function selfTestFrozenReview(runner: string): number {
  const root = mkdtempSync(join(tmpdir(), 'review-eval-self-test-'));
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const write = (path: string, data: unknown) => writeFileSync(path, JSON.stringify(data));
  const base = join(root, 'base');
  mkdirSync(join(base, 'cases'), { recursive: true });
  try {
    const cases = [
      { id: 'new', expected: 'promote', stratum: 'ordinary' },
      { id: 'uncertain', expected: 'hold', stratum: 'ordinary' },
      { id: 'unsafe', expected: 'reject', stratum: 'ordinary' },
      { id: 'paraphrase', expected: 'reject', stratum: 'paraphrase-duplicate' },
    ];
    for (const item of cases)
      write(join(base, 'cases', `${item.id}.json`), {
        ...item,
        schemaVersion: 1,
        input: { candidate: 'Synthetic self-test input', context: [] },
        disposition: { kind: 'synthetic' },
      });
    const manifest = {
      schemaVersion: 1,
      datasetId: 'self-test',
      kind: 'synthetic',
      revision: 1,
      previousManifestSha256: null as string | null,
      recallFloors: { promote: 1, hold: 1, reject: 1 },
      cases: cases.map((item) => ({
        id: item.id,
        sha256: hash(join(base, 'cases', `${item.id}.json`)),
      })),
    };
    write(join(base, 'manifest.json'), manifest);
    const pin = hash(join(base, 'manifest.json'));
    const predictions = (name: string, rows: unknown[]) => {
      const path = join(root, `${name}.json`);
      write(path, { schemaVersion: 1, manifestSha256: pin, predictions: rows });
      return path;
    };
    const perfect = predictions(
      'perfect',
      cases.map((item) => ({ caseId: item.id, label: item.expected })),
    );
    const hold = predictions(
      'hold',
      cases.map((item) => ({ caseId: item.id, label: 'hold' })),
    );
    const missing = predictions('missing', []);
    const args = ['--eval-root', base, '--manifest-sha256', pin];
    const checks: {
      name: string;
      expectedExit: number;
      actualExit: number | null;
      passed: boolean;
    }[] = [];
    const check = (name: string, selected: string[], expectedExit: number) => {
      const result = spawnSync(
        process.execPath,
        [...(runner.endsWith('.ts') ? ['--import', 'tsx'] : []), runner, ...selected],
        {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env['PATH'] ?? '' },
        },
      );
      // Success must be a real JSON response, not a process exiting early without exercising the runner.
      let responseValid = false;
      try {
        if (expectedExit !== 2) {
          const body = JSON.parse(result.stdout);
          responseValid = body.integrity === 'verified' || typeof body.passed === 'boolean';
        } else
          responseValid = result.stderr.includes(
            'Invalid frozen review evaluation input or evidence',
          );
      } catch {
        /* Empty/invalid child output fails the control. */
      }
      checks.push({
        name,
        expectedExit,
        actualExit: result.status,
        passed: !result.error && result.status === expectedExit && responseValid,
      });
    };
    check('manifest integrity', ['--verify-manifest', ...args], 0);
    check('perfect predictions', ['--score', perfect, ...args], 0);
    check('constant HOLD misses promote and reject', ['--score', hold, ...args], 1);
    check('missing predictions are misses', ['--score', missing, ...args], 1);
    const unsupported = join(root, 'unsupported');
    cpSync(base, unsupported, { recursive: true });
    const unsupportedCasePath = join(unsupported, 'cases', 'uncertain.json');
    const unsupportedCase = JSON.parse(readFileSync(unsupportedCasePath, 'utf8'));
    unsupportedCase.expected = 'promote';
    write(unsupportedCasePath, unsupportedCase);
    const unsupportedManifest = structuredClone(manifest);
    unsupportedManifest.cases[1]!.sha256 = hash(unsupportedCasePath);
    write(join(unsupported, 'manifest.json'), unsupportedManifest);
    const unsupportedPin = hash(join(unsupported, 'manifest.json'));
    const unsupportedPredictions = join(root, 'unsupported-predictions.json');
    write(unsupportedPredictions, {
      schemaVersion: 1,
      manifestSha256: unsupportedPin,
      predictions: cases.map((item) => ({
        caseId: item.id,
        label: item.id === 'uncertain' ? 'promote' : item.expected,
      })),
    });
    check(
      'perfect observed classes cannot mask missing HOLD support',
      [
        '--score',
        unsupportedPredictions,
        '--eval-root',
        unsupported,
        '--manifest-sha256',
        unsupportedPin,
      ],
      1,
    );
    const changed = join(root, 'changed');
    cpSync(base, changed, { recursive: true });
    writeFileSync(join(changed, 'cases', 'new.json'), 'mutated synthetic evidence');
    check(
      'case mutation',
      ['--verify-manifest', '--eval-root', changed, '--manifest-sha256', pin],
      2,
    );
    check(
      'independent pin mismatch',
      ['--verify-manifest', '--eval-root', base, '--manifest-sha256', '0'.repeat(64)],
      2,
    );
    const prior = join(root, 'prior.json');
    cpSync(join(base, 'manifest.json'), prior);
    const added = join(root, 'added');
    cpSync(base, added, { recursive: true });
    write(join(added, 'cases', 'addition.json'), {
      schemaVersion: 1,
      id: 'addition',
      expected: 'reject',
      stratum: 'ordinary',
      input: { candidate: 'Synthetic addition', context: [] },
      disposition: { kind: 'synthetic' },
    });
    const next = {
      ...manifest,
      revision: 2,
      previousManifestSha256: pin,
      cases: [
        ...manifest.cases,
        { id: 'addition', sha256: hash(join(added, 'cases', 'addition.json')) },
      ],
    };
    write(join(added, 'manifest.json'), next);
    const appendArgs = [
      '--verify-manifest',
      '--eval-root',
      added,
      '--manifest-sha256',
      hash(join(added, 'manifest.json')),
      '--previous-manifest',
      prior,
      '--previous-sha256',
      pin,
    ];
    check('approved checkpoint preserved on addition', appendArgs, 0);
    const replaced = JSON.parse(readFileSync(join(added, 'cases', 'new.json'), 'utf8'));
    replaced.expected = 'reject';
    write(join(added, 'cases', 'new.json'), replaced);
    next.cases[0]!.sha256 = hash(join(added, 'cases', 'new.json'));
    write(join(added, 'manifest.json'), next);
    appendArgs[4] = hash(join(added, 'manifest.json'));
    check('re-pinning cannot erase an approved label', appendArgs, 2);
    const passed = checks.every((item) => item.passed);
    process.stdout.write(JSON.stringify({ kind: 'synthetic', passed, checks }) + '\n');
    return passed ? 0 : 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
