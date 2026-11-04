import type { SecretPattern } from '../types.js';

// A preceding line contributes only when it ends as a label/assignment, not
// merely because an API keyword appears elsewhere in the document.
const LABEL_END =
  /(?:[:=]|\bset\s+to|\bis|\bwas|\b(?:key|token|secret|credential|bearer)|HEROKU_API_KEY)[\s`"']*$/i;

/** Source lines and cached context prefix counts keep per-match lookup bounded. */
export class SourceContext {
  private readonly starts = [0];
  private readonly ends: number[] = [];
  private readonly gates = new Map<SecretPattern, { counts: number[]; labels: boolean[] }>();

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

  allows(pattern: SecretPattern, start: number, end: number): boolean {
    const regex = pattern.requiresContext;
    if (!regex) return true;
    let gate = this.gates.get(pattern);
    if (!gate) {
      const counts = [0];
      const labels: boolean[] = [];
      for (let index = 0; index < this.starts.length; index++) {
        const line = this.content.slice(this.starts[index], this.ends[index]);
        regex.lastIndex = 0;
        const context = regex.test(line);
        counts.push(counts[index]! + Number(context));
        labels.push(context && LABEL_END.test(line));
      }
      gate = { counts, labels };
      this.gates.set(pattern, gate);
    }
    const first = this.lineAt(start);
    const last = this.lineAt(Math.max(start, end - 1));
    return gate.counts[last + 1]! > gate.counts[first]! || gate.labels[first - 1] === true;
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
