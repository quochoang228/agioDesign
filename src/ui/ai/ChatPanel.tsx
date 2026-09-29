import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSettings, ChatMessage, ImageProviderId, ProviderId } from '../../shared/agent';
import { DEFAULT_AGENT_SETTINGS, DEFAULT_IMAGE_MODELS, PROVIDERS, providerMeta } from '../../shared/agent';
import type { PluginToUiMessage, UiToPluginMessage } from '../../shared/types';
import { getProvider } from './providers';
import { buildSystemPrompt, extractHtml } from './prompt';
import { runAgent, type ToolOutcome } from './agent';
import { runCliMcpAgent } from './cliMcp';
import { generateImage } from './image';
import { webFetch, webSearch } from './webtools';

/** Design-mode prompt boosters shown as chips. */
const IDEATE_CHIPS = ['3 variations', 'Dark theme', 'Light theme', 'More minimal', 'More playful', 'Mobile layout'];

function send(msg: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

type Mode = 'design' | 'agent';
type Turn = ChatMessage & { id: number; streaming?: boolean; kind: Mode };

interface Props {
  /** Convert one HTML document into Figma layers; resolves to success. */
  importHtml: (html: string, name: string) => Promise<boolean>;
  /** Effective render width (px) chosen on the converter tabs. */
  width: number;
}

export function ChatPanel({ importHtml, width }: Props) {
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [mode, setMode] = useState<Mode>('design');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [generating, setGenerating] = useState(false);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nextId = useRef(1);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  // Pending tool calls awaiting a TOOL_RESULT from the sandbox.
  const pending = useRef(new Map<string, (r: ToolOutcome) => void>());
  const toolSeq = useRef(0);

  const meta = providerMeta(settings.provider);
  const hasKey =
    meta.kind === 'cli' ? !!settings.bridgeUrl && !!settings.bridgeToken : !!settings.apiKeys[settings.provider];

  // Load persisted agent settings, then handle settings + tool-result messages.
  useEffect(() => {
    send({ type: 'AGENT_GET_SETTINGS' });
    const onMessage = (event: MessageEvent) => {
      const msg = event.data.pluginMessage as PluginToUiMessage | undefined;
      if (msg?.type === 'AGENT_SETTINGS') {
        setSettings(msg.settings);
        loaded.current = true;
      } else if (msg?.type === 'TOOL_RESULT') {
        const resolve = pending.current.get(msg.id);
        if (resolve) {
          pending.current.delete(msg.id);
          resolve(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error });
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (loaded.current) send({ type: 'AGENT_SAVE_SETTINGS', settings });
  }, [settings]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns]);

  const patch = useCallback((updates: Partial<AgentSettings>) => {
    setSettings((s) => ({ ...s, ...updates }));
  }, []);

  const onPickProvider = useCallback((id: ProviderId) => {
    setSettings((s) => ({ ...s, provider: id, model: providerMeta(id).defaultModel }));
  }, []);

  const append = useCallback((id: number, delta: string) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, content: t.content + delta } : t)));
  }, []);

  // Run a tool in the sandbox and await its result.
  const sandboxTool = useCallback((name: string, args: unknown): Promise<ToolOutcome> => {
    return new Promise((resolve) => {
      const id = `t${toolSeq.current++}`;
      pending.current.set(id, resolve);
      send({ type: 'EXEC_TOOL', id, name, args });
      setTimeout(() => {
        if (pending.current.has(id)) {
          pending.current.delete(id);
          resolve({ ok: false, error: 'Tool timed out.' });
        }
      }, 60000);
    });
  }, []);

  // Tool dispatcher: UI tools (image gen, web) run here; the rest go to the sandbox.
  const execTool = useCallback(
    async (name: string, args: any): Promise<ToolOutcome> => {
      try {
        if (name === 'generate_image') {
          const img = await generateImage({
            provider: settings.imageProvider,
            model: settings.imageModel,
            apiKey: settings.apiKeys[settings.imageProvider],
            prompt: String(args?.prompt ?? ''),
            width: args?.width,
            height: args?.height,
            signal: abort.current?.signal,
          });
          return sandboxTool('place_image', {
            bytes: img.bytes,
            name: String(args?.prompt ?? 'image').slice(0, 40),
            targetId: args?.targetId,
            width: args?.width,
            height: args?.height,
          });
        }
        if (name === 'web_fetch') {
          const text = await webFetch(String(args?.url ?? ''), settings);
          return { ok: true, result: { text } };
        }
        if (name === 'web_search') {
          const result = await webSearch(String(args?.query ?? ''), settings);
          return { ok: true, result };
        }
        return sandboxTool(name, args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [settings, sandboxTool],
  );

  const onSend = useCallback(async () => {
    const text = input.trim();
    if (!text || generating) return;
    if (!meta.available) {
      setError(`${meta.label} is on the roadmap — pick another provider.`);
      return;
    }
    if (!hasKey) {
      setError(meta.kind === 'cli' ? 'Set the bridge URL and token in Settings.' : 'Add your API key in Settings first.');
      setShowSettings(true);
      return;
    }
    setError(null);
    setInput('');

    const userTurn: Turn = { id: nextId.current++, role: 'user', content: text, kind: mode };
    const botTurn: Turn = {
      id: nextId.current++,
      role: 'assistant',
      content: '',
      streaming: true,
      kind: mode,
    };
    const history = [...turns, userTurn];
    setTurns([...history, botTurn]);
    setGenerating(true);

    const controller = new AbortController();
    abort.current = controller;
    const provider = getProvider(settings.provider);
    const common = {
      apiKey: settings.apiKeys[settings.provider],
      bridgeUrl: settings.bridgeUrl,
      bridgeToken: settings.bridgeToken,
      model: settings.model,
      signal: controller.signal,
    };

    try {
      if (mode === 'agent') {
        const agentHistory = history.map(({ role, content }) => ({ role, content }));
        const onTool = (name: string, ok: boolean | null) =>
          append(botTurn.id, ok === null ? `\n🔧 ${name}…` : ok ? ' ✓' : ' ✗');
        if (settings.provider === 'cli-claude') {
          // Native MCP tool-calling: the CLI agent drives the canvas via the bridge.
          await runCliMcpAgent({
            bridgeUrl: settings.bridgeUrl,
            bridgeToken: settings.bridgeToken,
            cli: 'claude',
            model: settings.model,
            history: agentHistory,
            signal: controller.signal,
            onText: (delta) => append(botTurn.id, delta),
            onTool,
            execTool,
          });
        } else {
          // Text-protocol loop: works for API providers and other CLIs.
          await runAgent({
            provider,
            ...common,
            history: agentHistory,
            onText: (delta) => append(botTurn.id, delta),
            onTool,
            execTool,
          });
        }
      } else {
        await provider.generate({
          ...common,
          system: buildSystemPrompt(width),
          messages: history.map(({ role, content }) => ({ role, content })),
          onText: (delta) => append(botTurn.id, delta),
        });
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abort.current = null;
      setGenerating(false);
      setTurns((prev) => prev.map((t) => (t.id === botTurn.id ? { ...t, streaming: false } : t)));
    }
  }, [input, generating, meta, hasKey, mode, turns, settings, width, append, execTool]);

  const onImport = useCallback(
    async (turn: Turn) => {
      const html = extractHtml(turn.content);
      if (!html) {
        setError('That reply has no HTML to import.');
        return;
      }
      setImportingId(turn.id);
      setError(null);
      const ok = await importHtml(html, `AI · ${nameFromTurns(turns, turn.id)}`);
      setImportingId(null);
      if (!ok) setError('Import failed — see the notification.');
    },
    [importHtml, turns],
  );

  return (
    <div className="chat">
      <div className="chat-bar">
        <span className="chat-provider">{meta.label.split(' · ')[0]}</span>
        <span className="chat-model">{settings.model}</span>
        <div className="chat-mode" role="group" aria-label="Mode">
          <button className={mode === 'design' ? 'cm active' : 'cm'} onClick={() => setMode('design')}>
            Design
          </button>
          <button className={mode === 'agent' ? 'cm active' : 'cm'} onClick={() => setMode('agent')}>
            Agent
          </button>
        </div>
        <button className="chat-gear" title="Settings" onClick={() => setShowSettings((v) => !v)}>
          ⚙
        </button>
      </div>

      {showSettings && (
        <Settings settings={settings} onPickProvider={onPickProvider} patch={patch} onClose={() => setShowSettings(false)} />
      )}

      <div className="chat-log" ref={logRef}>
        {turns.length === 0 && (
          <div className="chat-empty">
            <strong>{mode === 'agent' ? 'Tell the agent what to do on the canvas.' : 'Describe a screen and it gets designed.'}</strong>
            <p>
              {mode === 'agent'
                ? 'e.g. “Auto-layout the selected frame and rename its children sensibly.”'
                : 'e.g. “A pricing page for a SaaS analytics tool, 3 tiers, dark theme.”'}
            </p>
            <p className="chat-empty-sub">
              <b>Design</b> generates a screen → Import to Figma. <b>Agent</b> edits the current page directly.
            </p>
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`bubble ${t.role}`}>
            {t.role === 'assistant' ? (
              <AssistantBubble turn={t} importing={importingId === t.id} onImport={() => onImport(t)} />
            ) : (
              <div className="bubble-text">{t.content}</div>
            )}
          </div>
        ))}
      </div>

      {error && <div className="chat-error">{error}</div>}

      {mode === 'design' && (
        <div className="chat-chips">
          {IDEATE_CHIPS.map((c) => (
            <button
              key={c}
              className="ideate-chip"
              onClick={() => setInput((v) => (v.trim() ? `${v.trim()} — ${c.toLowerCase()}` : c))}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="chat-composer">
        <textarea
          className="chat-input"
          placeholder={
            hasKey
              ? mode === 'agent'
                ? 'Tell the agent what to change…'
                : 'Describe the UI to design…'
              : 'Add an API key / bridge in ⚙ Settings…'
          }
          value={input}
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        {generating ? (
          <button className="secondary" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={onSend} disabled={!input.trim()}>
            {mode === 'agent' ? 'Run' : 'Generate'}
          </button>
        )}
      </div>
    </div>
  );
}

function AssistantBubble({
  turn,
  importing,
  onImport,
}: {
  turn: Turn;
  importing: boolean;
  onImport: () => void;
}) {
  const html = turn.kind === 'design' ? extractHtml(turn.content) : '';
  const ready = turn.kind === 'design' && !turn.streaming && html.length > 0;
  return (
    <>
      <div className="bubble-text">
        {turn.streaming && !turn.content ? <em>Working…</em> : turn.content}
      </div>
      {ready && (
        <button className="primary sm import-btn" onClick={onImport} disabled={importing}>
          {importing ? 'Importing…' : 'Import to Figma'}
        </button>
      )}
    </>
  );
}

function Settings({
  settings,
  onPickProvider,
  patch,
  onClose,
}: {
  settings: AgentSettings;
  onPickProvider: (id: ProviderId) => void;
  patch: (u: Partial<AgentSettings>) => void;
  onClose: () => void;
}) {
  const meta = providerMeta(settings.provider);
  return (
    <div className="chat-settings">
      <label className="cs-row">
        <span>Provider</span>
        <select
          className="select"
          value={settings.provider}
          onChange={(e) => onPickProvider(e.target.value as ProviderId)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.available}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <label className="cs-row">
        <span>Model</span>
        <input
          className="select cs-model"
          list="ai-model-list"
          value={settings.model}
          spellCheck={false}
          onChange={(e) => patch({ model: e.target.value })}
        />
        <datalist id="ai-model-list">
          {meta.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </datalist>
      </label>

      {meta.kind === 'api' && (
        <label className="cs-field">
          <span>{meta.label.split(' · ')[0]} API key</span>
          <input
            className="input"
            type="password"
            placeholder="sk-…"
            value={settings.apiKeys[settings.provider] ?? ''}
            onChange={(e) =>
              patch({ apiKeys: { ...settings.apiKeys, [settings.provider]: e.target.value } })
            }
          />
          <small className="hint">Stored locally in Figma clientStorage. Never leaves your machine except to the vendor API.</small>
        </label>
      )}

      <div className="cs-divider">Local bridge{meta.kind === 'api' && ' (web tools)'}</div>
      <label className="cs-field">
        <span>Bridge URL</span>
        <input
          className="input"
          type="text"
          value={settings.bridgeUrl}
          onChange={(e) => patch({ bridgeUrl: e.target.value })}
        />
      </label>
      <label className="cs-field">
        <span>Bridge token</span>
        <input
          className="input"
          type="password"
          placeholder="printed by the bridge on startup"
          value={settings.bridgeToken}
          onChange={(e) => patch({ bridgeToken: e.target.value.trim() })}
        />
        <small className="hint">
          Run <code>npm run bridge</code> in the plugin folder and paste the token it prints. It runs your installed CLI (reuses its auth) and powers web search/fetch.
        </small>
      </label>

      <div className="cs-divider">Image generation</div>
      <label className="cs-row">
        <span>Image by</span>
        <select
          className="select"
          value={settings.imageProvider}
          onChange={(e) => {
            const ip = e.target.value as ImageProviderId;
            patch({ imageProvider: ip, imageModel: DEFAULT_IMAGE_MODELS[ip] });
          }}
        >
          <option value="openai">OpenAI</option>
          <option value="google">Gemini</option>
        </select>
      </label>
      <label className="cs-row">
        <span>Image model</span>
        <input
          className="select cs-model"
          value={settings.imageModel}
          spellCheck={false}
          onChange={(e) => patch({ imageModel: e.target.value })}
        />
      </label>
      <label className="cs-field">
        <span>{settings.imageProvider === 'openai' ? 'OpenAI' : 'Gemini'} key (images)</span>
        <input
          className="input"
          type="password"
          placeholder="sk-…"
          value={settings.apiKeys[settings.imageProvider] ?? ''}
          onChange={(e) =>
            patch({ apiKeys: { ...settings.apiKeys, [settings.imageProvider]: e.target.value } })
          }
        />
        <small className="hint">Shared with the matching chat provider. Anthropic/CLI can't generate images — set an OpenAI or Gemini key here.</small>
      </label>

      <button className="secondary" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

/** Short label for an imported frame, derived from the user prompt that led to it. */
function nameFromTurns(turns: Turn[], assistantId: number): string {
  const idx = turns.findIndex((t) => t.id === assistantId);
  for (let i = idx - 1; i >= 0; i--) {
    if (turns[i].role === 'user') return turns[i].content.slice(0, 40);
  }
  return 'Generated';
}
