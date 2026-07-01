import { describe, it, expect } from 'vitest';
import { classifyContent } from '../secrets/content-classifier.js';

describe('classifyContent', () => {
  it('returns public with no matches for clean content', () => {
    const result = classifyContent('Use dependency injection for all services in the codebase.');
    expect(result.sensitivityLevel).toBe('public');
    expect(result.matchedPatterns).toHaveLength(0);
    expect(result.hasPii).toBe(false);
    expect(result.hasCredentials).toBe(false);
    expect(result.hasInternalPaths).toBe(false);
  });

  it('returns restricted and hasCredentials=true for content with AWS key', () => {
    const result = classifyContent('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
    expect(result.sensitivityLevel).toBe('restricted');
    expect(result.hasCredentials).toBe(true);
    expect(result.matchedPatterns).toContain('aws-key');
  });

  it('returns confidential and hasPii=true for content with email address', () => {
    const result = classifyContent('Contact the team lead at alice@example.com for onboarding.');
    expect(result.sensitivityLevel).toBe('confidential');
    expect(result.hasPii).toBe(true);
    expect(result.matchedPatterns).toContain('email-address');
  });

  it('returns confidential and hasPii=true for content with SSN pattern', () => {
    const result = classifyContent('Employee SSN on file: 123-45-6789');
    expect(result.sensitivityLevel).toBe('confidential');
    expect(result.hasPii).toBe(true);
    expect(result.matchedPatterns).toContain('ssn-like');
  });

  it('returns confidential and hasPii=true for content with US phone number', () => {
    const result = classifyContent('Call the support line at (555) 867-5309 for assistance.');
    expect(result.sensitivityLevel).toBe('confidential');
    expect(result.hasPii).toBe(true);
    expect(result.matchedPatterns).toContain('us-phone');
  });

  it('returns internal and hasInternalPaths=true for /home/user/ path', () => {
    const result = classifyContent('Config file located at /home/alice/config/settings.json');
    expect(result.sensitivityLevel).toBe('internal');
    expect(result.hasInternalPaths).toBe(true);
    expect(result.matchedPatterns).toContain('internal-path');
  });

  it('returns internal and hasInternalPaths=true for /Users/admin/ path', () => {
    const result = classifyContent('Run the script from /Users/admin/docs/setup.sh');
    expect(result.sensitivityLevel).toBe('internal');
    expect(result.hasInternalPaths).toBe(true);
    expect(result.matchedPatterns).toContain('internal-path');
  });

  it('returns internal and hasInternalPaths=true for Windows C:\\ path', () => {
    const result = classifyContent('Binary is installed at C:\\Program Files\\MyApp\\app.exe');
    expect(result.sensitivityLevel).toBe('internal');
    expect(result.hasInternalPaths).toBe(true);
    expect(result.matchedPatterns).toContain('internal-path');
  });

  it('credentials override PII — both present yields restricted', () => {
    const result = classifyContent(
      'Contact bob@example.com and use key AKIAIOSFODNN7EXAMPLE to authenticate.',
    );
    expect(result.sensitivityLevel).toBe('restricted');
    expect(result.hasCredentials).toBe(true);
    expect(result.hasPii).toBe(true);
  });

  it('PII overrides internal paths — both present yields confidential', () => {
    const result = classifyContent(
      'Alice (alice@example.com) keeps configs at /home/alice/projects/',
    );
    expect(result.sensitivityLevel).toBe('confidential');
    expect(result.hasPii).toBe(true);
    expect(result.hasInternalPaths).toBe(true);
  });

  // --- Part 2: PII vocabulary convergence (bead compile-then-govern-e06.15) ---
  // classifyContent's PII set now matches the repository-boundary filter, so a
  // DOB-only / background-check / SSN-keyword leak is classified confidential
  // pre-boundary (before this fix these passed the classifier and the policy
  // pipeline that gates on it, caught only at the write choke point).
  it('returns confidential and hasPii=true for a DOB-only disclosure (converged vocab)', () => {
    const result = classifyContent('HR note — DOB: 1984-07-02, hired last spring.');
    expect(result.sensitivityLevel).toBe('confidential');
    expect(result.hasPii).toBe(true);
    expect(result.matchedPatterns).toContain('date-of-birth');
  });

  it('returns confidential for an SSN referenced by keyword (no digits)', () => {
    const result = classifyContent('Collect the applicant SSN during onboarding.');
    expect(result.sensitivityLevel).toBe('confidential');
    expect(result.hasPii).toBe(true);
    expect(result.matchedPatterns).toContain('ssn-keyword');
  });

  it('returns confidential for a background-check disclosure', () => {
    const result = classifyContent('The background-check report came back clean.');
    expect(result.sensitivityLevel).toBe('confidential');
    expect(result.hasPii).toBe(true);
    expect(result.matchedPatterns).toContain('background-check');
  });

  // --- Part 1: UUID-in-prose no longer over-classified (precision guard) ------
  // The heroku-api-key rule is UUID-shaped; before the context gate a UUID in
  // prose was classified `restricted` (a credential). Now it stays `public`.
  it('classifies a UUID in ordinary prose as public (heroku context gate)', () => {
    const result = classifyContent('The request id was 3f2504e0-4f89-41d3-9a0c-0305e82c3301.');
    expect(result.sensitivityLevel).toBe('public');
    expect(result.hasCredentials).toBe(false);
    expect(result.matchedPatterns).toHaveLength(0);
  });

  it('still classifies a real Heroku key in key-context as restricted (recall held)', () => {
    const result = classifyContent('HEROKU_API_KEY=3f2504e0-4f89-41d3-9a0c-0305e82c3301');
    expect(result.sensitivityLevel).toBe('restricted');
    expect(result.hasCredentials).toBe(true);
    expect(result.matchedPatterns).toContain('heroku-api-key');
  });
});
