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
  computeEntryHash,
  createDatabase,
} from '@qmd-team-intent-kb/store';

import { evaluateProvenanceIntegrity } from '../src/index.js';

const TENANT = 'ci-provenance';

function fail(msg: string): never {
  process.stderr.write(`ci-provenance-integrity FAILED: ${msg}\n`);
  process.exit(1);
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

try {
  const db = createDatabase({ path: dbPath });
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
  });
  process.stdout.write(`forked-brain verdict: ${JSON.stringify(forked.details)}\n`);
  if (!forked.passed) fail('forked-but-untampered brain must PASS, got passed=false');
  if (Number(forked.details.chain_forks) <= 0)
    fail(`expected chain_forks > 0, got ${forked.details.chain_forks}`);
  if (Number(forked.details.tamper_signatures) !== 0)
    fail(`expected tamper_signatures 0, got ${forked.details.tamper_signatures}`);

  // --- now introduce a REAL tamper break and assert the eval fails closed.
  db.prepare(`UPDATE audit_events SET reason = 'TAMPERED' WHERE id = ?`).run(ids[1]);
  const tampered = evaluateProvenanceIntegrity(memRepo, auditRepo, {
    tenantId: TENANT,
    exceptionManifestPath: noManifest,
  });
  process.stdout.write(`tampered-brain verdict: ${JSON.stringify(tampered.details)}\n`);
  if (tampered.passed) fail('a tampered brain must FAIL, got passed=true');
  if (Number(tampered.details.tamper_signatures) <= 0)
    fail('expected tamper_signatures > 0 on a tampered brain');

  db.close();
  process.stdout.write(
    'ci-provenance-integrity OK — forks pass (disclosed), tamper fails closed\n',
  );
  process.exit(0);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
