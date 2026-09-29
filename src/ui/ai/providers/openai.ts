/**
 * OpenAI provider — Chat Completions API, called directly from the UI iframe
 * (bring-your-own-key). Streaming SSE; deltas arrive on
 * `choices[0].delta.content`. The system prompt is prepended as a system role.
 */
import type { Provider, GenerateParams } from '../provider';
import { readSse } from '../sse';

const API_URL = 'https://api.openai.com/v1/chat/completions';

export const openaiProvider: Provider = {
  async generate({ apiKey, model, system, messages, onText, signal }: GenerateParams) {
    if (!apiKey) throw new Error('Add your OpenAI API key in Settings first.');

    const res = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: system },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
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
      throw new Error(`OpenAI API ${res.status}: ${detail.slice(0, 400)}`);
    }

    let full = '';
    let streamError: string | null = null;
    await readSse(
      res.body,
      (evt: any) => {
        const delta = evt?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          full += delta;
          onText(delta);
        } else if (evt?.error) {
          streamError = evt.error?.message || 'stream error';
        }
      },
      signal,
    );
    if (streamError) throw new Error(`OpenAI stream: ${streamError}`);
    return full;
  },
};
