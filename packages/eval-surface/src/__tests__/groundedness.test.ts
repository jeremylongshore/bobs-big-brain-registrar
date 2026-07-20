/**
 * groundedness eval unit tests (Wave-2 C2).
 *
 * Asserts the structural guarantees of the groundedness layer:
 *  - fixture v1 shape: ≥50 items, unique ids, both labels, real-export UUIDs;
 *  - the shipped set PASSES: zero undocumented scorer errors, both committed
 *    floors held, supported recall intact;
 *  - the documented limitations (argument swaps, one distant negation) are
 *    REPORTED, not hidden — and the test pins them so a silent scorer change
 *    that "fixes" or worsens them is visible;
 *  - scorer v1 behavior: number inversion / negation flip / wrong component
 *    each flip the verdict; a paraphrase with admitted vocabulary passes;
 *  - a synthetic regression (undocumented wrong prediction) flips passed:false;
 *  - the LLM judge is OFF by default (null without explicit env opt-in) — the
 *    no-LLM-in-CI property as a test.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateGroundedness,
  GROUNDEDNESS_FIXTURE_VERSION,
  GROUNDEDNESS_FLOORS,
  GROUNDEDNESS_ITEMS,
  judgeFromEnv,
  scoreGroundedness,
} from '../index.js';
import type { GroundednessItem, GroundednessReport } from '../index.js';

function report(result: ReturnType<typeof evaluateGroundedness>): GroundednessReport {
  return JSON.parse(String(result.details.report_json)) as GroundednessReport;
}

describe('groundedness fixture v1 — shape', () => {
  it('has ≥50 items with unique ids and both labels represented', () => {
    expect(GROUNDEDNESS_ITEMS.length).toBeGreaterThanOrEqual(50);
    const ids = new Set(GROUNDEDNESS_ITEMS.map((i) => i.id));
    expect(ids.size).toBe(GROUNDEDNESS_ITEMS.length);
    expect(GROUNDEDNESS_ITEMS.some((i) => i.label === 'supported')).toBe(true);
    expect(GROUNDEDNESS_ITEMS.some((i) => i.label === 'unsupported')).toBe(true);
  });

  it('every item carries a kb-export UUID and a non-empty excerpt + claim', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const item of GROUNDEDNESS_ITEMS) {
      expect(item.sourceMemoryId).toMatch(uuid);
      expect(item.memoryExcerpt.length).toBeGreaterThan(40);
      expect(item.claim.length).toBeGreaterThan(20);
    }
  });

  it('every unsupported item names its perturbation', () => {
    for (const item of GROUNDEDNESS_ITEMS.filter((i) => i.label === 'unsupported')) {
      expect(item.perturbation).toBeDefined();
    }
  });
});

describe('evaluateGroundedness — shipped fixture', () => {
  const result = evaluateGroundedness();
  const rep = report(result);

  it('PASSES: zero undocumented errors and both committed floors held', () => {
    expect(result.name).toBe('groundedness');
    expect(rep.fixtureVersion).toBe(GROUNDEDNESS_FIXTURE_VERSION);
    expect(rep.undocumentedErrors).toHaveLength(0);
    expect(rep.supportedPrecision).toBeGreaterThanOrEqual(GROUNDEDNESS_FLOORS.supportedPrecision);
    expect(rep.unsupportedCatchRate).toBeGreaterThanOrEqual(
      GROUNDEDNESS_FLOORS.unsupportedCatchRate,
    );
    expect(result.passed).toBe(true);
  });

  it('holds full supported recall (no supported paraphrase falsely flagged)', () => {
    expect(rep.supportedRecall).toBe(1);
  });

  it('reports the documented limitations rather than hiding them', () => {
    const documented = rep.errors.filter((e) => e.documented);
    expect(documented.length).toBeGreaterThanOrEqual(4);
    // Pin the known blind spots: 3 argument swaps + 1 distant negation. A
    // scorer change that silently alters this set must surface here.
    const swapMisses = documented.filter((e) => e.perturbation === 'argument-swap');
    expect(swapMisses.length).toBe(3);
  });

  it('catches every inverted-number and wrong-component perturbation', () => {
    const byPerturbation = new Map(rep.perPerturbation.map((p) => [p.perturbation, p]));
    expect(byPerturbation.get('inverted-number')!.caught).toBe(
      byPerturbation.get('inverted-number')!.items,
    );
    expect(byPerturbation.get('wrong-component')!.caught).toBe(
      byPerturbation.get('wrong-component')!.items,
    );
  });
});

describe('scoreGroundedness — scorer v1 behavior', () => {
  const memory =
    'The pipeline runs 8 deterministic rules and short-circuits on first failure. Manifest data is never passed to policy evaluation.';

  it('accepts a paraphrase whose vocabulary the memory admits', () => {
    const p = scoreGroundedness(
      'The pipeline runs 8 deterministic rules and short-circuits on the first failure.',
      memory,
    );
    expect(p.predicted).toBe('supported');
  });

  it('flags an inverted number', () => {
    const p = scoreGroundedness('The pipeline runs 12 deterministic rules.', memory);
    expect(p.predicted).toBe('unsupported');
    expect(p.numberMismatches).toContain('12');
  });

  it('flags a negation flip (claim asserts what the memory negates)', () => {
    const p = scoreGroundedness(
      'Manifest data is passed to policy evaluation by the pipeline rules.',
      memory,
    );
    expect(p.predicted).toBe('unsupported');
    expect(p.negationMismatches.length).toBeGreaterThan(0);
  });

  it('flags a wrong-component claim via the token-support floor', () => {
    const p = scoreGroundedness(
      'The pipeline delegates verdicts to a gradient-boosted classifier ensemble.',
      memory,
    );
    expect(p.predicted).toBe('unsupported');
    expect(p.tokenSupport).toBeLessThan(0.7);
  });

  it('flags an affix antonym (sufficient vs insufficient)', () => {
    const p = scoreGroundedness(
      'A direct bump alone is sufficient to clear the finding.',
      'A direct bump alone is insufficient to clear the finding.',
    );
    expect(p.predicted).toBe('unsupported');
    expect(p.negationMismatches).toContain('sufficient');
  });

  it('CANNOT see an argument swap — the documented v1 limitation, pinned', () => {
    const p = scoreGroundedness(
      'Local servers use confidential clients and remote servers use public clients.',
      'Local servers use public clients and remote servers use confidential clients.',
    );
    // If a future scorer version learns to catch swaps, this test flips and
    // the fixture's knownScorerMiss annotations must be re-measured.
    expect(p.predicted).toBe('supported');
  });
});

describe('evaluateGroundedness — synthetic regression', () => {
  it('flips passed:false on an undocumented wrong prediction', () => {
    const regression: GroundednessItem = {
      id: 'syn-supported-but-ungrounded-01',
      sourceMemoryId: '00000000-0000-4000-8000-000000000001',
      memoryExcerpt: 'The deploy pipeline restarts the service after the health check passes.',
      claim: 'Quarterly revenue grew 40 percent across seventeen regional markets.',
      label: 'supported', // mislabeled on purpose: the scorer will say unsupported
    };
    const result = evaluateGroundedness({ items: [regression] });
    const rep = report(result);
    expect(rep.undocumentedErrors).toHaveLength(1);
    expect(result.passed).toBe(false);
  });
});

describe('LLM judge — OFF in CI by construction', () => {
  it('returns null without the explicit double env opt-in', () => {
    expect(judgeFromEnv({})).toBeNull();
    expect(judgeFromEnv({ GROUNDEDNESS_LLM_JUDGE: 'minimax' })).toBeNull();
    expect(judgeFromEnv({ MINIMAX_API_KEY: 'x' })).toBeNull();
  });

  it('builds a named judge only when fully opted in (no network touched)', () => {
    const judge = judgeFromEnv({
      GROUNDEDNESS_LLM_JUDGE: 'minimax',
      MINIMAX_API_KEY: 'test-key-not-real',
    });
    expect(judge).not.toBeNull();
    expect(judge!.name).toContain('minimax');
  });
});
