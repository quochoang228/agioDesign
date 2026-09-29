/**
 * CLI bridge provider — talks to the local companion server (`bridge/server.mjs`)
 * over http://localhost, which runs an installed CLI (claude / codex / opencode)
 * and streams stdout back as SSE (`{text}` chunks, `{error}`, then `[DONE]`).
 * Reuses the CLI's own auth, so no API key lives in the plugin.
 */
import type { Provider, GenerateParams } from '../provider';
import { readSse } from '../sse';
import { bridgeFetch } from '../bridgeClient';

/** One provider per CLI; `cli` is sent in the body so the bridge picks the binary. */
export function makeBridgeProvider(cli: 'claude' | 'codex' | 'opencode'): Provider {
  return {
    async generate({ bridgeUrl, bridgeToken, model, system, messages, onText, signal }: GenerateParams) {
      const res = await bridgeFetch({ bridgeUrl, bridgeToken }, '/generate', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cli, model, system, messages }),
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Bridge ${res.status}: ${detail.slice(0, 300)}`);
      }

      let full = '';
      let streamError: string | null = null;
      await readSse(
        res.body,
        (evt: any) => {
          if (typeof evt?.text === 'string') {
            full += evt.text;
            onText(evt.text);
          } else if (evt?.error) {
            streamError = evt.error;
          }
        },
        signal,
      );
      if (streamError) throw new Error(`Bridge: ${streamError}`);
      return full;
    },
  };
}
