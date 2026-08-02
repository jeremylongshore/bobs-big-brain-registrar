import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DENSE_EMBED_URL,
  DEFAULT_DENSE_SEARCH_K,
  DEFAULT_DENSE_TIMEOUT_MS,
  resolveDenseConfig,
} from '../dense-policy.js';

/**
 * Tests for the dense serving policy (bead `compile-then-govern-39z.6`).
 *
 * Two properties matter operationally and are asserted explicitly:
 *   1. dense is ON when nothing is configured — the whole point of this change;
 *   2. the kill switch works under every spelling an operator might reach for
 *      under pressure, because a switch that only answers to one spelling is
 *      not a switch.
 */

describe('resolveDenseConfig — default ON', () => {
  it('enables dense when the env says nothing', () => {
    expect(resolveDenseConfig({}).enabled).toBe(true);
  });

  it('enables dense when TEAMKB_DENSE is set to an affirmative value', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE']) {
      expect(resolveDenseConfig({ TEAMKB_DENSE: v }).enabled, `TEAMKB_DENSE=${v}`).toBe(true);
    }
  });

  it('supplies the loopback embedder and the measured defaults', () => {
    const cfg = resolveDenseConfig({});
    expect(cfg.url).toBe(DEFAULT_DENSE_EMBED_URL);
    expect(cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:/); // never off-host
    expect(cfg.searchK).toBe(DEFAULT_DENSE_SEARCH_K);
    expect(cfg.timeoutMs).toBe(DEFAULT_DENSE_TIMEOUT_MS);
  });

  it('sets a serving timeout well above the measured p95 but still bounded', () => {
    // Measured 2026-08-02 on the real 17,289-vector index: ~123 ms p95 added.
    // The timeout must not trip in normal operation, but must still bound a
    // wedged embedder rather than hanging the search.
    const { timeoutMs } = resolveDenseConfig({});
    expect(timeoutMs).toBeGreaterThan(123 * 5);
    expect(timeoutMs).toBeLessThanOrEqual(5000);
  });
});

describe('resolveDenseConfig — kill switch', () => {
  it('disables dense on every off-spelling, case-insensitively', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False', ' no ']) {
      expect(resolveDenseConfig({ TEAMKB_DENSE: v }).enabled, `TEAMKB_DENSE=${v}`).toBe(false);
    }
  });

  it('does not treat an empty or whitespace value as OFF', () => {
    // An empty var is "unset with extra steps", not a deliberate disable.
    expect(resolveDenseConfig({ TEAMKB_DENSE: '' }).enabled).toBe(true);
    expect(resolveDenseConfig({ TEAMKB_DENSE: '   ' }).enabled).toBe(true);
  });

  it('still returns a usable url/searchK/timeout when disabled', () => {
    // The adapter reads the whole object; a disabled config must still be
    // structurally valid rather than half-populated.
    const cfg = resolveDenseConfig({ TEAMKB_DENSE: '0' });
    expect(cfg.enabled).toBe(false);
    expect(cfg.url).toBe(DEFAULT_DENSE_EMBED_URL);
    expect(cfg.searchK).toBeGreaterThan(0);
    expect(cfg.timeoutMs).toBeGreaterThan(0);
  });
});

describe('resolveDenseConfig — endpoint override', () => {
  it('honors TEAMKB_DENSE_URL', () => {
    expect(resolveDenseConfig({ TEAMKB_DENSE_URL: 'http://127.0.0.1:9999' }).url).toBe(
      'http://127.0.0.1:9999',
    );
  });

  it('falls back to the default when the override is blank', () => {
    expect(resolveDenseConfig({ TEAMKB_DENSE_URL: '   ' }).url).toBe(DEFAULT_DENSE_EMBED_URL);
  });

  it('is deterministic — same env in, same config out', () => {
    const env = { TEAMKB_DENSE: 'on', TEAMKB_DENSE_URL: 'http://127.0.0.1:8098' };
    expect(resolveDenseConfig(env)).toEqual(resolveDenseConfig(env));
  });
});
