/**
 * Plugin sandbox entry point. Bridges UI messages to the Figma document:
 * receives a serialised LayerNode tree, preloads fonts, builds the nodes, and
 * reports progress back to the UI. Also persists user options via clientStorage.
 */
import type { UiToPluginMessage, PluginToUiMessage, ConvertOptions } from '../shared/types';
import { WINDOW_DEFAULT, clampWindow } from '../shared/types';
import type { AgentSettings } from '../shared/agent';
import { DEFAULT_AGENT_SETTINGS } from '../shared/agent';
import { preloadFonts, buildTree } from './builder';
import { executeTool } from './tools';

const SETTINGS_KEY = 'html-to-figma-pro:options';
const AGENT_KEY = 'html-to-figma-pro:agent';
const SIZE_KEY = 'html-to-figma-pro:window';

const DEFAULT_OPTIONS: ConvertOptions = {
  useAutoLayout: false,
  importImages: true,
  wrapInComponent: false,
  scale: 1,
  widthPreset: 'desktop',
  customWidth: 1280,
};

figma.showUI(__html__, { ...WINDOW_DEFAULT, themeColors: true });

// Restore the window size the user last dragged to.
figma.clientStorage
  .getAsync(SIZE_KEY)
  .then((saved: { width: number; height: number } | undefined) => {
    if (saved) {
      const { width, height } = clampWindow(saved.width, saved.height);
      figma.ui.resize(width, height);
    }
  })
  .catch(() => {});

// Placement cursor for tiling a multi-file batch left→right on the canvas.
const BATCH_GAP = 80;
let batchRoots: SceneNode[] = [];
let batchCursorX = 0;
let batchBaseY = 0;

function post(msg: PluginToUiMessage): void {
  figma.ui.postMessage(msg);
}

async function loadSettings(): Promise<ConvertOptions> {
  try {
    const saved = (await figma.clientStorage.getAsync(SETTINGS_KEY)) as ConvertOptions | undefined;
    return { ...DEFAULT_OPTIONS, ...(saved || {}) };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

figma.ui.onmessage = async (msg: UiToPluginMessage) => {
  switch (msg.type) {
    case 'GET_SETTINGS': {
      post({ type: 'SETTINGS', options: await loadSettings() });
      break;
    }

    case 'SAVE_SETTINGS': {
      await figma.clientStorage.setAsync(SETTINGS_KEY, msg.options);
      break;
    }

    case 'AGENT_GET_SETTINGS': {
      let settings = DEFAULT_AGENT_SETTINGS;
      try {
        const saved = (await figma.clientStorage.getAsync(AGENT_KEY)) as AgentSettings | undefined;
        if (saved) settings = { ...DEFAULT_AGENT_SETTINGS, ...saved };
      } catch {
        /* fall back to defaults */
      }
      post({ type: 'AGENT_SETTINGS', settings });
      break;
    }

    case 'AGENT_SAVE_SETTINGS': {
      await figma.clientStorage.setAsync(AGENT_KEY, msg.settings);
      break;
    }

    case 'EXEC_TOOL': {
      const r = await executeTool(msg.name, msg.args);
      post(
        r.ok
          ? { type: 'TOOL_RESULT', id: msg.id, ok: true, result: r.result }
          : { type: 'TOOL_RESULT', id: msg.id, ok: false, error: r.error },
      );
      break;
    }

    case 'RESIZE': {
      const size = clampWindow(msg.width, msg.height);
      figma.ui.resize(size.width, size.height);
      if (msg.save) await figma.clientStorage.setAsync(SIZE_KEY, size);
      break;
    }

    case 'NOTIFY': {
      figma.notify(msg.message, { error: msg.error });
      break;
    }

    case 'CANCEL': {
      figma.closePlugin();
      break;
    }

    case 'IMPORT': {
      try {
        figma.notify('Loading fonts…', { timeout: 1000 });
        const fonts = await preloadFonts(msg.tree);

        // Rough node count for the progress bar.
        let total = 0;
        const count = (n: typeof msg.tree) => {
          total++;
          if (n.type === 'FRAME') n.children.forEach(count);
        };
        count(msg.tree);

        let lastSent = 0;
        const { root, count: built } = await buildTree(msg.tree, msg.options, fonts, (done) => {
          // Throttle progress posts to keep the bridge responsive.
          if (done - lastSent >= 5 || done === total) {
            lastSent = done;
            post({ type: 'PROGRESS', done, total });
          }
        });

        root.name = msg.sourceName || root.name;

        // Tile multi-file batches left→right; a single import lands centred.
        const idx = msg.batchIndex ?? 0;
        const batchTotal = msg.batchTotal ?? 1;
        if (idx === 0) {
          batchRoots = [];
          batchCursorX = Math.round(figma.viewport.center.x - root.width / 2);
          batchBaseY = Math.round(figma.viewport.center.y - root.height / 2);
        }
        root.x = batchCursorX;
        root.y = batchBaseY;
        batchCursorX += Math.round(root.width) + BATCH_GAP;
        batchRoots.push(root);

        if (idx === batchTotal - 1) {
          figma.currentPage.selection = batchRoots;
          figma.viewport.scrollAndZoomIntoView(batchRoots);
          batchRoots = [];
        }
        post({ type: 'DONE', nodeCount: built });
        figma.notify(`Imported ${built} layers ✓`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        post({ type: 'ERROR', message });
        figma.notify(`Import failed: ${message}`, { error: true });
      }
      break;
    }
  }
};
