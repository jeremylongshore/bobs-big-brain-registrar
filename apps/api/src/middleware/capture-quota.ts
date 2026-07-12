import type { FastifyInstance } from 'fastify';

interface QuotaEntry {
  count: number;
  windowStart: number;
}

/**
 * Per-ACTOR capture quota on `POST /api/candidates` (jfv.10).
 *
 * The global rate-limiter is keyed on source IP, which gives no real cap on the
 * tailnet: every teammate device is its own `100.x` IP, so one runaway or
 * compromised token — or an over-eager auto-capture hook (Track 4) — could flood
 * the inbox with quarantined rows (the backlog canary only warns at 200). This
 * caps how many candidates ONE token identity (`request.actor`) may propose per
 * window, so the limit follows the token, not the machine.
 *
 * Intake only: promote/reject are admin-gated and low-volume, so they are not
 * capped here. Registered as an `onRequest` hook AFTER auth, so `request.actor`
 * is already stamped.
 */
export function registerCaptureQuota(
  app: FastifyInstance,
  maxCaptures: number,
  windowMs: number,
): void {
  const actors = new Map<string, QuotaEntry>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of actors) {
      if (now - entry.windowStart > windowMs * 2) actors.delete(key);
    }
  }, windowMs);
  cleanup.unref();

  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST') return;
    const path = request.url.split('?')[0] ?? request.url;
    if (path !== '/api/candidates') return;

    // Key on the authenticated token identity; fall back to IP only on the
    // loopback dev/no-auth path (where every request is actor='dev').
    const key = request.actor ?? request.ip;
    const now = Date.now();
    const entry = actors.get(key);

    if (entry === undefined || now - entry.windowStart > windowMs) {
      actors.set(key, { count: 1, windowStart: now });
      return;
    }

    entry.count++;
    if (entry.count > maxCaptures) {
      reply.status(429);
      throw new Error(
        `Capture quota exceeded for this token (max ${maxCaptures} per ${Math.round(
          windowMs / 1000,
        )}s). Slow down, or ask an admin to raise the quota.`,
      );
    }
  });
}
