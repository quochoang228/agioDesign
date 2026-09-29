/**
 * Unified streaming interface every backend implements — vendor HTTP APIs today,
 * the local CLI bridge later. The UI only talks to this shape, so swapping the
 * selected provider never touches the chat code.
 */
import type { ChatMessage } from '../../shared/agent';

export interface GenerateParams {
  model: string;
  system: string;
  messages: ChatMessage[];
  /** API key for `api` providers (from clientStorage). */
  apiKey?: string;
  /** Bridge base URL for `cli` providers. */
  bridgeUrl?: string;
  /** Auth token for the local bridge (printed by `bridge/server.mjs`). */
  bridgeToken?: string;
  /** Streamed text deltas, in order. */
  onText: (delta: string) => void;
  signal?: AbortSignal;
}

export interface Provider {
  /** Run one completion, streaming via `onText`, and resolve with the full text. */
  generate(params: GenerateParams): Promise<string>;
}
