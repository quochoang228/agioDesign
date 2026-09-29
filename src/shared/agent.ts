/**
 * Provider-agnostic contract for the AI Agent feature. Everything here is plain
 * serialisable data so it can cross the UI ⇄ sandbox `postMessage` boundary and
 * be persisted in `figma.clientStorage`.
 *
 * Routes (see README "AI Agent"):
 *   - `api`  providers call a vendor HTTP endpoint directly from the UI iframe
 *            (bring-your-own-key, stored in clientStorage).
 *   - `cli`  providers call a local companion **bridge** over `http://localhost`
 *            which shells out to an installed CLI (claude / codex / opencode).
 */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'cli-claude'
  | 'cli-codex'
  | 'cli-opencode';

export type ProviderKind = 'api' | 'cli';

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  models: ProviderModel[];
  defaultModel: string;
  /** False = listed in the UI as a roadmap item but not yet wired up. */
  available: boolean;
}

/**
 * Provider catalogue shown in the UI. Only `available: true` entries are wired
 * up in this phase; the rest are placeholders for the staged rollout.
 */
export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Claude · Anthropic API',
    kind: 'api',
    available: true,
    defaultModel: 'claude-opus-4-8',
    models: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI · GPT',
    kind: 'api',
    available: true,
    defaultModel: 'gpt-5',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4o', label: 'GPT-4o' },
    ],
  },
  {
    id: 'google',
    label: 'Gemini · Google',
    kind: 'api',
    available: true,
    defaultModel: 'gemini-2.5-pro',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  {
    id: 'cli-claude',
    label: 'Claude CLI · local bridge',
    kind: 'cli',
    available: true,
    defaultModel: 'default',
    models: [
      { id: 'default', label: 'CLI default' },
      { id: 'opus', label: 'opus' },
      { id: 'sonnet', label: 'sonnet' },
      { id: 'haiku', label: 'haiku' },
    ],
  },
  {
    id: 'cli-codex',
    label: 'Codex CLI · local bridge',
    kind: 'cli',
    available: true,
    defaultModel: 'default',
    models: [{ id: 'default', label: 'CLI default' }],
  },
  {
    id: 'cli-opencode',
    label: 'opencode · local bridge',
    kind: 'cli',
    available: true,
    defaultModel: 'default',
    models: [{ id: 'default', label: 'CLI default' }],
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Image generation only runs on providers that support it. */
export type ImageProviderId = 'openai' | 'google';

export interface AgentSettings {
  provider: ProviderId;
  model: string;
  /** Vendor API keys for `api` providers, keyed by provider id. */
  apiKeys: Partial<Record<ProviderId, string>>;
  /** Base URL of the local companion bridge used by `cli` providers. */
  bridgeUrl: string;
  /** Which vendor generates images (Phase 6); reuses that vendor's API key. */
  imageProvider: ImageProviderId;
  imageModel: string;
}

export const DEFAULT_IMAGE_MODELS: Record<ImageProviderId, string> = {
  openai: 'gpt-image-1',
  google: 'gemini-2.5-flash-image',
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  apiKeys: {},
  bridgeUrl: 'http://localhost:3939',
  imageProvider: 'openai',
  imageModel: 'gpt-image-1',
};

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}
