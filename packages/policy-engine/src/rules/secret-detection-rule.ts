import type { MemoryCandidate, PolicyRule } from '@qmd-team-intent-kb/schema';
import { scanTextForSecrets } from '../secret-scan.js';
import type { EvaluationContext, RuleResult } from '../types.js';

/**
 * Rule evaluator that scans candidate content for secrets using the shared
 * governance secret scan. Any detected pattern causes a 'fail' outcome; clean
 * content passes.
 *
 * The failure reason names each pattern and the line(s) it fired on — never the
 * matched text. The reason is persisted in the rejection audit trail, so
 * echoing the value there would re-leak the secret the rule just stopped.
 */
export function evaluateSecretDetection(
  candidate: MemoryCandidate,
  rule: PolicyRule,
  _context: EvaluationContext,
): RuleResult {
  const findings = scanTextForSecrets(candidate.content);

  if (findings.length === 0) {
    return {
      ruleId: rule.id,
      ruleType: rule.type,
      outcome: 'pass',
      reason: 'No secrets detected in content',
    };
  }

  const patternIds = findings.map((f) => f.patternId).join(', ');
  const patternNames = [...new Set(findings.map((f) => f.patternName))].join(', ');
  const locations = findings.map((f) => `${f.patternId} at line ${f.lines.join(', ')}`).join('; ');

  return {
    ruleId: rule.id,
    ruleType: rule.type,
    outcome: 'fail',
    reason: `Secrets detected — patterns matched: ${patternNames} (ids: ${patternIds}; locations: ${locations})`,
  };
}
