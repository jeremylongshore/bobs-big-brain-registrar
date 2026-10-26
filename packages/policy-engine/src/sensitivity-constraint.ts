import { Sensitivity } from '@qmd-team-intent-kb/schema';

const RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** A reviewed floor can only increase the classifier's sensitivity. */
export function effectiveSensitivity(classified: Sensitivity, minimum?: Sensitivity): Sensitivity {
  Sensitivity.parse(classified);
  if (minimum === undefined) return classified;
  Sensitivity.parse(minimum);
  return RANK[minimum] > RANK[classified] ? minimum : classified;
}
