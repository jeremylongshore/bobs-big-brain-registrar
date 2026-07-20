/**
 * OPTIONAL offline LLM judge for the groundedness fixture — a COMPARISON ARM
 * ONLY, never a gate (Wave-2 C2).
 *
 * ## Hard boundaries (the platform's no-LLM-in-gating rule)
 *
 *   - OFF in CI: `judgeFromEnv` returns `null` unless BOTH
 *     `GROUNDEDNESS_LLM_JUDGE=minimax` and `MINIMAX_API_KEY` are set —
 *     neither is ever configured in any workflow. Nothing in
 *     `evaluateGroundedness`, the CI script, or any test imports this
 *     module's network path.
 *   - NEVER gates: the judge's verdicts are printed side by side with
 *     scorer v1's for a human to compare (scripts/groundedness-judge-compare.ts,
 *     run by hand). Disagreement is information about the deterministic
 *     scorer's blind spots, not a pass/fail signal.
 *
 * The judge speaks the OpenAI-compatible chat-completions shape against the
 * MiniMax API (base URL overridable via MINIMAX_BASE_URL).
 */

import type { GroundednessItem, GroundednessLabel } from './types.js';

export interface GroundednessJudge {
  readonly name: string;
  judge(item: GroundednessItem): Promise<GroundednessLabel>;
}

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_MODEL = 'MiniMax-Text-01';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Build the judge from the environment, or `null` when not opted in.
 * CI never sets these variables, so in CI this is always `null`.
 */
export function judgeFromEnv(
  env: Record<string, string | undefined> = process.env,
): GroundednessJudge | null {
  if (env['GROUNDEDNESS_LLM_JUDGE'] !== 'minimax') return null;
  const apiKey = env['MINIMAX_API_KEY'];
  if (apiKey === undefined || apiKey === '') return null;

  const baseUrl = env['MINIMAX_BASE_URL'] ?? DEFAULT_BASE_URL;
  const model = env['MINIMAX_MODEL'] ?? DEFAULT_MODEL;

  return {
    name: `minimax:${model}`,
    async judge(item: GroundednessItem): Promise<GroundednessLabel> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You judge whether a MEMORY excerpt supports a CLAIM. ' +
                'Answer with exactly one word: SUPPORTED if the memory states or ' +
                'directly entails the claim, UNSUPPORTED otherwise (wrong numbers, ' +
                'swapped roles, flipped polarity, or material the memory never states).',
            },
            {
              role: 'user',
              content: `MEMORY:\n${item.memoryExcerpt}\n\nCLAIM:\n${item.claim}\n\nAnswer:`,
            },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`LLM judge HTTP ${response.status}`);
      }
      const body = (await response.json()) as ChatCompletionResponse;
      const text = body.choices?.[0]?.message?.content ?? '';
      return /unsupported/i.test(text) ? 'unsupported' : 'supported';
    },
  };
}
