import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// loadConfig — TEAMKB_API_HOST coercion (compile-then-govern-c5k.3)
// ---------------------------------------------------------------------------
//
// An empty / whitespace-only TEAMKB_API_HOST must resolve to loopback. Without
// the fix, the nullish-coalesce passed '' through unchanged, isLoopbackHost('')
// classified it as loopback (so the boot assertion stayed silent), and
// app.listen({ host: '' }) bound :: (all interfaces) — an unauthenticated brain
// reachable off-host. `||` collapses '' / whitespace to 127.0.0.1.

describe('loadConfig — TEAMKB_API_HOST coercion', () => {
  const HOST = 'TEAMKB_API_HOST';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[HOST];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[HOST];
    else process.env[HOST] = original;
  });

  it('coerces an empty TEAMKB_API_HOST to 127.0.0.1', () => {
    process.env[HOST] = '';
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('coerces a whitespace-only TEAMKB_API_HOST to 127.0.0.1', () => {
    process.env[HOST] = '   ';
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('trims surrounding whitespace from a real host', () => {
    process.env[HOST] = '  127.0.0.1  ';
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('passes a real explicit host through unchanged', () => {
    process.env[HOST] = '127.0.0.1';
    expect(loadConfig().host).toBe('127.0.0.1');
  });

  it('defaults to 127.0.0.1 when TEAMKB_API_HOST is unset', () => {
    delete process.env[HOST];
    expect(loadConfig().host).toBe('127.0.0.1');
  });
});
