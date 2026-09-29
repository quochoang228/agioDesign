/**
 * Claude (Anthropic Messages API) provider — called directly from the plugin's
 * UI iframe. Browser CORS is enabled with `anthropic-dangerous-direct-browser-
 * access`; the user's key lives in Figma clientStorage (bring-your-own-key).
 *
 * Streaming SSE: we accumulate `content_block_delta` / `text_delta` events.
 * Thinking is left off so the model returns design markup directly (faster,
 * and the output is meant to be machine-parsed into Figma layers).
 */
import type { Provider, GenerateParams } from '../provider';
import { readSse } from '../sse';

const API_URL = 'https://api.anthropic.com/v1/messages';

export const anthropicProvider: Provider = {
  async generate({ apiKey, model, system, messages, onText, signal }: GenerateParams) {
    if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');

    const res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 64000,
        stream: true,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok || !res.body) {
      let detail = '';
      try {
        const err = await res.json();
        detail = err?.error?.message || JSON.stringify(err);
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 400)}`);
    }

    let full = '';
    let streamError: string | null = null;
    await readSse(
      res.body,
      (evt: any) => {
        if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          full += evt.delta.text;
          onText(evt.delta.text);
        } else if (evt?.type === 'error') {
          streamError = evt.error?.message || 'stream error';
        }
      },
      signal,
    );
    if (streamError) throw new Error(`Anthropic stream: ${streamError}`);
    return full;
  },
};
