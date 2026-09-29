/**
 * Bottom-right drag handle that resizes the plugin window (Figma plugin windows
 * have no native resize). Drag to resize within WINDOW_MIN…WINDOW_MAX; the size
 * is saved when the drag ends. Double-click resets to the default size.
 */
import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { UiToPluginMessage } from '../shared/types';
import { WINDOW_DEFAULT, clampWindow } from '../shared/types';
import { IconGrip } from './icons';

function send(msg: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

export function ResizeGrip() {
  const drag = useRef<{ x: number; y: number; w: number; h: number; last?: { width: number; height: number } } | null>(null);
  const frame = useRef(0);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // screenX/Y stay stable while the iframe itself changes size underneath us.
    drag.current = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const size = clampWindow(d.w + e.screenX - d.x, d.h + e.screenY - d.y);
    d.last = size;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => send({ type: 'RESIZE', ...size }));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (d?.last) {
      cancelAnimationFrame(frame.current);
      send({ type: 'RESIZE', ...d.last, save: true });
    }
  };

  return (
    <div
      className="resize-grip"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => send({ type: 'RESIZE', ...WINDOW_DEFAULT, save: true })}
    >
      <IconGrip />
    </div>
  );
}
