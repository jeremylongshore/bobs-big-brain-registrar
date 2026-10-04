/**
 * Governed redaction of a promoted memory (Epic K bead K3, expanded scope —
 * decision `000-docs/053-AT-DECR`, umbrella bead `compile-then-govern-39z.16`).
 *
 * Archiving a memory that holds a secret hides it from default search; the
 * plaintext stays in the store. Redaction REPLACES the content — in the
 * `curated_memories` row and in every `candidates` copy — recomputes the content
 * hash, and appends a hash-chained `redacted` receipt per rewritten row, all in
 * one transaction.
 *
 * What the receipt records: that it happened, who did it, why, the OLD and NEW
 * content hashes, the mode, and the NAMES of the secret patterns that fired on
 * the old text. What it never records: the removed text.
 *
 * What this does not do: it never edits, re-hashes or removes an existing audit
 * row. The chain covers `audit_events` only, so every earlier receipt verifies
 * exactly as before and the `redacted` receipt chains forward from the head.
 *
 * Removing the freed BYTES from the database files is a separate step
 * (`@qmd-team-intent-kb/store` `scrubFreedPages`), run by the CLI after this
 * transaction commits.
 *
 * @module redaction/redact-memory
 */

import { randomUUID } from 'node:crypto';

import {
  computeContentHash,
  DisclosureRejectedError,
  scanDisclosureFields,
} from '@qmd-team-intent-kb/common';
import { redactSecrets, scanTextForSecrets } from '@qmd-team-intent-kb/policy-engine';
import {
  AuditEvent as AuditEventSchema,
  CuratedMemory as CuratedMemorySchema,
} from '@qmd-team-intent-kb/schema';
import type { CuratedMemory } from '@qmd-team-intent-kb/schema';
import type {
  AuditRepository,
  CandidateRepository,
  MemoryRepository,
} from '@qmd-team-intent-kb/store';

/** Text written in place of a caller-supplied span. */
export const REDACTION_MARKER = '[REDACTED]';

/** Matches every marker a redaction writes: `[REDACTED]` and `[REDACTED:<pattern-id>]`. */
const MARKER_PATTERN = /\[REDACTED(?::[^\]\n]*)?\]/g;

/** Lines shorter than this are too generic to be evidence in a byte scan. */
const MIN_LINE_FRAGMENT = 12;
/** Removed spans shorter than this are too generic to be evidence in a byte scan. */
const MIN_SPAN_FRAGMENT = 4;
/** Upper bound on fragments handed to the byte scan. */
const MAX_FRAGMENTS = 500;

const DISCLOSURE =
  'The replacement fails the disclosure gate (PII, compensation or credential material). Nothing was written.';

/** A half-open character range `[start, end)` of the memory's content. */
export interface RedactionSpan {
  start: number;
  end: number;
}

/** How the replacement content is produced. */
export type RedactionMode =
  /** The caller supplies the whole replacement content. */
  | { kind: 'replacement'; content: string }
  /** The caller names the ranges to remove; each becomes {@link REDACTION_MARKER}. */
  | { kind: 'spans'; spans: readonly RedactionSpan[] }
  /** The deterministic secret scan finds and replaces what it recognizes. */
  | { kind: 'scan' };

export interface RedactMemoryInput {
  memoryId: string;
  /** Tenant scope: a memory in another tenant is reported as not found. */
  tenantId: string;
  /** Who is redacting — recorded as the receipt's human actor. */
  actor: string;
  /** Why — recorded verbatim on the receipt. Must not itself contain a secret. */
  reason: string;
  mode: RedactionMode;
  /** Replacement title, for a memory whose TITLE carries the secret. */
  replacementTitle?: string;
  /** Compute and report without writing. */
  dryRun?: boolean;
  /** Injected clock (ISO-8601). Defaults to the wall clock. */
  now?: string;
}

/** Why a redaction was refused. */
export type RedactionRefusalCode =
  | 'not_found'
  | 'missing_reason'
  | 'missing_actor'
  | 'secret_in_reason'
  | 'empty_replacement'
  | 'invalid_spans'
  | 'nothing_to_redact'
  | 'residual_secret'
  | 'disclosure_in_replacement';

export type RedactMemoryResult =
  | {
      ok: true;
      /**
       * `redacted` — content was replaced and receipted. `would_redact` — dry-run
       * of the same. `unchanged` — the stored content already equals the
       * replacement (a re-run); nothing was written.
       */
      status: 'redacted' | 'would_redact' | 'unchanged';
      memoryId: string;
      mode: RedactionMode['kind'];
      oldContentHash: string;
      newContentHash: string;
      /** Names of the secret patterns that fired on the OLD text. Never the text. */
      patternNames: string[];
      /**
       * Where each pattern fired in the OLD content: pattern name -> 1-based line
       * numbers. Line numbers only, so an operator can aim `--lines` at them.
       */
      patternLines: Record<string, number[]>;
      titleChanged: boolean;
      /** Candidate rows whose stored copy was (or would be) rewritten. */
      candidateIds: string[];
      /** Receipt ids: the memory's first, then one per candidate. Empty unless `redacted`. */
      auditEventIds: string[];
    }
  | { ok: false; memoryId: string; code: RedactionRefusalCode; error: string };

/**
 * A redaction outcome plus the removed text fragments. The fragments exist ONLY
 * so the caller can byte-scan the store files for them; they must never be
 * printed, logged or persisted.
 */
export interface RedactMemoryOutcome {
  result: RedactMemoryResult;
  removedFragments: string[];
}

export interface RedactionDependencies {
  memoryRepo: MemoryRepository;
  candidateRepo: CandidateRepository;
  auditRepo: AuditRepository;
}

interface PatternHits {
  ids: string[];
  names: string[];
}

/**
 * Unique pattern ids + names the governance secret scan fires on, over several
 * texts. Uses `scanTextForSecrets` — the same function the promote-time
 * `secret_detection` rule and the whole-brain `secret-sweep` call — so redaction
 * cannot disagree with the gate about what a secret is.
 */
function scanPatterns(...texts: string[]): PatternHits {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const text of texts) {
    for (const finding of scanTextForSecrets(text)) {
      ids.add(finding.patternId);
      names.add(finding.patternName);
    }
  }
  return { ids: [...ids].sort(), names: [...names].sort() };
}

/** Validate caller-supplied spans: integers, in bounds, non-empty, ascending, disjoint. */
function validateSpans(spans: readonly RedactionSpan[], length: number): string | null {
  if (spans.length === 0) return 'no spans were supplied';
  let previousEnd = 0;
  for (const span of spans) {
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) {
      return 'span offsets must be integers';
    }
    if (span.start < 0 || span.end > length || span.start >= span.end) {
      return `span [${span.start}, ${span.end}) is empty or outside the content (length ${length})`;
    }
    if (span.start < previousEnd) return 'spans must be ascending and must not overlap';
    previousEnd = span.end;
  }
  return null;
}

/** Replace each span with the marker. Spans are already validated. */
function applySpans(content: string, spans: readonly RedactionSpan[]): string {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += content.slice(cursor, span.start) + REDACTION_MARKER;
    cursor = span.end;
  }
  return out + content.slice(cursor);
}

/**
 * Recover the text a marker-based redaction removed, by aligning the literal
 * pieces of the new content (the text between markers) against the old content:
 * whatever sits between two consecutive pieces in the old text is what a marker
 * replaced. Returns [] when the pieces do not align.
 */
function removedSegments(oldText: string, newText: string): string[] {
  const pieces = newText.split(MARKER_PATTERN);
  if (pieces.length < 2) return [];
  const segments: string[] = [];
  let cursor = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    const isLast = i === pieces.length - 1;
    const index = isLast ? oldText.length - piece.length : oldText.indexOf(piece, cursor);
    if (index < cursor || !oldText.startsWith(piece, index)) return [];
    if (i > 0) segments.push(oldText.slice(cursor, index));
    cursor = index + piece.length;
  }
  return segments;
}

/** Old lines that no longer appear anywhere in the new text. */
function removedLines(oldText: string, newText: string): string[] {
  return oldText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= MIN_LINE_FRAGMENT && !newText.includes(line));
}

/** The fragments of the old content/title that the redaction removed. */
function collectRemovedFragments(
  memory: CuratedMemory,
  mode: RedactionMode,
  newContent: string,
  newTitle: string,
): string[] {
  const fragments = new Set<string>();
  const spanTexts =
    mode.kind === 'spans'
      ? mode.spans.map((s) => memory.content.slice(s.start, s.end))
      : removedSegments(memory.content, newContent);
  for (const text of spanTexts) {
    const trimmed = text.trim();
    if (trimmed.length >= MIN_SPAN_FRAGMENT) fragments.add(trimmed);
  }
  for (const line of removedLines(memory.content, newContent)) fragments.add(line);
  if (newTitle !== memory.title && memory.title.trim().length >= MIN_LINE_FRAGMENT) {
    fragments.add(memory.title.trim());
  }
  return [...fragments].slice(0, MAX_FRAGMENTS);
}

type Plan =
  | { ok: true; newContent: string; newTitle: string }
  | { ok: false; code: RedactionRefusalCode; error: string };

/** Produce the replacement content and title for the requested mode. */
function planReplacement(memory: CuratedMemory, input: RedactMemoryInput): Plan {
  const { mode } = input;
  let newContent: string;
  let newTitle = input.replacementTitle ?? memory.title;
  switch (mode.kind) {
    case 'replacement':
      if (mode.content.trim() === '') {
        return { ok: false, code: 'empty_replacement', error: 'Replacement content is empty' };
      }
      newContent = mode.content;
      break;
    case 'spans': {
      const invalid = validateSpans(mode.spans, memory.content.length);
      if (invalid !== null) return { ok: false, code: 'invalid_spans', error: invalid };
      newContent = applySpans(memory.content, mode.spans);
      break;
    }
    case 'scan':
      newContent = redactSecrets(memory.content);
      if (input.replacementTitle === undefined) newTitle = redactSecrets(memory.title);
      break;
  }
  if (newTitle.trim() === '') {
    return { ok: false, code: 'empty_replacement', error: 'Replacement title is empty' };
  }
  return { ok: true, newContent, newTitle };
}

/** Refusals that depend only on the request, not on the stored memory. */
function refuseRequest(input: RedactMemoryInput): RedactMemoryResult | null {
  const { memoryId } = input;
  if (input.reason.trim() === '') {
    return { ok: false, memoryId, code: 'missing_reason', error: 'A reason is required to redact' };
  }
  if (input.actor.trim() === '') {
    return { ok: false, memoryId, code: 'missing_actor', error: 'An actor is required to redact' };
  }
  if (scanTextForSecrets(input.reason).length > 0) {
    return {
      ok: false,
      memoryId,
      code: 'secret_in_reason',
      error:
        'The reason itself matches a secret pattern. The reason is written to the receipt verbatim — describe the redaction without quoting the secret.',
    };
  }
  return null;
}

/** The candidate rows that hold a copy of this memory's text. */
function candidateCopies(
  memory: CuratedMemory,
  oldContentHash: string,
  candidateRepo: CandidateRepository,
): string[] {
  const ids = new Set<string>();
  if (candidateRepo.readStoredText(memory.candidateId, memory.tenantId) !== null) {
    ids.add(memory.candidateId);
  }
  for (const id of candidateRepo.findIdsByContentHashAndTenant(oldContentHash, memory.tenantId)) {
    ids.add(id);
  }
  return [...ids];
}

/**
 * Redact one promoted memory. Synchronous and deterministic; never throws for a
 * refusal. On success the memory row, every candidate copy, and one `redacted`
 * receipt per rewritten row are committed in a single transaction.
 *
 * Every mode ends with the same check: the replacement content and title are
 * re-scanned with the deterministic secret scan, and the redaction is REFUSED if
 * anything still fires. Scan mode therefore cannot report success while leaving
 * a secret it recognizes but could not remove.
 */
export function redactMemory(
  input: RedactMemoryInput,
  deps: RedactionDependencies,
): RedactMemoryOutcome {
  const { memoryId } = input;
  const refusal = (result: RedactMemoryResult): RedactMemoryOutcome => ({
    result,
    removedFragments: [],
  });

  const requestRefusal = refuseRequest(input);
  if (requestRefusal !== null) return refusal(requestRefusal);

  const memory = deps.memoryRepo.findById(memoryId);
  if (memory === null || memory.tenantId !== input.tenantId) {
    return refusal({
      ok: false,
      memoryId,
      code: 'not_found',
      error: `Memory ${memoryId} not found in tenant ${input.tenantId}`,
    });
  }

  const plan = planReplacement(memory, input);
  if (!plan.ok) return refusal({ ok: false, memoryId, code: plan.code, error: plan.error });
  const { newContent, newTitle } = plan;

  // Re-scan the RESULT. Anything the scan still recognizes is a refusal.
  const residual = scanPatterns(newContent, newTitle);
  if (residual.names.length > 0) {
    return refusal({
      ok: false,
      memoryId,
      code: 'residual_secret',
      error:
        `The replacement still matches secret pattern(s): ${residual.names.join(', ')}. ` +
        `Nothing was written. Remove them with caller-supplied lines or replacement text.`,
    });
  }

  // The replacement must also pass the disclosure gate every write path uses
  // (PII, compensation, credentials) — a redaction cannot itself write them.
  if (scanDisclosureFields([newContent, newTitle]) !== null) {
    return refusal({ ok: false, memoryId, code: 'disclosure_in_replacement', error: DISCLOSURE });
  }

  // Hash the old CONTENT rather than trusting the stored column: this is the
  // hash a re-ingest of the same text produces, which is what dedup must match.
  const oldContentHash = computeContentHash(memory.content);
  const newContentHash = computeContentHash(newContent);
  const titleChanged = newTitle !== memory.title;
  const before = scanPatterns(memory.content, memory.title);
  const priorReceipts = deps.auditRepo.findRedactionsFor(memoryId);
  const base = {
    ok: true as const,
    memoryId,
    mode: input.mode.kind,
    oldContentHash,
    newContentHash,
    patternNames: before.names,
    patternLines: Object.fromEntries(
      scanTextForSecrets(memory.content).map((f) => [f.patternName, f.lines]),
    ),
    titleChanged,
  };

  if (newContent === memory.content && !titleChanged) {
    if (input.mode.kind === 'scan' && priorReceipts.length === 0) {
      return refusal({
        ok: false,
        memoryId,
        code: 'nothing_to_redact',
        error:
          'The deterministic secret scan found nothing it could remove in this memory. ' +
          'A scan miss is not proof the memory is clean — supply the lines or the replacement text.',
      });
    }
    return {
      result: { ...base, status: 'unchanged', candidateIds: [], auditEventIds: [] },
      removedFragments: [],
    };
  }

  const candidateIds = candidateCopies(memory, oldContentHash, deps.candidateRepo);
  const removedFragments = collectRemovedFragments(memory, input.mode, newContent, newTitle);

  if (input.dryRun === true) {
    return {
      result: { ...base, status: 'would_redact', candidateIds, auditEventIds: [] },
      removedFragments: [],
    };
  }

  const now = input.now ?? new Date().toISOString();
  const actor = { type: 'human' as const, id: input.actor };
  const auditEventIds: string[] = [];
  const updated = CuratedMemorySchema.parse({
    ...memory,
    content: newContent,
    title: newTitle,
    contentHash: newContentHash,
    updatedAt: now,
    version: memory.version + 1,
  });

  try {
    deps.memoryRepo.connection
      .transaction((): void => {
        deps.memoryRepo.update(updated);
        const memoryEventId = randomUUID();
        deps.auditRepo.insert(
          AuditEventSchema.parse({
            id: memoryEventId,
            action: 'redacted',
            memoryId,
            tenantId: memory.tenantId,
            actor,
            reason: input.reason,
            details: {
              target: 'memory',
              mode: input.mode.kind,
              oldContentHash,
              newContentHash,
              patternNames: before.names,
              patternIds: before.ids,
              titleChanged,
              candidateIds,
              // Only on a row whose stored hash had already drifted from its
              // content: the hash the row carried, for whoever traces its id.
              ...(memory.contentHash !== oldContentHash
                ? { storedContentHash: memory.contentHash }
                : {}),
            },
            timestamp: now,
          }),
        );
        auditEventIds.push(memoryEventId);

        for (const candidateId of candidateIds) {
          // Read without domain validation: a legacy row that no longer parses
          // can still hold the text being removed.
          const candidate = deps.candidateRepo.readStoredText(candidateId, memory.tenantId);
          if (candidate === null) continue;
          const candidateOldHash = computeContentHash(candidate.content);
          const candidateNewHash = deps.candidateRepo.updateContent(candidateId, memory.tenantId, {
            content: newContent,
            title: titleChanged ? newTitle : candidate.title,
          });
          if (candidateNewHash === null) continue;
          const candidateEventId = randomUUID();
          deps.auditRepo.insert(
            AuditEventSchema.parse({
              id: candidateEventId,
              action: 'redacted',
              memoryId: candidateId,
              tenantId: memory.tenantId,
              actor,
              reason: input.reason,
              details: {
                target: 'candidate',
                mode: input.mode.kind,
                memoryId,
                oldContentHash: candidateOldHash,
                newContentHash: candidateNewHash,
              },
              timestamp: now,
            }),
          );
          auditEventIds.push(candidateEventId);
        }
      })
      .immediate();
  } catch (err) {
    // The disclosure gate on the candidate copy rejected the replacement. The
    // transaction rolled back, so the memory row is untouched as well.
    if (err instanceof DisclosureRejectedError) {
      return refusal({
        ok: false,
        memoryId,
        code: 'disclosure_in_replacement',
        error: DISCLOSURE,
      });
    }
    throw err;
  }

  return {
    result: { ...base, status: 'redacted', candidateIds, auditEventIds },
    removedFragments,
  };
}
