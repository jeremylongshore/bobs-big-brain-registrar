import { describe, it, expect } from 'vitest';
import {
  scanDisclosure,
  scanDisclosureFields,
  type DisclosureViolation,
} from '../services/disclosure-filter.js';

const PII: DisclosureViolation = { category: 'pii' };
const COMP: DisclosureViolation = { category: 'compensation' };

describe('scanDisclosure — PII (hard-fail)', () => {
  it.each([
    ['an SSN in SSN format', 'employee record 123-45-6789 on file'],
    ['the literal token SSN', 'her SSN is stored elsewhere'],
    ['social security number', 'collect the social security number at onboarding'],
    ['social security no', 'social security no required'],
    ['a background-check result', 'background-check passed for this hire'],
    ['a background check report', 'see the background check report attached'],
    ['date of birth', 'date of birth recorded in HR'],
    ['DOB with a separator', 'DOB: 1990-01-01'],
  ])('flags %s as pii', (_label, text) => {
    expect(scanDisclosure(text)).toEqual(PII);
  });
});

describe('scanDisclosure — unambiguous compensation (hard-fail)', () => {
  it.each([
    ['salary', 'his base salary was disclosed'],
    ['base pay', 'base pay for the role'],
    ['take-home pay', 'take-home pay after tax'],
    ['launch bonus', 'a launch bonus was promised'],
    ['signing bonus', 'signing bonus on offer'],
    ['equity grant', 'equity grant vests over time'],
    ['equity stake', 'a 2% equity stake'],
    ['vesting', 'a 4-year vesting schedule'],
    ['RSUs', 'paid in RSUs'],
    ['stock options', 'granted stock options'],
    ['revenue-share with a number', 'revenue-share 50 of net'],
    ['the 7-bucket framework', 'allocate per the 7-bucket framework'],
  ])('flags %s as compensation', (_label, text) => {
    expect(scanDisclosure(text)).toEqual(COMP);
  });
});

describe('scanDisclosure — numeric ratio-split is context-gated', () => {
  it('flags a ratio-split alongside a compensation keyword', () => {
    expect(scanDisclosure('the revenue is a 60/40 split with the partner')).toEqual(COMP);
    expect(scanDisclosure('his comp: 70/30 split')).toEqual(COMP);
  });

  it('does NOT flag a bare ratio-split in technical context', () => {
    expect(scanDisclosure('we route a 60/40 traffic split between regions')).toBeNull();
    expect(scanDisclosure('70/30 canary split for the rollout')).toBeNull();
  });
});

describe('scanDisclosure — clean content (no false positives)', () => {
  it.each([
    ['investing (not vesting)', 'we are investing in better tests'],
    ['harvesting (not vesting)', 'harvesting logs from the cluster'],
    ['client revenue / deal value is allowed', 'the deal value is $50k for this client'],
    ['a pricing menu is allowed', 'see the pricing menu for tiers'],
    ['a semver-looking string', 'upgraded to version 1.2.3'],
    ['ordinary technical content', 'always return Result types from the kernel'],
    ['empty string', ''],
    ['whitespace only', '   \n\t'],
  ])('passes %s', (_label, text) => {
    expect(scanDisclosure(text)).toBeNull();
  });
});

describe('scanDisclosureFields', () => {
  it('returns null when every field is clean', () => {
    expect(scanDisclosureFields(['clean title', 'clean body', 'tag-a'])).toBeNull();
  });

  it('returns the violation when any field is dirty', () => {
    expect(scanDisclosureFields(['clean title', 'his base salary', 'tag'])).toEqual(COMP);
  });

  it('catches PII that appears only in a later field (e.g. a tag)', () => {
    expect(scanDisclosureFields(['clean', 'clean', 'DOB: 2000-02-02'])).toEqual(PII);
  });

  it('returns the FIRST violating field’s category (PII before later comp)', () => {
    // first field is PII, second is comp → first wins
    expect(scanDisclosureFields(['her SSN', 'base salary'])).toEqual(PII);
  });

  it('returns null for an empty field list', () => {
    expect(scanDisclosureFields([])).toBeNull();
  });
});
