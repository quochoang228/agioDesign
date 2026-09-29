/**
 * CLI + MCP agent run (Phase 5). Lets a CLI agent (claude) drive the Figma
 * canvas through native MCP tool-calling instead of the text protocol.
 *
 * The plugin holds two SSE channels to the bridge for one session:
 *   - /mcp/events : receives tool-call requests → run in sandbox → POST /mcp/result
 *   - /run-agent  : streams the CLI's text output into the chat bubble
 */
import type { ChatMessage } from '../../shared/agent';
import type { ToolOutcome } from './agent';
import { readSse } from './sse';
import { bridgeFetch, type BridgeConn } from './bridgeClient';

export interface RunCliMcpParams extends BridgeConn {
  cli: 'claude';
  model: string;
  history: ChatMessage[];
  signal?: AbortSignal;
  onText: (delta: string) => void;
  onTool: (name: string, ok: boolean | null) => void;
  execTool: (name: string, args: unknown) => Promise<ToolOutcome>;
}

function buildTask(history: ChatMessage[]): string {
  const convo = history
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`)
    .join('\n\n');
  return `You are editing the user's current Figma page. You have Figma tools available via the MCP server "figma": get_selection, get_page_summary, get_design_system, rename_nodes, set_auto_layout, align_nodes, set_fill, set_text. Inspect with get_selection / get_page_summary before editing; never invent node ids. Complete the task, then give a one-line summary.\n\n--- Conversation ---\n${convo}`;
}

function newSessionId(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export async function runCliMcpAgent(p: RunCliMcpParams): Promise<void> {
  const session = newSessionId();

  const eventsCtrl = new AbortController();
  const onAbort = () => eventsCtrl.abort();
  p.signal?.addEventListener('abort', onAbort);

  // 1) Tool-relay channel: bridge pushes tool calls; we run them and post results.
  let eventsRes: Response;
  try {
    eventsRes = await bridgeFetch(p, `/mcp/events?session=${encodeURIComponent(session)}`, {
      signal: eventsCtrl.signal,
    });
  } catch (e) {
    p.signal?.removeEventListener('abort', onAbort);
    throw e;
  }
  if (!eventsRes.ok || !eventsRes.body) {
    p.signal?.removeEventListener('abort', onAbort);
    throw new Error(`Bridge events ${eventsRes.status}`);
  }

  const pump = readSse(
    eventsRes.body,
    (evt: any) => {
      if (!evt || typeof evt.callId !== 'string') return;
      p.onTool(evt.name, null);
      void (async () => {
        let out: ToolOutcome;
        try {
          out = await p.execTool(evt.name, evt.args);
        } catch (e) {
          out = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        p.onTool(evt.name, out.ok);
        bridgeFetch(p, '/mcp/result', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, callId: evt.callId, ...out }),
        }).catch(() => {});
      })();
    },
    eventsCtrl.signal,
  ).catch(() => {});

  // 2) Run the CLI agent and stream its text.
  try {
    const runRes = await bridgeFetch(p, '/run-agent', {
      method: 'POST',
      signal: p.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session, cli: p.cli, model: p.model, task: buildTask(p.history) }),
    });
    if (!runRes.ok || !runRes.body) throw new Error(`Bridge run-agent ${runRes.status}`);

    let streamError: string | null = null;
    await readSse(
      runRes.body,
      (evt: any) => {
        if (typeof evt?.text === 'string') p.onText(evt.text);
        else if (evt?.error) streamError = evt.error;
      },
      p.signal,
    );
    if (streamError) throw new Error(`Bridge: ${streamError}`);
  } finally {
    eventsCtrl.abort();
    p.signal?.removeEventListener('abort', onAbort);
    await pump.catch(() => {});
  }
}
