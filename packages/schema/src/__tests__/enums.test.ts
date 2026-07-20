import { describe, it, expect } from 'vitest';
import {
  MemorySource,
  TrustLevel,
  MemoryCategory,
  MemoryLifecycleState,
  CandidateStatus,
  SearchScope,
  PolicyRuleType,
  PolicyRuleAction,
  AuditAction,
  Confidence,
  Sensitivity,
  AuthorType,
  LinkType,
  LinkSource,
  ImportBatchStatus,
} from '../enums.js';

describe('MemorySource', () => {
  it.each(['claude_session', 'manual', 'import', 'mcp'])('accepts "%s"', (val) => {
    expect(MemorySource.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => MemorySource.parse('unknown')).toThrow();
  });
});

describe('TrustLevel', () => {
  it.each(['high', 'medium', 'low', 'untrusted'])('accepts "%s"', (val) => {
    expect(TrustLevel.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => TrustLevel.parse('super_high')).toThrow();
  });
});

describe('MemoryCategory', () => {
  const categories = [
    'decision',
    'pattern',
    'convention',
    'architecture',
    'troubleshooting',
    'onboarding',
    'reference',
  ];
  it.each(categories)('accepts "%s"', (val) => {
    expect(MemoryCategory.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => MemoryCategory.parse('other')).toThrow();
  });
});

describe('MemoryLifecycleState', () => {
  it.each(['active', 'deprecated', 'superseded', 'archived'])('accepts "%s"', (val) => {
    expect(MemoryLifecycleState.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => MemoryLifecycleState.parse('draft')).toThrow();
  });
});

describe('CandidateStatus', () => {
  it('accepts "inbox"', () => {
    expect(CandidateStatus.parse('inbox')).toBe('inbox');
  });
  it('rejects anything else', () => {
    expect(() => CandidateStatus.parse('review')).toThrow();
  });
});

describe('SearchScope', () => {
  it.each(['curated', 'all', 'inbox', 'archived', 'bulk'])('accepts "%s"', (val) => {
    expect(SearchScope.parse(val)).toBe(val);
  });
  it('defaults to "curated"', () => {
    expect(SearchScope.parse(undefined)).toBe('curated');
  });
  it('rejects invalid value', () => {
    expect(() => SearchScope.parse('private')).toThrow();
  });
});

describe('PolicyRuleType', () => {
  const types = [
    'secret_detection',
    'dedup_check',
    'relevance_score',
    'content_length',
    'source_trust',
    'tenant_match',
    'sensitivity_gate',
    'content_sanitization',
    'contradiction_check',
  ];
  it.each(types)('accepts "%s"', (val) => {
    expect(PolicyRuleType.parse(val)).toBe(val);
  });

  // Membership lock-step guard: the accept-list above IS the full enum. If a
  // member is added to the Zod enum without extending this list (or vice versa)
  // this fails, forcing the same-PR update discipline the 5bm.1 DDL lock-step
  // test enforces for the curated_memories column enums. (PolicyRuleType itself
  // has NO DDL CHECK — rules live in governance_policies.rules_json — so this
  // test is its only membership gate.)
  it('the accept-list covers the entire enum (no untested members)', () => {
    expect([...types].sort()).toEqual([...PolicyRuleType.options].sort());
  });
  it('rejects invalid value', () => {
    expect(() => PolicyRuleType.parse('custom')).toThrow();
  });

  it('accepts sensitivity_gate as PolicyRuleType', () => {
    expect(PolicyRuleType.parse('sensitivity_gate')).toBe('sensitivity_gate');
  });

  it('accepts content_sanitization as PolicyRuleType', () => {
    expect(PolicyRuleType.parse('content_sanitization')).toBe('content_sanitization');
  });

  it('accepts contradiction_check as PolicyRuleType (E1)', () => {
    expect(PolicyRuleType.parse('contradiction_check')).toBe('contradiction_check');
  });
});

describe('PolicyRuleAction', () => {
  it.each(['reject', 'flag', 'approve', 'require_review'])('accepts "%s"', (val) => {
    expect(PolicyRuleAction.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => PolicyRuleAction.parse('ignore')).toThrow();
  });
});

describe('AuditAction', () => {
  const actions = [
    'promoted',
    'demoted',
    'superseded',
    'archived',
    'deleted',
    'searched',
    'exported',
    'eval-result',
    'proposed',
    'recategorized',
    'governed',
    'policy_upgraded',
  ];
  it.each(actions)('accepts "%s"', (val) => {
    expect(AuditAction.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => AuditAction.parse('created')).toThrow();
  });
});

describe('Confidence', () => {
  it.each(['high', 'medium', 'low'])('accepts "%s"', (val) => {
    expect(Confidence.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => Confidence.parse('very_high')).toThrow();
  });
});

describe('Sensitivity', () => {
  it.each(['public', 'internal', 'confidential', 'restricted'])('accepts "%s"', (val) => {
    expect(Sensitivity.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => Sensitivity.parse('top_secret')).toThrow();
  });
});

describe('AuthorType', () => {
  it.each(['human', 'ai', 'system'])('accepts "%s"', (val) => {
    expect(AuthorType.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => AuthorType.parse('bot')).toThrow();
  });
});

describe('LinkType', () => {
  it.each(['relates_to', 'supersedes', 'contradicts', 'depends_on', 'part_of'])(
    'accepts "%s"',
    (val) => {
      expect(LinkType.parse(val)).toBe(val);
    },
  );
  it('rejects invalid value', () => {
    expect(() => LinkType.parse('follows')).toThrow();
  });
});

describe('LinkSource', () => {
  it.each(['curator', 'import', 'manual', 'mcp'])('accepts "%s"', (val) => {
    expect(LinkSource.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => LinkSource.parse('api')).toThrow();
  });
});

describe('ImportBatchStatus', () => {
  it.each(['active', 'completed', 'rolled_back'])('accepts "%s"', (val) => {
    expect(ImportBatchStatus.parse(val)).toBe(val);
  });
  it('rejects invalid value', () => {
    expect(() => ImportBatchStatus.parse('pending')).toThrow();
  });
});
