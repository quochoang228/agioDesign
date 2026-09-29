/**
 * Claude (Anthropic Messages API) provider — called directly from the plugin's
 * UI iframe. Browser CORS is enabled with `anthropic-dangerous-direct-browser-
 * access`; the user's key lives in Figma clientStorage (bring-your-own-key).
 *
 * Streaming SSE: we accumulate `content_block_delta` / `text_delta` events.
 * `thinking` is omitted, so each model uses its default (adaptive on Opus 5.5 /
 * Fable 5.1 / Sonnet 5.5, off on Haiku 4.5); thinking blocks are ignored and
 * only the text — the machine-parsed design markup — is returned.
 */
import type { Provider, GenerateParams } from '../provider';
import { readSse } from '../sse';

const API_URL = 'https://api.anthropic.com/v1/messages';

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export const anthropicProvider: Provider = {
  async generate({ apiKey, model, system, messages, onText, signal }: GenerateParams) {
    if (!apiKey) throw new Error('Add your Anthropic API key in Settings first.');

    // On a safety-classifier decline, let the API re-run the request on a
    // fallback model instead of returning an empty reply.
    const fallback = FALLBACK_MODELS.has(model);
    const res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 64000,
        stream: true,
        system,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        ...(fallback ? { fallbacks: 'default' } : {}),
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
    let refusal: string | null = null;
    await readSse(
      res.body,
      (evt: any) => {
        if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          full += evt.delta.text;
          onText(evt.delta.text);
        } else if (evt?.type === 'message_delta' && evt.delta?.stop_reason === 'refusal') {
          const d = evt.delta.stop_details;
          refusal = d?.explanation || d?.category || 'declined by safety classifier';
        } else if (evt?.type === 'error') {
          streamError = evt.error?.message || 'stream error';
        }
      },
      signal,
    );
    if (streamError) throw new Error(`Anthropic stream: ${streamError}`);
    if (refusal) throw new Error(`Claude declined this request (${refusal}). Try rephrasing it.`);
    return full;
  },
};
