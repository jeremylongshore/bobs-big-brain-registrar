import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import { HealthServer } from '../health-server.js';
import type { DaemonState, CycleResult } from '../types.js';

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const CYCLE_RESULT: CycleResult = {
  startedAt: '2026-01-15T10:00:00.000Z',
  completedAt: '2026-01-15T10:00:01.000Z',
  ingest: { ingested: 2, errors: [], summary: null },
  curation: null,
  staleness: null,
  export: null,
  indexUpdate: null,
};

describe('HealthServer', () => {
  let server: HealthServer;
  let state: DaemonState;
  let lastCycle: CycleResult | null;

  beforeEach(async () => {
    state = 'running';
    lastCycle = null;

    server = new HealthServer({
      port: 0,
      getState: () => state,
      getLastCycleResult: () => lastCycle,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('/healthz', () => {
    it('returns 200 with status ok while running', async () => {
      state = 'running';
      const res = await httpGet(server.port, '/healthz');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });

    it('returns 503 with status stopping while stopping', async () => {
      state = 'stopping';
      const res = await httpGet(server.port, '/healthz');
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ status: 'stopping' });
    });

    it('returns 200 for idle state (not stopping)', async () => {
      state = 'idle';
      const res = await httpGet(server.port, '/healthz');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });
  });

  describe('/last-cycle', () => {
    it('returns 404 when no cycle has run', async () => {
      lastCycle = null;
      const res = await httpGet(server.port, '/last-cycle');
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'no cycle has run' });
    });

    it('returns 200 with serialized CycleResult when a cycle has run', async () => {
      lastCycle = CYCLE_RESULT;
      const res = await httpGet(server.port, '/last-cycle');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual(CYCLE_RESULT);
    });

    it('reflects the most recent cycle result', async () => {
      lastCycle = CYCLE_RESULT;
      const res1 = await httpGet(server.port, '/last-cycle');
      expect(JSON.parse(res1.body)).toEqual(CYCLE_RESULT);

      const updated: CycleResult = { ...CYCLE_RESULT, startedAt: '2026-01-16T00:00:00.000Z' };
      lastCycle = updated;
      const res2 = await httpGet(server.port, '/last-cycle');
      expect(JSON.parse(res2.body)).toEqual(updated);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for an unknown path', async () => {
      const res = await httpGet(server.port, '/unknown');
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not found' });
    });

    it('returns 404 for root path', async () => {
      const res = await httpGet(server.port, '/');
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not found' });
    });
  });

  describe('lifecycle', () => {
    it('stop() resolves cleanly', async () => {
      const srv = new HealthServer({
        port: 0,
        getState: () => 'running' as const,
        getLastCycleResult: () => null,
      });
      await srv.start();
      await expect(srv.stop()).resolves.toBeUndefined();
    });

    it('stop() on a never-started server resolves cleanly', async () => {
      const srv = new HealthServer({
        port: 0,
        getState: () => 'running' as const,
        getLastCycleResult: () => null,
      });
      await expect(srv.stop()).resolves.toBeUndefined();
    });

    it('exposes the assigned port after start', async () => {
      expect(server.port).toBeGreaterThan(0);
    });
  });

  describe('host option', () => {
    it('starts successfully with explicit host set to 127.0.0.1', async () => {
      const srv = new HealthServer({
        port: 0,
        host: '127.0.0.1',
        getState: () => 'running' as const,
        getLastCycleResult: () => null,
      });
      await srv.start();
      expect(srv.port).toBeGreaterThan(0);
      const res = await httpGet(srv.port, '/healthz');
      expect(res.status).toBe(200);
      await srv.stop();
    });

    it('starts successfully without a host option (defaults to 127.0.0.1)', async () => {
      const srv = new HealthServer({
        port: 0,
        getState: () => 'running' as const,
        getLastCycleResult: () => null,
      });
      await srv.start();
      expect(srv.port).toBeGreaterThan(0);
      const res = await httpGet(srv.port, '/healthz');
      expect(res.status).toBe(200);
      await srv.stop();
    });

    it('starts successfully with host set to 0.0.0.0 and is reachable via 127.0.0.1', async () => {
      const srv = new HealthServer({
        port: 0,
        host: '0.0.0.0',
        getState: () => 'running' as const,
        getLastCycleResult: () => null,
      });
      await srv.start();
      expect(srv.port).toBeGreaterThan(0);
      // When bound to 0.0.0.0, loopback connections still work
      const res = await httpGet(srv.port, '/healthz');
      expect(res.status).toBe(200);
      await srv.stop();
    });
  });
});
