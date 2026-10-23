/** Only fixed categories reach reports; raw errors can contain private paths. */
export function classifyDenseFailure(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : '';
  switch (message) {
    case 'dense arm unavailable after construction':
      return 'construction-unavailable';
    case 'dense index is empty or unbuilt':
      return 'unbuilt-or-empty';
    case 'query vector dimension does not match dense index':
      return 'dimension-mismatch';
    default:
      return 'query-failure';
  }
}
