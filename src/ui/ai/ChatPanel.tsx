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
import { useBridge, type BridgeApi, type BridgeStatus } from './useBridge';
import { BridgeBadge, BridgePanel } from './BridgePanel';
import {
  IconBack,
  IconCheck,
  IconChevron,
  IconClose,
  IconCode,
  IconSend,
  IconSettings,
  IconSparkle,
  IconStop,
  IconTool,
  IconUpload,
} from '../icons';

/** Design-mode prompt boosters shown as chips. */
const IDEATE_CHIPS = ['3 variations', 'Dark theme', 'Light theme', 'More minimal', 'More playful', 'Mobile layout'];

const EXAMPLES: Record<Mode, string[]> = {
  design: [
    'A pricing page for a SaaS analytics tool, 3 tiers, dark theme',
    'Mobile onboarding screen for a meditation app',
    'Settings page with sidebar navigation',
  ],
  agent: [
    'Auto-layout the selected frame and rename its children sensibly',
    'Align the selected layers to the left and space them evenly',
    'List the colour styles in this file',
  ],
};

function send(msg: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

type Mode = 'design' | 'agent';
/** Rendered pieces of an assistant turn, in arrival order. */
type Part = { type: 'text'; text: string } | { type: 'tool'; name: string; ok: boolean | null };
type Turn = ChatMessage & { id: number; streaming?: boolean; kind: Mode; parts: Part[] };

interface Props {
  /** Convert one HTML document into Figma layers; resolves to success. */
  importHtml: (html: string, name: string) => Promise<boolean>;
  /** Effective render width (px) chosen on the converter tabs. */
  width: number;
}

const BRIDGE_BLOCKED: Partial<Record<BridgeStatus, string>> = {
  offline: 'The local bridge isn’t running — open Settings to install it.',
  unpaired: 'Connect the plugin to the local bridge first (Settings → Connect).',
  off: 'The local bridge is turned off — turn it on in Settings.',
};

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loaded = useRef(false);
  // Pending tool calls awaiting a TOOL_RESULT from the sandbox.
  const pending = useRef(new Map<string, (r: ToolOutcome) => void>());
  const toolSeq = useRef(0);

  const meta = providerMeta(settings.provider);
  const usesBridge = meta.kind === 'cli';
  const hasKey = usesBridge ? !!settings.bridgeUrl && !!settings.bridgeToken : !!settings.apiKeys[settings.provider];

  const patch = useCallback((updates: Partial<AgentSettings>) => {
    setSettings((s) => ({ ...s, ...updates }));
  }, []);
  const onBridgeToken = useCallback((bridgeToken: string) => patch({ bridgeToken }), [patch]);
  const bridge = useBridge({ bridgeUrl: settings.bridgeUrl, bridgeToken: settings.bridgeToken }, onBridgeToken);

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

  // Grow the composer with its content (up to a cap set in CSS).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const onPickProvider = useCallback((id: ProviderId) => {
    setSettings((s) => ({ ...s, provider: id, model: providerMeta(id).defaultModel }));
  }, []);

  const updateTurn = useCallback((id: number, fn: (t: Turn) => Turn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  const append = useCallback(
    (id: number, delta: string) =>
      updateTurn(id, (t) => {
        const last = t.parts[t.parts.length - 1];
        const parts: Part[] =
          last?.type === 'text'
            ? [...t.parts.slice(0, -1), { type: 'text', text: last.text + delta }]
            : [...t.parts, { type: 'text', text: delta }];
        return { ...t, content: t.content + delta, parts };
      }),
    [updateTurn],
  );

  const onToolEvent = useCallback(
    (id: number, name: string, ok: boolean | null) =>
      updateTurn(id, (t) => {
        if (ok === null) return { ...t, parts: [...t.parts, { type: 'tool', name, ok: null }] };
        // Resolve the most recent still-running call of this tool.
        const parts = [...t.parts];
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.type === 'tool' && p.name === name && p.ok === null) {
            parts[i] = { ...p, ok };
            break;
          }
        }
        return { ...t, parts };
      }),
    [updateTurn],
  );

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
    const blocked = usesBridge ? BRIDGE_BLOCKED[bridge.state.status] : undefined;
    if (blocked || !hasKey) {
      setError(
        blocked ??
          `“${meta.label}” needs an API key — add it in Settings, or pick a “CLI · local bridge” provider to use the bridge.`,
      );
      setShowSettings(true);
      return;
    }
    setError(null);
    setInput('');

    const userTurn: Turn = { id: nextId.current++, role: 'user', content: text, kind: mode, parts: [] };
    const botTurn: Turn = { id: nextId.current++, role: 'assistant', content: '', streaming: true, kind: mode, parts: [] };
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
    const onText = (delta: string) => append(botTurn.id, delta);

    try {
      if (mode === 'agent') {
        const agentHistory = history.map(({ role, content }) => ({ role, content }));
        const onTool = (name: string, ok: boolean | null) => onToolEvent(botTurn.id, name, ok);
        if (settings.provider === 'cli-claude') {
          // Native MCP tool-calling: the CLI agent drives the canvas via the bridge.
          await runCliMcpAgent({
            bridgeUrl: settings.bridgeUrl,
            bridgeToken: settings.bridgeToken,
            cli: 'claude',
            model: settings.model,
            history: agentHistory,
            signal: controller.signal,
            onText,
            onTool,
            execTool,
          });
        } else {
          // Text-protocol loop: works for API providers and other CLIs.
          await runAgent({ provider, ...common, history: agentHistory, onText, onTool, execTool });
        }
      } else {
        await provider.generate({
          ...common,
          system: buildSystemPrompt(width),
          messages: history.map(({ role, content }) => ({ role, content })),
          onText,
        });
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abort.current = null;
      setGenerating(false);
      updateTurn(botTurn.id, (t) => ({ ...t, streaming: false }));
    }
  }, [input, generating, meta, usesBridge, bridge.state.status, hasKey, mode, turns, settings, width, append, onToolEvent, updateTurn, execTool]);

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

  const bridgeBlocked = usesBridge ? BRIDGE_BLOCKED[bridge.state.status] : undefined;

  return (
    <div className="chat">
      <div className="toolbar">
        <button className="model-pill" onClick={() => setShowSettings(true)} title="Change model">
          <span className="model-provider">{meta.label.split(' · ')[0]}</span>
          <span className="model-id">{settings.model}</span>
          <IconChevron />
        </button>
        {usesBridge && <BridgeBadge status={bridge.state.status} onClick={() => setShowSettings(true)} />}
        <span className="spacer" />
        <div className="seg seg-sm" role="group" aria-label="Mode">
          {(['design', 'agent'] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? 'seg-btn active' : 'seg-btn'} onClick={() => setMode(m)}>
              {m === 'design' ? 'Design' : 'Agent'}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
          <IconSettings />
        </button>
      </div>

      <div className="chat-log" ref={logRef}>
        {turns.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">
              <IconSparkle />
            </span>
            <strong>{mode === 'agent' ? 'Edit the current page with AI' : 'Describe a screen to design'}</strong>
            <p>
              {mode === 'agent'
                ? 'The agent can inspect, rename, align, restyle and auto-layout layers.'
                : 'You get a generated design you can import as editable layers.'}
            </p>
            <div className="examples">
              {EXAMPLES[mode].map((ex) => (
                <button key={ex} className="example" onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t) =>
            t.role === 'user' ? (
              <div key={t.id} className="msg user">
                <div className="msg-bubble">{t.content}</div>
              </div>
            ) : (
              <div key={t.id} className="msg assistant">
                {t.kind === 'design' ? (
                  <DesignReply turn={t} importing={importingId === t.id} onImport={() => onImport(t)} />
                ) : (
                  <AgentReply turn={t} />
                )}
              </div>
            ),
          )
        )}
      </div>

      {bridgeBlocked && !error && (
        <button className="banner" onClick={() => setShowSettings(true)}>
          {bridgeBlocked}
        </button>
      )}
      {error && (
        <div className="alert">
          <span>{error}</span>
          <button className="icon-btn sm" title="Dismiss" onClick={() => setError(null)}>
            <IconClose />
          </button>
        </div>
      )}

      <div className="composer">
        {mode === 'design' && (
          <div className="chips">
            {IDEATE_CHIPS.map((c) => (
              <button
                key={c}
                className="chip"
                onClick={() => setInput((v) => (v.trim() ? `${v.trim()} — ${c.toLowerCase()}` : c))}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <div className="composer-box">
          <textarea
            ref={inputRef}
            className="composer-input"
            placeholder={mode === 'agent' ? 'Tell the agent what to change…' : 'Describe the UI to design…'}
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          {generating ? (
            <button className="send-btn stop" title="Stop" onClick={() => abort.current?.abort()}>
              <IconStop />
            </button>
          ) : (
            <button className="send-btn" title="Send (⌘/Ctrl + Enter)" onClick={onSend} disabled={!input.trim()}>
              <IconSend />
            </button>
          )}
        </div>
      </div>

      {showSettings && (
        <SettingsSheet
          settings={settings}
          bridge={bridge}
          onPickProvider={onPickProvider}
          patch={patch}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

/** Design-mode reply: the generated HTML collapses into a card with an Import action. */
function DesignReply({ turn, importing, onImport }: { turn: Turn; importing: boolean; onImport: () => void }) {
  const [showCode, setShowCode] = useState(false);
  const html = extractHtml(turn.content);
  const lines = turn.content ? turn.content.split('\n').length : 0;

  if (turn.streaming) {
    return (
      <div className="gen-card working">
        <span className="spinner" />
        <div className="gen-meta">
          <strong>{lines ? 'Generating design…' : 'Thinking…'}</strong>
          {lines > 0 && <small>{lines} lines so far</small>}
        </div>
      </div>
    );
  }
  if (!html) return <div className="msg-text">{turn.content || <em>No reply.</em>}</div>;

  return (
    <div className="gen-card">
      <div className="gen-row">
        <span className="gen-icon">
          <IconCode />
        </span>
        <div className="gen-meta">
          <strong>Generated design</strong>
          <small>
            {html.split('\n').length} lines · {(html.length / 1024).toFixed(1)} KB
          </small>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowCode((v) => !v)}>
          {showCode ? 'Hide code' : 'Code'}
        </button>
        <button className="btn btn-primary btn-sm" onClick={onImport} disabled={importing}>
          <IconUpload />
          {importing ? 'Importing…' : 'Import'}
        </button>
      </div>
      {showCode && <pre className="code-view">{html}</pre>}
    </div>
  );
}

/** Agent-mode reply: prose interleaved with tool-call rows; raw ```tool blocks are hidden. */
function AgentReply({ turn }: { turn: Turn }) {
  const visible = turn.parts
    .map((p) => (p.type === 'text' ? { ...p, text: p.text.replace(/```(?:tool|json)[\s\S]*?(```|$)/g, '').trim() } : p))
    .filter((p) => p.type === 'tool' || p.text);
  if (!visible.length) {
    return turn.streaming ? (
      <div className="thinking">
        <span className="spinner" /> Working…
      </div>
    ) : (
      <div className="msg-text">
        <em>No reply.</em>
      </div>
    );
  }
  return (
    <div className="agent-reply">
      {visible.map((p, i) =>
        p.type === 'tool' ? (
          <div key={i} className={`tool-row ${p.ok === null ? 'running' : p.ok ? 'ok' : 'fail'}`}>
            {p.ok === null ? <span className="spinner sm" /> : p.ok ? <IconCheck /> : <IconClose />}
            <IconTool />
            <code>{p.name}</code>
          </div>
        ) : (
          <div key={i} className="msg-text">
            {p.text}
          </div>
        ),
      )}
      {turn.streaming && visible[visible.length - 1]?.type === 'text' && <span className="caret" />}
    </div>
  );
}

function SettingsSheet({
  settings,
  bridge,
  onPickProvider,
  patch,
  onClose,
}: {
  settings: AgentSettings;
  bridge: BridgeApi;
  onPickProvider: (id: ProviderId) => void;
  patch: (u: Partial<AgentSettings>) => void;
  onClose: () => void;
}) {
  const meta = providerMeta(settings.provider);
  const imageLabel = settings.imageProvider === 'openai' ? 'OpenAI' : 'Gemini';
  return (
    <div className="sheet">
      <header className="sheet-head">
        <button className="icon-btn" onClick={onClose} title="Back">
          <IconBack />
        </button>
        <strong>AI settings</strong>
      </header>

      <div className="sheet-body">
        <section className="section">
          <h3>Model</h3>
          <label className="field">
            <span>Provider</span>
            <select className="input" value={settings.provider} onChange={(e) => onPickProvider(e.target.value as ProviderId)}>
              <optgroup label="API · bring your own key">
                {PROVIDERS.filter((p) => p.kind === 'api').map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="CLI · via local bridge (no key)">
                {PROVIDERS.filter((p) => p.kind === 'cli').map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label className="field">
            <span>Model</span>
            <input
              className="input mono"
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
            <label className="field">
              <span>{meta.label.split(' · ')[0]} API key</span>
              <input
                className="input"
                type="password"
                placeholder="Paste your key"
                value={settings.apiKeys[settings.provider] ?? ''}
                onChange={(e) => patch({ apiKeys: { ...settings.apiKeys, [settings.provider]: e.target.value } })}
              />
              <small className="hint">Stored in Figma on this computer; only sent to the vendor’s API.</small>
            </label>
          )}
        </section>

        <section className="section">
          <h3>Local bridge</h3>
          <p className="hint">
            Runs AI CLIs installed on your computer (no API key) and powers web search.
            {meta.kind === 'api' && ' Optional for API providers.'}
          </p>
          <BridgePanel
            bridge={bridge}
            url={settings.bridgeUrl}
            token={settings.bridgeToken}
            onChange={(u) => patch(u)}
          />
        </section>

        <section className="section">
          <h3>Image generation</h3>
          <div className="field-row">
            <label className="field">
              <span>Provider</span>
              <select
                className="input"
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
            <label className="field">
              <span>Model</span>
              <input
                className="input mono"
                value={settings.imageModel}
                spellCheck={false}
                onChange={(e) => patch({ imageModel: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>{imageLabel} API key</span>
            <input
              className="input"
              type="password"
              placeholder="Paste your key"
              value={settings.apiKeys[settings.imageProvider] ?? ''}
              onChange={(e) => patch({ apiKeys: { ...settings.apiKeys, [settings.imageProvider]: e.target.value } })}
            />
            <small className="hint">Shared with the {imageLabel} chat provider. Claude and CLIs can’t generate images.</small>
          </label>
        </section>
      </div>
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
