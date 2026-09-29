import type { ProviderId } from '../../../shared/agent';
import type { Provider } from '../provider';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import { googleProvider } from './google';
import { makeBridgeProvider } from './bridge';

/** Resolve the streaming backend for a provider id. */
export function getProvider(id: ProviderId): Provider {
  switch (id) {
    case 'anthropic':
      return anthropicProvider;
    case 'openai':
      return openaiProvider;
    case 'google':
      return googleProvider;
    case 'cli-claude':
      return makeBridgeProvider('claude');
    case 'cli-codex':
      return makeBridgeProvider('codex');
    case 'cli-opencode':
      return makeBridgeProvider('opencode');
    default:
      throw new Error(`Provider "${id}" isn't wired up yet — it's on the roadmap.`);
  }
}
