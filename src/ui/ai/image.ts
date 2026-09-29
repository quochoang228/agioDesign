/**
 * Image generation (Phase 6). Calls OpenAI Images or Gemini image-out directly
 * from the UI iframe and returns raw PNG bytes for the sandbox to place via
 * `figma.createImage`.
 */
import type { ImageProviderId } from '../../shared/agent';

export interface ImageResult {
  bytes: number[];
  mime: string;
}

function b64ToBytes(b64: string): number[] {
  const bin = atob(b64);
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface GenerateImageOpts {
  provider: ImageProviderId;
  model: string;
  apiKey?: string;
  prompt: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
}

export async function generateImage(o: GenerateImageOpts): Promise<ImageResult> {
  if (!o.apiKey) {
    throw new Error(`Add your ${o.provider === 'openai' ? 'OpenAI' : 'Gemini'} key (image section) in Settings.`);
  }
  if (!o.prompt) throw new Error('generate_image needs a prompt.');

  if (o.provider === 'openai') {
    const w = o.width || 1024;
    const h = o.height || 1024;
    const size = w > h ? '1536x1024' : h > w ? '1024x1536' : '1024x1024';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      signal: o.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({ model: o.model || 'gpt-image-1', prompt: o.prompt, size, n: 1 }),
    });
    if (!res.ok) throw new Error(`OpenAI images ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI returned no image.');
    return { bytes: b64ToBytes(b64), mime: 'image/png' };
  }

  const model = o.model || 'gemini-2.5-flash-image';
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(o.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    signal: o.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: o.prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini image ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  const inline = parts.map((p) => p.inlineData || p.inline_data).find(Boolean);
  if (!inline?.data) throw new Error('Gemini returned no image.');
  return { bytes: b64ToBytes(inline.data), mime: inline.mimeType || inline.mime_type || 'image/png' };
}
