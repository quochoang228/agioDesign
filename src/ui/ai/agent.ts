/**
 * Agent loop (Phase 4). Drives any `Provider` through a text-based tool protocol:
 * the model emits ```tool blocks, we execute them in the sandbox and feed the
 * results back, looping until the model stops calling tools. Because it only
 * needs text in/out, the exact same loop works for every API provider and the
 * CLI bridge — no per-vendor function-calling format required.
 */
import type { ChatMessage } from '../../shared/agent';
import type { Provider } from './provider';
import { buildAgentSystemPrompt, parseToolCalls } from './tools';

export type ToolOutcome = { ok: boolean; result?: unknown; error?: string };

export interface RunAgentParams {
  provider: Provider;
  model: string;
  apiKey?: string;
  bridgeUrl?: string;
  /** Conversation including the latest user message. */
  history: ChatMessage[];
  signal?: AbortSignal;
  /** Assistant text deltas (streamed per turn). */
  onText: (delta: string) => void;
  /** Tool lifecycle: `ok === null` = started; true/false = finished. */
  onTool: (name: string, ok: boolean | null) => void;
  /** Execute a tool in the sandbox and resolve with its result. */
  execTool: (name: string, args: unknown) => Promise<ToolOutcome>;
  /** Max tool-calling rounds before bailing out. */
  maxRounds?: number;
}

function formatResults(results: { tool: string; outcome: ToolOutcome }[]): string {
  const lines = results.map((r, i) => {
    const payload = r.outcome.ok
      ? { ok: true, result: r.outcome.result }
      : { ok: false, error: r.outcome.error };
    return `${i + 1}. ${r.tool} → ${JSON.stringify(payload).slice(0, 2000)}`;
  });
  return `Tool results:\n${lines.join('\n')}\n\nContinue if more actions are needed, otherwise reply with a brief final summary and no tool block.`;
}

export async function runAgent(p: RunAgentParams): Promise<void> {
  const system = buildAgentSystemPrompt();
  const messages: ChatMessage[] = [...p.history];
  const rounds = p.maxRounds ?? 8;

  for (let i = 0; i < rounds; i++) {
    if (p.signal?.aborted) return;

    const text = await p.provider.generate({
      model: p.model,
      system,
      messages,
      apiKey: p.apiKey,
      bridgeUrl: p.bridgeUrl,
      signal: p.signal,
      onText: p.onText,
    });

    messages.push({ role: 'assistant', content: text });
    const calls = parseToolCalls(text);
    if (!calls.length) return; // final answer — no tools requested

    const results: { tool: string; outcome: ToolOutcome }[] = [];
    for (const c of calls) {
      if (p.signal?.aborted) return;
      p.onTool(c.tool, null);
      let outcome: ToolOutcome;
      try {
        outcome = await p.execTool(c.tool, c.args);
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      p.onTool(c.tool, outcome.ok);
      results.push({ tool: c.tool, outcome });
    }
    messages.push({ role: 'user', content: formatResults(results) });
  }

  p.onText('\n\n_(Reached the action limit — stopping.)_');
}
