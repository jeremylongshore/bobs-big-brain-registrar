import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  QMD_INDEX_DIR,
  getQmdIndexBasePath,
  getQmdTenantIndexPath,
  getQmdCollectionIndexPath,
  getQmdTenantEnv,
  DEFAULT_DENSE_URL,
  getDefaultDenseConfig,
} from '../config.js';

describe('qmd-adapter config', () => {
  const originalEnv = process.env['TEAMKB_BASE_PATH'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['TEAMKB_BASE_PATH'];
    } else {
      process.env['TEAMKB_BASE_PATH'] = originalEnv;
    }
  });

  it('exports QMD_INDEX_DIR', () => {
    expect(QMD_INDEX_DIR).toBe('qmd-index');
  });

  it('getQmdIndexBasePath uses default base', () => {
    delete process.env['TEAMKB_BASE_PATH'];
    expect(getQmdIndexBasePath()).toBe(join(homedir(), '.teamkb', 'qmd-index'));
  });

  it('getQmdTenantIndexPath includes tenant', () => {
    delete process.env['TEAMKB_BASE_PATH'];
    expect(getQmdTenantIndexPath('my-team')).toBe(
      join(homedir(), '.teamkb', 'qmd-index', 'my-team'),
    );
  });

  it('getQmdCollectionIndexPath includes tenant and collection', () => {
    delete process.env['TEAMKB_BASE_PATH'];
    expect(getQmdCollectionIndexPath('my-team', 'kb-curated')).toBe(
      join(homedir(), '.teamkb', 'qmd-index', 'my-team', 'kb-curated'),
    );
  });

  it('respects TEAMKB_BASE_PATH override', () => {
    process.env['TEAMKB_BASE_PATH'] = '/custom';
    expect(getQmdTenantIndexPath('t1')).toBe('/custom/qmd-index/t1');
  });

  it('getQmdTenantEnv points XDG dirs at the tenant index path', () => {
    process.env['TEAMKB_BASE_PATH'] = '/custom';
    expect(getQmdTenantEnv('t1')).toEqual({
      XDG_CONFIG_HOME: '/custom/qmd-index/t1/config',
      XDG_CACHE_HOME: '/custom/qmd-index/t1/cache',
    });
  });

  it('defaults production dense retrieval on at the pinned loopback endpoint', () => {
    expect(getDefaultDenseConfig({})).toEqual({ enabled: true, url: DEFAULT_DENSE_URL });
  });

  it('supports the documented emergency dense kill switch', () => {
    expect(getDefaultDenseConfig({ TEAMKB_DENSE_ENABLED: 'false' })).toEqual({
      enabled: false,
      url: DEFAULT_DENSE_URL,
    });
    expect(getDefaultDenseConfig({ TEAMKB_DENSE_ENABLED: '  OFF  ' }).enabled).toBe(false);
  });
});
