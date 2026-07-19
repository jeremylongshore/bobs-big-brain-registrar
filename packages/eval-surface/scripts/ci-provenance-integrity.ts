#!/usr/bin/env tsx
/**
 * CI provenance-integrity smoke — a REAL end-to-end run of
 * `evaluateProvenanceIntegrity` against a freshly-seeded, on-disk throwaway
 * brain that carries a BENIGN CHAIN_FORK.
 *
 * Why this exists (010-AT-RISK R5 / bead compile-then-govern-e06.2, umbrella #27):
 * the fixed evaluator must PASS on a forked-but-untampered chain (the exact
 * shape of the live brain's 155 CHAIN_FORKs, 0 tamper) while still DISCLOSING
 * the forks, and still FAIL CLOSED on genuine tampering. The eval-surface unit
 * tests assert this on in-memory repos; this script re-proves it on a REAL
 * on-disk DB seeded with real memories + a real audit chain, so CI catches any
 * regression the in-memory doubles could miss.
 *
 * It builds a throwaway brain in a temp dir (never touches ~/.teamkb), seeds a
 * memory + a 3-row audit chain, splices a CHAIN_FORK, runs the evaluator, and
 * asserts { passed:true, chain_forks>0, tamper_signatures:0 }. Then it seeds a
 * genuine tamper break and asserts { passed:false, tamper_signatures>0 }.
 *
 * Track F2 adds the external-anchor cross-check scenarios on a SECOND
 * throwaway brain: (a) an anchored, untouched chain reads `consistent` and
 * passes; (b) truncating the chain AFTER anchoring — which leaves the chain
 * internally clean, so intra-chain verification alone sees NOTHING — fails
 * closed with `anchor_history_truncated > 0`. The first brain runs with a
 * missing anchor log, proving the graceful bootstrap (`no_anchors_yet`).
 *
 * Exit 0 on success; non-zero (with a diagnostic) on any assertion failure.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeContentHash } from '@qmd-team-intent-kb/common';
import type { AuditEvent, CuratedMemory } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  CURRENT_AUDIT_HASH_VERSION,
  MemoryRepository,
  appendAnchor,
  computeEntryHash,
  createDatabase,
} from '@qmd-team-intent-kb/store';

import { evaluateProvenanceIntegrity } from '../src/index.js';

const TENANT = 'ci-provenance';

/**
 * Signal an assertion failure by THROWING (not `process.exit`), so the single
 * top-level `finally` runs its cleanup (close DB + remove temp dir) before the
 * process exits non-zero. The top-level catch sets exit code 1.
 */
function fail(msg: string): never {
  throw new Error(msg);
}

function makeMemory(content: string): CuratedMemory {
  const now = '2026-06-30T00:00:00.000Z';
  return {
    id: randomUUID(),
    candidateId: randomUUID(),
    source: 'claude_session',
    content,
    title: 'ci-seed',
    category: 'pattern',
    trustLevel: 'high',
    sensitivity: 'internal',
    author: { type: 'ai', id: 'ci', name: 'CI' },
    tenantId: TENANT,
    metadata: { filePaths: [], tags: [] },
    lifecycle: 'active',
    contentHash: computeContentHash(content),
    policyEvaluations: [],
    promotedAt: now,
    promotedBy: { type: 'human', id: 'ci', name: 'CI' },
    updatedAt: now,
    version: 1,
  };
}

function makeEvent(i: number): AuditEvent {
  return {
    id: `00000000-0000-4000-8000-0000000000${(i + 1).toString(16).padStart(2, '0')}`,
    action: 'promoted',
    memoryId: '11111111-1111-4111-8111-111111111111',
    tenantId: TENANT,
    actor: { type: 'human', id: 'ci' },
    reason: `r${i}`,
    details: { test: true },
    timestamp: `2026-05-29T08:0${i}:00.000Z`,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'gsb-ci-provenance-'));
const dbPath = join(dir, 'teamkb.db');
// A manifest path that does NOT exist → the evaluator's "no amnesty" branch.
const noManifest = join(dir, 'no-such-exceptions.manifest.json');
// An anchor-log path that does NOT exist → the F2 bootstrap ('no_anchors_yet')
// branch for the fork/tamper scenarios, and never a read of ~/.teamkb.
const noAnchors = join(dir, 'no-such-anchors.jsonl');
// A REAL anchor log for the F2 anchored-then-truncated scenario.
const anchorLog = join(dir, 'anchors.jsonl');
const dbPath2 = join(dir, 'teamkb-anchored.db');

// `db`/`db2` are declared OUTSIDE the try so the single top-level `finally` can
// safely close them on every path (success, assertion failure, unexpected
// throw) before the temp dir is removed.
let db: ReturnType<typeof createDatabase> | undefined;
let db2: ReturnType<typeof createDatabase> | undefined;

try {
  db = createDatabase({ path: dbPath });
  const memRepo = new MemoryRepository(db);
  const auditRepo = new AuditRepository(db);

  memRepo.insert(makeMemory('ci provenance seed memory'));

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const e = makeEvent(i);
    ids.push(e.id);
    auditRepo.insert(e);
  }

  // --- splice a BENIGN CHAIN_FORK: last row → back to the first, own hash intact.
  const first = ids[0]!;
  const last = ids[2]!;
  const rowA = db.prepare('SELECT entry_hash FROM audit_events WHERE id = ?').get(first) as {
    entry_hash: string;
  };
  const rowC = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(last) as {
    id: string;
    action: string;
    memory_id: string;
    tenant_id: string;
    actor_json: string;
    reason: string | null;
    details_json: string;
    timestamp: string;
  };
  const forkedEntry = computeEntryHash(
    {
      id: rowC.id,
      action: rowC.action,
      memory_id: rowC.memory_id,
      tenant_id: rowC.tenant_id,
      actor_json: rowC.actor_json,
      reason: rowC.reason,
      details_json: rowC.details_json,
      timestamp: rowC.timestamp,
      prev_entry_hash: rowA.entry_hash,
    },
    CURRENT_AUDIT_HASH_VERSION,
  );
  db.prepare('UPDATE audit_events SET prev_entry_hash = ?, entry_hash = ? WHERE id = ?').run(
    rowA.entry_hash,
    forkedEntry,
    last,
  );

  const forked = evaluateProvenanceIntegrity(memRepo, auditRepo, {
    tenantId: TENANT,
    exceptionManifestPath: noManifest,
    anchorLogPath: noAnchors,
  });
  process.stdout.write(`forked-brain verdict: ${JSON.stringify(forked.details)}\n`);
  if (!forked.passed) fail('forked-but-untampered brain must PASS, got passed=false');
  if (Number(forked.details.chain_forks) <= 0)
    fail(`expected chain_forks > 0, got ${forked.details.chain_forks}`);
  if (Number(forked.details.tamper_signatures) !== 0)
    fail(`expected tamper_signatures 0, got ${forked.details.tamper_signatures}`);
  // F2 bootstrap: a missing anchor log must report itself and NOT fail.
  if (forked.details.anchor_status !== 'no_anchors_yet')
    fail(`expected anchor_status 'no_anchors_yet', got ${forked.details.anchor_status}`);

  // --- now introduce a REAL tamper break and assert the eval fails closed.
  db.prepare(`UPDATE audit_events SET reason = 'TAMPERED' WHERE id = ?`).run(ids[1]);
  const tampered = evaluateProvenanceIntegrity(memRepo, auditRepo, {
    tenantId: TENANT,
    exceptionManifestPath: noManifest,
    anchorLogPath: noAnchors,
  });
  process.stdout.write(`tampered-brain verdict: ${JSON.stringify(tampered.details)}\n`);
  if (tampered.passed) fail('a tampered brain must FAIL, got passed=true');
  if (Number(tampered.details.tamper_signatures) <= 0)
    fail('expected tamper_signatures > 0 on a tampered brain');

  // --- F2: second brain — anchored, then truncated after anchoring. ---------
  db2 = createDatabase({ path: dbPath2 });
  const memRepo2 = new MemoryRepository(db2);
  const auditRepo2 = new AuditRepository(db2);
  memRepo2.insert(makeMemory('ci anchored brain seed memory'));
  const ids2: string[] = [];
  for (let i = 0; i < 3; i++) {
    const e = makeEvent(i);
    ids2.push(e.id);
    auditRepo2.insert(e);
  }
  appendAnchor(auditRepo2, anchorLog, { tenantId: TENANT });

  const anchored = evaluateProvenanceIntegrity(memRepo2, auditRepo2, {
    tenantId: TENANT,
    exceptionManifestPath: noManifest,
    anchorLogPath: anchorLog,
  });
  process.stdout.write(`anchored-brain verdict: ${JSON.stringify(anchored.details)}\n`);
  if (!anchored.passed) fail('an anchored, untouched brain must PASS, got passed=false');
  if (anchored.details.anchor_status !== 'consistent')
    fail(`expected anchor_status 'consistent', got ${anchored.details.anchor_status}`);

  // Truncate AFTER anchoring: drop the newest row. The remaining chain is
  // internally clean — intra-chain verification alone sees NOTHING — so only
  // the anchor cross-check can (and must) fail this closed.
  db2.prepare('DELETE FROM audit_events WHERE id = ?').run(ids2[2]);
  const truncated = evaluateProvenanceIntegrity(memRepo2, auditRepo2, {
    tenantId: TENANT,
    exceptionManifestPath: noManifest,
    anchorLogPath: anchorLog,
  });
  process.stdout.write(`truncated-brain verdict: ${JSON.stringify(truncated.details)}\n`);
  if (truncated.passed) fail('an anchored-then-truncated brain must FAIL, got passed=true');
  if (Number(truncated.details.tamper_signatures) !== 0)
    fail(
      `truncation must be invisible to intra-chain verification (tamper_signatures 0), got ${truncated.details.tamper_signatures}`,
    );
  if (Number(truncated.details.anchor_history_truncated) <= 0)
    fail(
      `expected anchor_history_truncated > 0, got ${truncated.details.anchor_history_truncated}`,
    );

  process.stdout.write(
    'ci-provenance-integrity OK — forks pass (disclosed), tamper fails closed, anchor truncation fails closed\n',
  );
  // Success falls through: no `process.exit(0)` here (it would bypass the
  // finally and leak the temp dir). The process exits 0 naturally once the
  // event loop drains.
} catch (err) {
  // Any assertion failure (thrown by `fail`) or unexpected error lands here.
  // Print a diagnostic and set a non-zero exit code — but let `finally` run its
  // cleanup FIRST (setting exitCode does not exit immediately, unlike exit()).
  process.stderr.write(`ci-provenance-integrity FAILED: ${(err as Error).message}\n`);
  process.exitCode = 1;
} finally {
  // Runs on every path (success, assertion failure, unexpected throw): close the
  // DB handles if opened, then remove the temp dir. `db?.close()` is safe even
  // if createDatabase threw before assignment.
  db?.close();
  db2?.close();
  rmSync(dir, { recursive: true, force: true });
}
