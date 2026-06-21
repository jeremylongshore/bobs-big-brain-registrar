import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_TEAMKB_BASE, getTeamKbBasePath, resolveTeamKbPath } from '../paths.js';

describe('paths', () => {
  const originalBasePath = process.env['TEAMKB_BASE_PATH'];
  const originalHome = process.env['TEAMKB_HOME'];

  function restore(name: 'TEAMKB_BASE_PATH' | 'TEAMKB_HOME', original: string | undefined): void {
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }

  afterEach(() => {
    restore('TEAMKB_BASE_PATH', originalBasePath);
    restore('TEAMKB_HOME', originalHome);
  });

  describe('DEFAULT_TEAMKB_BASE', () => {
    it('is ~/.teamkb', () => {
      expect(DEFAULT_TEAMKB_BASE).toBe(join(homedir(), '.teamkb'));
    });
  });

  describe('getTeamKbBasePath', () => {
    it('returns default when no env set', () => {
      delete process.env['TEAMKB_BASE_PATH'];
      delete process.env['TEAMKB_HOME'];
      expect(getTeamKbBasePath()).toBe(DEFAULT_TEAMKB_BASE);
    });

    it('returns TEAMKB_BASE_PATH override when set', () => {
      process.env['TEAMKB_BASE_PATH'] = '/tmp/custom-teamkb';
      expect(getTeamKbBasePath()).toBe('/tmp/custom-teamkb');
    });

    // The ICO → INTKB spool handoff: ICO's emitter writes to
    // `$TEAMKB_HOME/spool` when only TEAMKB_HOME is set. INTKB's reader must
    // resolve the SAME base from that env name, or candidates land where INTKB
    // never polls.
    it('falls back to TEAMKB_HOME when TEAMKB_BASE_PATH is unset (matches ICO emitter)', () => {
      delete process.env['TEAMKB_BASE_PATH'];
      process.env['TEAMKB_HOME'] = '/tmp/ico-teamkb-home';
      expect(getTeamKbBasePath()).toBe('/tmp/ico-teamkb-home');
    });

    it('prefers TEAMKB_BASE_PATH over TEAMKB_HOME when both are set', () => {
      process.env['TEAMKB_BASE_PATH'] = '/tmp/canonical';
      process.env['TEAMKB_HOME'] = '/tmp/ico-home';
      expect(getTeamKbBasePath()).toBe('/tmp/canonical');
    });

    it('ignores blank / whitespace-only TEAMKB_BASE_PATH and falls through to TEAMKB_HOME', () => {
      process.env['TEAMKB_BASE_PATH'] = '   ';
      process.env['TEAMKB_HOME'] = '/tmp/ico-home';
      expect(getTeamKbBasePath()).toBe('/tmp/ico-home');
    });

    it('ignores blank TEAMKB_HOME and falls through to the default', () => {
      delete process.env['TEAMKB_BASE_PATH'];
      process.env['TEAMKB_HOME'] = '';
      expect(getTeamKbBasePath()).toBe(DEFAULT_TEAMKB_BASE);
    });

    it('trims surrounding whitespace from the resolved override', () => {
      process.env['TEAMKB_BASE_PATH'] = '  /tmp/padded  ';
      expect(getTeamKbBasePath()).toBe('/tmp/padded');
    });
  });

  describe('resolveTeamKbPath', () => {
    it('joins subdir to base path', () => {
      delete process.env['TEAMKB_BASE_PATH'];
      expect(resolveTeamKbPath('spool')).toBe(join(DEFAULT_TEAMKB_BASE, 'spool'));
    });

    it('respects env override', () => {
      process.env['TEAMKB_BASE_PATH'] = '/tmp/custom';
      expect(resolveTeamKbPath('qmd-index')).toBe('/tmp/custom/qmd-index');
    });

    it('handles nested subdirs', () => {
      delete process.env['TEAMKB_BASE_PATH'];
      expect(resolveTeamKbPath('qmd-index/tenant-1/kb-curated')).toBe(
        join(DEFAULT_TEAMKB_BASE, 'qmd-index/tenant-1/kb-curated'),
      );
    });
  });
});
