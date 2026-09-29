/**
 * Minimal Server-Sent-Events reader for streaming LLM responses. Each provider
 * decodes the per-event JSON itself via `onEvent`; this only handles the wire
 * framing (`data:` lines, multi-line buffering, `[DONE]`).
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (json: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line; data lines start with "data:".
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // keep-alives / partial frames
        }
        onEvent(parsed);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
