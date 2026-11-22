import type { SourceGovernanceContext } from './source-governance-schema.js';
import { classificationCanonicalJson, classificationHash } from './source-classification-codec.js';

/** Bind effective caller configuration, including compiled import matchers. */
export function sourceGovernanceConfigDigest(context: SourceGovernanceContext): string {
  const exclusions = context.curation?.importExclusions;
  return classificationHash(
    classificationCanonicalJson({
      originSecretDigest:
        context.originSecret === undefined ? null : classificationHash(context.originSecret),
      holdLimits: context.curation?.holdLimits ?? null,
      importExclusions:
        exclusions === undefined
          ? null
          : {
              overridePath: exclusions.overridePath,
              patterns: exclusions.patterns.map(({ regex, ...pattern }) => ({
                ...pattern,
                regexSource: regex.source,
                regexFlags: regex.flags,
              })),
            },
    }),
  );
}
