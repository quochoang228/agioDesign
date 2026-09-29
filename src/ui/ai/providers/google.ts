/**
 * Google Gemini provider — Generative Language REST API, called directly from
 * the UI iframe (bring-your-own-key, passed as the `?key=` query param).
 * Streaming SSE via `:streamGenerateContent?alt=sse`; text deltas live in
 * `candidates[0].content.parts[].text`. Gemini uses roles `user` / `model`.
 */
import type { Provider, GenerateParams } from '../provider';
import { readSse } from '../sse';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export const googleProvider: Provider = {
  async generate({ apiKey, model, system, messages, onText, signal }: GenerateParams) {
    if (!apiKey) throw new Error('Add your Gemini API key in Settings first.');

    const url =
      `${BASE}/${encodeURIComponent(model)}:streamGenerateContent` +
      `?alt=sse&key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: 32768 },
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
      throw new Error(`Gemini API ${res.status}: ${detail.slice(0, 400)}`);
    }

    let full = '';
    let streamError: string | null = null;
    await readSse(
      res.body,
      (evt: any) => {
        const parts = evt?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (typeof p?.text === 'string' && p.text) {
              full += p.text;
              onText(p.text);
            }
          }
        }
        if (evt?.error) streamError = evt.error?.message || 'stream error';
      },
      signal,
    );
    if (streamError) throw new Error(`Gemini stream: ${streamError}`);
    return full;
  },
};
