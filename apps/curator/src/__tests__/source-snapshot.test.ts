import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeContentHash, deriveMemoryId } from '@qmd-team-intent-kb/common';
import { MemoryCandidate } from '@qmd-team-intent-kb/schema';
import {
  AuditRepository,
  MemoryRepository,
  createTestDatabase,
  createDatabase,
  openExistingDatabase,
  generateActorKeypair,
} from '@qmd-team-intent-kb/store';
import { makeAuditEvent } from '@qmd-team-intent-kb/test-fixtures';
import { makeMemory, TENANT } from './fixtures.js';
import { recordCandidateMinimumSensitivity } from '../recovery/sensitivity-constraint.js';
import { exportSourceSnapshot, verifySourceSnapshot } from '../merge/source-snapshot.js';
import {
  MAX_SOURCE_SNAPSHOT_BYTES,
  SignedSourceSnapshot,
  SourceSnapshotError,
  snapshotCanonicalJson,
  snapshotSigningBytes,
  sourceSnapshotDigest,
} from '../merge/source-snapshot-schema.js';
import type { TrustedSourceCheckpoint } from '../merge/source-snapshot-schema.js';

const options = {
  sourceId: 'fixture-source',
  sourceTenantId: TENANT,
  destinationTenantId: 'destination',
  sequence: 7,
  issuedAt: '2026-11-22T00:00:00.000Z',
  expiresAt: '2026-11-23T00:00:00.000Z',
};
const now = Date.parse('2026-11-22T12:00:00.000Z');

function row(
  content = 'A synthetic source decision',
  extra: Parameters<typeof makeMemory>[0] = {},
) {
  const candidateId = randomUUID();
  const contentHash = computeContentHash(content);
  return makeMemory({
    content,
    contentHash,
    candidateId,
    id: deriveMemoryId(candidateId, contentHash),
    ...extra,
  });
}

describe('authenticated complete source snapshots', () => {
  let db: Database.Database;
  let memory: MemoryRepository;
  let audit: AuditRepository;
  let keys: ReturnType<typeof generateActorKeypair>;
  beforeEach(() => {
    db = createTestDatabase();
    memory = new MemoryRepository(db);
    audit = new AuditRepository(db);
    keys = generateActorKeypair();
  });
  afterEach(() => db.close());

  function exported() {
    return exportSourceSnapshot(db, options, keys.privateKeyHex);
  }
  function checkpoint(serialized: string): TrustedSourceCheckpoint {
    const { payload, digest } = SignedSourceSnapshot.parse(JSON.parse(serialized));
    return {
      sourceId: options.sourceId,
      sourceTenantId: options.sourceTenantId,
      destinationTenantId: options.destinationTenantId,
      sequence: options.sequence,
      keyId: payload.keyId,
      publicKeyHex: keys.publicKeyHex,
      snapshotDigest: digest,
      validFrom: options.issuedAt,
      validUntil: options.expiresAt,
      revoked: false,
    };
  }
  function resign(snapshot: SignedSourceSnapshot): string {
    snapshot.payload.itemCount = snapshot.payload.items.length;
    snapshot.payload.inventoryDigest = sourceSnapshotDigest(snapshot.payload.items);
    snapshot.digest = sourceSnapshotDigest(snapshot.payload);
    const key = createPrivateKey({
      key: Buffer.from(keys.privateKeyHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    snapshot.signature = sign(null, snapshotSigningBytes(snapshot.payload), key).toString('hex');
    return snapshotCanonicalJson(snapshot);
  }

  it('exports all active tenant rows and strongest durable floors without writing', () => {
    const first = row();
    const second = row('Second source decision', {
      sensitivity: 'restricted',
      metadata: { filePaths: [], tags: [], audience: 'owner' },
    });
    memory.insert(first);
    memory.insert(second);
    memory.insert(row('Archived excluded', { lifecycle: 'archived' }));
    memory.insert(row('Other tenant excluded', { tenantId: 'other' }));
    const candidate = MemoryCandidate.parse({
      ...first,
      id: first.candidateId,
      status: 'inbox',
      capturedAt: first.promotedAt,
      prePolicyFlags: { potentialSecret: false, lowConfidence: false, duplicateSuspect: false },
    });
    recordCandidateMinimumSensitivity(
      candidate,
      'confidential',
      {
        runId: randomUUID(),
        manifestDigest: 'a'.repeat(64),
        candidateSnapshotDigest: 'b'.repeat(64),
        actor: { type: 'human', id: 'synthetic-owner' },
        role: 'owner',
        reason: 'PRIVATE-AUDIT-REASON-SENTINEL',
      },
      audit,
    );
    const before = db.serialize();
    db.pragma('query_only = ON');
    const encoded = exported();
    const result = verifySourceSnapshot(encoded, checkpoint(encoded), now);
    expect(result.payload.items).toHaveLength(2);
    expect(
      result.payload.items.find((item) => item.memory.id === first.id)?.minimumSensitivity,
    ).toBe('confidential');
    expect(result.payload.items.find((item) => item.memory.id === second.id)).toMatchObject({
      minimumSensitivity: 'restricted',
      memory: { metadata: { audience: 'owner' } },
    });
    expect(encoded).not.toContain('PRIVATE-AUDIT-REASON-SENTINEL');
    expect(encoded).not.toContain(keys.privateKeyHex);
    expect(db.serialize()).toEqual(before);
    expect(exported()).toBe(encoded);
  });

  it('supports an explicitly pinned empty inventory', () => {
    const encoded = exported();
    expect(verifySourceSnapshot(encoded, checkpoint(encoded), now).payload).toMatchObject({
      itemCount: 0,
      items: [],
      auditHead: null,
    });
  });

  it('exports through a genuinely read-only file connection without changing bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'bbb-snapshot-'));
    const path = join(root, 'source.db');
    try {
      const writable = createDatabase({ path });
      new MemoryRepository(writable).insert(row());
      writable.close();
      const before = readFileSync(path);
      const readonly = openExistingDatabase({ path, readonly: true });
      try {
        const encoded = exportSourceSnapshot(readonly, options, keys.privateKeyHex);
        expect(verifySourceSnapshot(encoded, checkpoint(encoded), now).payload.itemCount).toBe(1);
      } finally {
        readonly.close();
      }
      expect(readFileSync(path)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses stored disclosure content before serializing an export', () => {
    const secret = ['sk', 'proj', 'A'.repeat(64)].join('-');
    memory.insert(row(`Synthetic prohibited key ${secret}`));
    expect(() => exported()).toThrow('Source snapshot refused: invalid-source');
  });

  it('scans promoted metadata as well as candidate fields before export', () => {
    const secret = ['sk', 'proj', 'B'.repeat(64)].join('-');
    memory.insert(
      row('Safe content with prohibited promotion metadata', {
        promotedBy: { type: 'human', id: 'fixture', name: secret },
      }),
    );
    expect(() => exported()).toThrow('Source snapshot refused: invalid-source');
  });

  it.each(['invalid-key', 'invalid-window', 'blank-tenant'] as const)(
    'refuses invalid export options: %s',
    (kind) => {
      const input = { ...options };
      if (kind === 'invalid-window') input.expiresAt = input.issuedAt;
      if (kind === 'blank-tenant') input.sourceTenantId = ' ';
      expect(() =>
        exportSourceSnapshot(
          db,
          input,
          kind === 'invalid-key' ? 'PRIVATE-KEY-SENTINEL' : keys.privateKeyHex,
        ),
      ).toThrow(SourceSnapshotError);
    },
  );

  it('refuses an oversized export', () => {
    memory.insert(row('x'.repeat(MAX_SOURCE_SNAPSHOT_BYTES)));
    expect(() => exported()).toThrow('invalid-source');
  });

  it.each(['count', 'digest'] as const)('refuses a signed inconsistent inventory %s', (kind) => {
    const snapshot = JSON.parse(exported()) as SignedSourceSnapshot;
    if (kind === 'count') snapshot.payload.itemCount = 1;
    else snapshot.payload.inventoryDigest = '0'.repeat(64);
    snapshot.digest = sourceSnapshotDigest(snapshot.payload);
    const key = createPrivateKey({
      key: Buffer.from(keys.privateKeyHex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    snapshot.signature = sign(null, snapshotSigningBytes(snapshot.payload), key).toString('hex');
    const encoded = snapshotCanonicalJson(snapshot);
    expect(() => verifySourceSnapshot(encoded, checkpoint(encoded), now)).toThrow(
      'snapshot-mismatch',
    );
  });

  it('rejects contradictory candidate content bindings in a signed inventory', () => {
    const empty = exported();
    const one = row();
    const two = row('Conflicting candidate content', { candidateId: one.candidateId });
    two.id = deriveMemoryId(two.candidateId, two.contentHash);
    memory.insert(one);
    memory.insert(two);
    expect(() => exported()).toThrow('invalid-source');
    // Independently signed artifact must also be checked, not just this exporter.
    const snapshot = JSON.parse(empty) as SignedSourceSnapshot;
    snapshot.payload.items = [one, two]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((memory) => ({
        memory,
        minimumSensitivity: 'internal',
        constraintEvidenceDigest: '0'.repeat(64),
      }));
    const encoded = resign(snapshot);
    expect(() => verifySourceSnapshot(encoded, checkpoint(encoded), now)).toThrow('invalid-source');
  });

  it.each(['malformed', 'content-mismatch'] as const)(
    'refuses %s durable floor evidence',
    (kind) => {
      const value = row();
      memory.insert(value);
      audit.insert(
        makeAuditEvent({
          memoryId: value.candidateId,
          action: 'governed',
          details: {
            kind: 'recovery-sensitivity-floor-v1',
            candidateId: value.candidateId,
            minimumSensitivity: kind === 'malformed' ? 'unknown' : 'restricted',
            contentHash: '0'.repeat(64),
            runId: randomUUID(),
            manifestDigest: 'a'.repeat(64),
            candidateSnapshotDigest: 'b'.repeat(64),
            resolverRole: 'owner',
          },
        }),
      );
      expect(() => exported()).toThrow('invalid-source');
    },
  );

  it.each(['sourceId', 'sourceTenantId', 'destinationTenantId', 'keyId'] as const)(
    'rejects mismatched authority %s',
    (field) => {
      const encoded = exported();
      const pin = checkpoint(encoded);
      pin[field] = field === 'keyId' ? '0'.repeat(64) : 'different';
      expect(() => verifySourceSnapshot(encoded, pin, now)).toThrow('untrusted-source');
    },
  );
  it('rejects revoked authority', () => {
    const encoded = exported();
    expect(() =>
      verifySourceSnapshot(encoded, { ...checkpoint(encoded), revoked: true }, now),
    ).toThrow('untrusted-source');
  });
  it.each([NaN, Infinity, Date.parse(options.issuedAt) - 1, Date.parse(options.expiresAt)])(
    'rejects invalid or out-of-window clock %s',
    (time) => {
      const encoded = exported();
      expect(() => verifySourceSnapshot(encoded, checkpoint(encoded), time)).toThrow(
        'stale-checkpoint',
      );
    },
  );
  it.each(['validFrom', 'validUntil'] as const)('rejects narrower authority window %s', (field) => {
    const encoded = exported();
    expect(() =>
      verifySourceSnapshot(
        encoded,
        { ...checkpoint(encoded), [field]: new Date(now).toISOString() },
        now,
      ),
    ).toThrow('stale-checkpoint');
  });
  it('rejects an old valid signature against a newer checkpoint', () => {
    const old = exported();
    memory.insert(row());
    const fresh = exported();
    expect(() => verifySourceSnapshot(old, checkpoint(fresh), now)).toThrow('snapshot-mismatch');
    expect(() => verifySourceSnapshot(old, { ...checkpoint(old), sequence: 8 }, now)).toThrow(
      'snapshot-mismatch',
    );
  });
  it('rejects a substituted public key', () => {
    const encoded = exported();
    expect(() =>
      verifySourceSnapshot(
        encoded,
        { ...checkpoint(encoded), publicKeyHex: generateActorKeypair().publicKeyHex },
        now,
      ),
    ).toThrow('invalid-signature');
  });
  it('rejects a changed signature', () => {
    const encoded = exported();
    const changed = JSON.parse(encoded) as SignedSourceSnapshot;
    changed.signature = '0'.repeat(128);
    expect(() => verifySourceSnapshot(JSON.stringify(changed), checkpoint(encoded), now)).toThrow(
      'invalid-signature',
    );
  });
  it.each([
    'omit-row',
    'lower-floor',
    'change-content',
    'change-tenant',
    'unknown-version',
    'count',
    'inventory',
    'unknown-field',
    'missing-default',
  ] as const)('refuses tampering: %s', (change) => {
    memory.insert(row('Source protected decision', { sensitivity: 'confidential' }));
    const encoded = exported();
    const changed = JSON.parse(encoded) as SignedSourceSnapshot;
    const item = changed.payload.items[0]!;
    switch (change) {
      case 'omit-row':
        changed.payload.items = [];
        break;
      case 'lower-floor':
        item.minimumSensitivity = 'public';
        break;
      case 'change-content':
        item.memory.content = 'altered';
        break;
      case 'change-tenant':
        item.memory.tenantId = 'other';
        break;
      case 'unknown-version':
        Object.assign(changed.payload, { version: 99 });
        break;
      case 'count':
        changed.payload.itemCount++;
        break;
      case 'inventory':
        changed.payload.inventoryDigest = '0'.repeat(64);
        break;
      case 'unknown-field':
        Object.assign(item.memory, { unknown: true });
        break;
      case 'missing-default':
        Reflect.deleteProperty(item.memory, 'sensitivity');
        break;
    }
    expect(() => verifySourceSnapshot(JSON.stringify(changed), checkpoint(encoded), now)).toThrow(
      SourceSnapshotError,
    );
  });
  it.each(['order', 'duplicate', 'content', 'identity', 'tenant', 'floor', 'lifecycle'] as const)(
    'rejects even signed invalid inventory: %s',
    (change) => {
      memory.insert(row());
      memory.insert(row('Another decision'));
      const changed = JSON.parse(exported()) as SignedSourceSnapshot;
      const first = changed.payload.items[0]!;
      switch (change) {
        case 'order':
          changed.payload.items.reverse();
          break;
        case 'duplicate':
          changed.payload.items.push(first);
          break;
        case 'content':
          first.memory.content = 'mismatch';
          break;
        case 'identity':
          first.memory.id = randomUUID();
          break;
        case 'tenant':
          first.memory.tenantId = 'other';
          break;
        case 'floor':
          first.minimumSensitivity = 'public';
          break;
        case 'lifecycle':
          first.memory.lifecycle = 'archived';
          break;
      }
      const encoded = resign(changed);
      expect(() => verifySourceSnapshot(encoded, checkpoint(encoded), now)).toThrow(
        'invalid-source',
      );
    },
  );
  it('rejects a newly signed omission against the original complete checkpoint', () => {
    memory.insert(row());
    const original = exported();
    const changed = JSON.parse(original) as SignedSourceSnapshot;
    changed.payload.items = [];
    expect(() => verifySourceSnapshot(resign(changed), checkpoint(original), now)).toThrow(
      'snapshot-mismatch',
    );
  });
  it.each(['not-json', 'x'.repeat(MAX_SOURCE_SNAPSHOT_BYTES + 1)])(
    'refuses malformed/oversized input without echoing it',
    (input) => {
      const encoded = exported();
      expect(() => verifySourceSnapshot(input, checkpoint(encoded), now)).toThrow(
        'Source snapshot refused: invalid-input',
      );
    },
  );
  it.each(['content', 'identity'] as const)(
    'refuses invalid source %s without writing',
    (field) => {
      const value = row();
      if (field === 'content') value.contentHash = '0'.repeat(64);
      else value.id = randomUUID();
      memory.insert(value);
      const before = db.serialize();
      expect(() => exported()).toThrow('invalid-source');
      expect(db.serialize()).toEqual(before);
    },
  );
  it.each(['tampered', 'unverified', 'unknown-hash-version'] as const)(
    'refuses %s audit chains',
    (mode) => {
      audit.insert(makeAuditEvent());
      if (mode === 'tampered') db.prepare("UPDATE audit_events SET reason = 'changed'").run();
      if (mode === 'unverified') db.prepare('UPDATE audit_events SET entry_hash = NULL').run();
      if (mode === 'unknown-hash-version')
        db.prepare('UPDATE audit_events SET hash_version = 99').run();
      const before = db.serialize();
      expect(() => exported()).toThrow('invalid-source');
      expect(db.serialize()).toEqual(before);
    },
  );
  it('refuses an unknown floor model rather than dropping it', () => {
    const value = row();
    memory.insert(value);
    audit.insert(
      makeAuditEvent({
        memoryId: value.candidateId,
        action: 'governed',
        details: { kind: 'future-sensitivity-floor-v2', minimumSensitivity: 'restricted' },
      }),
    );
    expect(() => exported()).toThrow('invalid-source');
  });
});
