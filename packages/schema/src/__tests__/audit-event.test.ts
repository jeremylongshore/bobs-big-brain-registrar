import { describe, it, expect } from 'vitest';
import { AuditEvent } from '../audit-event.js';
import { makeAuditEvent } from './fixtures.js';

describe('AuditEvent', () => {
  it('parses a valid event', () => {
    const result = AuditEvent.parse(makeAuditEvent());
    expect(result.action).toBe('promoted');
    expect(result.tenantId).toBe('team-alpha');
  });

  it('accepts all audit actions', () => {
    const actions = [
      'promoted',
      'demoted',
      'superseded',
      'archived',
      'deleted',
      'searched',
      'exported',
      'proposed',
    ] as const;
    for (const action of actions) {
      const result = AuditEvent.parse(makeAuditEvent({ action }));
      expect(result.action).toBe(action);
    }
  });

  it('defaults details to empty object', () => {
    const { details: _removed, ...input } = makeAuditEvent();
    const result = AuditEvent.parse(input);
    expect(result.details).toEqual({});
  });

  it('accepts optional reason', () => {
    const { reason: _removed, ...input } = makeAuditEvent();
    const result = AuditEvent.parse(input);
    expect(result.reason).toBeUndefined();
  });

  it('preserves custom details', () => {
    const result = AuditEvent.parse(
      makeAuditEvent({
        details: { previousState: 'active', newState: 'deprecated', policyId: 'p-123' },
      }),
    );
    expect(result.details).toEqual({
      previousState: 'active',
      newState: 'deprecated',
      policyId: 'p-123',
    });
  });

  it('rejects missing action', () => {
    const { action: _removed, ...input } = makeAuditEvent();
    expect(() => AuditEvent.parse(input)).toThrow();
  });

  it('rejects missing memoryId', () => {
    const { memoryId: _removed, ...input } = makeAuditEvent();
    expect(() => AuditEvent.parse(input)).toThrow();
  });

  it('rejects missing tenantId', () => {
    const { tenantId: _removed, ...input } = makeAuditEvent();
    expect(() => AuditEvent.parse(input)).toThrow();
  });

  it('rejects missing actor', () => {
    const { actor: _removed, ...input } = makeAuditEvent();
    expect(() => AuditEvent.parse(input)).toThrow();
  });

  it('rejects invalid action', () => {
    expect(() => AuditEvent.parse(makeAuditEvent({ action: 'created' as 'promoted' }))).toThrow();
  });

  it('rejects invalid memoryId', () => {
    expect(() => AuditEvent.parse(makeAuditEvent({ memoryId: 'not-uuid' }))).toThrow();
  });

  it('rejects invalid timestamp', () => {
    expect(() => AuditEvent.parse(makeAuditEvent({ timestamp: 'not-a-date' }))).toThrow();
  });
});
