import type { SecretPattern } from '../types.js';

// A preceding line contributes only when it ends as a label/assignment, not
// merely because an API keyword appears elsewhere in the document.
const LABEL_END =
  /(?:[:=]|\bset\s+to|\bis|\bwas|\b(?:key|token|secret|credential|bearer)|HEROKU_API_KEY)[\s`"']*$/i;
// A heading such as `API guide:` or an `API_REQUEST_ID=` assignment is
// not a credential label merely because the broad same-line gate sees `api`.
const CREDENTIAL_LABEL =
  /(?:^|[^a-z0-9])(?:api[-_ ]?key|key|token|secret|credential|bearer|password)(?:[^a-z0-9]|$)/i;
// Only the tail can be an immediately preceding label. Keep its broad legacy
// context regex away from arbitrarily long unrelated identifier prefixes.
const LABEL_CONTEXT_MAX_CODE_UNITS = 256;

/** Indexed source lines with lazy per-line gates avoid scanning unrelated text. */
export class SourceContext {
  private readonly starts = [0];
  private readonly ends: number[] = [];
  private readonly gates = new Map<
    SecretPattern,
    Map<number, { context?: boolean; label?: boolean }>
  >();

  constructor(private readonly content: string) {
    for (const match of content.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) {
      this.ends.push(match.index);
      this.starts.push(match.index + match[0].length);
    }
    this.ends.push(content.length);
  }

  private lineAt(offset: number): number {
    let low = 0;
    let high = this.starts.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.starts[mid]! <= offset) low = mid;
      else high = mid;
    }
    return low;
  }

  locate(offset: number): { line: number; column: number } {
    const line = this.lineAt(offset);
    return { line: line + 1, column: offset - this.starts[line]! + 1 };
  }

  private state(pattern: SecretPattern, line: number): { context?: boolean; label?: boolean } {
    let lines = this.gates.get(pattern);
    if (!lines) {
      lines = new Map();
      this.gates.set(pattern, lines);
    }
    let state = lines.get(line);
    if (!state) {
      state = {};
      lines.set(line, state);
    }
    return state;
  }

  private hasContext(pattern: SecretPattern, line: number): boolean {
    const state = this.state(pattern, line);
    if (state.context === undefined) {
      const regex = pattern.requiresContext;
      if (!regex) return true;
      regex.lastIndex = 0;
      state.context = regex.test(this.content.slice(this.starts[line], this.ends[line]));
    }
    return state.context;
  }

  private isLabel(pattern: SecretPattern, line: number): boolean {
    if (line < 0) return false;
    const state = this.state(pattern, line);
    if (state.label === undefined) {
      const start = Math.max(this.starts[line]!, this.ends[line]! - LABEL_CONTEXT_MAX_CODE_UNITS);
      // Carry one original left-boundary character: clipping `monkey:` to
      // `key:` must not invent a credential keyword at the start of the view.
      // A non-keyword word guard also prevents the carried character itself
      // becoming a new keyword start. Custom context gates see only real text.
      const clipped = start > this.starts[line]!;
      const contextText = this.content.slice(clipped ? start - 1 : start, this.ends[line]);
      const labelText = clipped ? '0' + contextText : contextText;
      // Test the specific label shape BEFORE the broad legacy context regex.
      // An unrelated long identifier must not trigger that regex merely
      // because a UUID occurs on a later line.
      const regex = pattern.requiresContext!;
      regex.lastIndex = 0;
      state.label =
        CREDENTIAL_LABEL.test(labelText) && LABEL_END.test(contextText) && regex.test(contextText);
    }
    return state.label;
  }

  allows(pattern: SecretPattern, start: number, end: number): boolean {
    if (!pattern.requiresContext) return true;
    const first = this.lineAt(start);
    const last = this.lineAt(Math.max(start, end - 1));
    for (let line = first; line <= last; line++) {
      if (this.hasContext(pattern, line)) return true;
    }
    return this.isLabel(pattern, first - 1);
  }
}

/** Same derived whitespace views as the scanner, retaining UTF-16 source offsets. */
export function mappedWhitespace(
  content: string,
  keepSpace: boolean,
): { text: string; offsets: number[] } {
  const characters: string[] = [];
  const offsets: number[] = [];
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!;
    if (/\s/.test(character)) {
      if (keepSpace) {
        characters.push(' ');
        offsets.push(index);
      }
      while (index + 1 < content.length && /\s/.test(content[index + 1]!)) index++;
    } else {
      characters.push(character);
      offsets.push(index);
    }
  }
  return { text: characters.join(''), offsets };
}
