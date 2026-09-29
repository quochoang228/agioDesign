# HTML to Figma **Pro**

An upgraded rewrite of the classic [html-to-figma DEV-plugin](https://www.figma.com/community/plugin/1005496056687344906)
(demo for [sergcen/html-to-figma](https://github.com/sergcen/html-to-figma)).

Convert raw **HTML/CSS** or a **live website** into fully editable Figma layers —
rebuilt in **TypeScript + React** with a modern UI and a faster, more faithful
conversion engine.

## What's new vs. the original

| | Original demo | **Pro** |
|---|---|---|
| Stack | Vanilla JS | **TypeScript + React 18** |
| Input | Paste HTML | Paste HTML, **import from URL**, **pick/drag multiple local files** (each tiled into its own frame) |
| Layout | Absolute frames | **CSS flex → Figma Auto Layout**, **z-index stacking order** |
| Styling | Basic fills/text | Fills, gradients, **per-side borders**, box-shadows, corner radii, text decoration/case |
| Images | — | `<img>` **+ CSS `background-image`** fetched & embedded, **`object-fit`/`background-size`** → scale mode |
| Text | Approximate box | **Per-text-node measurement** (`Range`) for accurate position & wrapping |
| SVG | — | **Inline `<svg>` → vectors**; dashed/gradient/filter/mask SVG **rasterised** for pixel-perfect fidelity |
| Fonts | Crashes on missing | **Safe fallback chain** (weight/italic aware) |
| UX | One button | Tabs, options, **live progress**, persisted settings, **light/dark theme** |
| Output | Raw frames | Optional **component wrap**, scale (0.5×/1×/2×) |

## AI Agent (new)

A fourth tab, **AI Agent**, turns a prompt into editable Figma layers: the model
(Claude, GPT, Gemini, or a local CLI) generates a self-contained HTML document,
which is fed straight into the same converter pipeline as the other tabs. Its
**Agent** mode edits the current page directly through Figma tools.

- **Bring-your-own-key.** Open ⚙ Settings, pick a provider/model, paste your API
  key. The key is persisted in `figma.clientStorage` (never bundled, never sent
  anywhere except the vendor API).
- **Provider abstraction.** All backends implement one streaming `Provider`
  interface (`src/ui/ai/provider.ts`), so the chat UI is provider-agnostic.
- **Default model:** `claude-opus-5-5` (also Fable 5.1 / Sonnet 5.5 / Haiku 4.5).
  Calls the Anthropic Messages API directly from the UI iframe via the
  documented browser-access header, streaming the reply. On the 5.x models a
  safety-classifier decline is retried server-side on a fallback model
  (`fallbacks: "default"`); a final refusal surfaces as a readable error.
- Each assistant reply gets an **Import to Figma** button that runs
  `htmlToLayerTree` at the currently-selected render width.

### Roadmap (staged rollout toward a full design agent)

1. ✅ **Phase 1** — AI chat + Claude (Anthropic API), generate HTML → import.
2. ✅ **Phase 2** — OpenAI (Chat Completions) + Gemini (Generative Language)
   behind the same `Provider` interface; model field is an editable combobox so
   you can type any model id your key has access to.
3. ✅ **Phase 3** — **Local CLI bridge** (`bridge/server.mjs`, zero-dep): a
   companion Node server on `localhost` that shells out to installed CLIs
   (`claude`, `codex`, `opencode`) — reuses their existing auth, no API key
   needed. Run `npm run bridge`, paste the **token** it prints into ⚙ Settings →
   *Bridge token*, then pick a *CLI · local bridge* provider. The UI calls it
   over `http://localhost` (the Figma sandbox can't spawn processes).
4. ✅ **Phase 4** — Figma **tool layer** + an agentic loop. The chat has a
   **Design / Agent** toggle: *Agent* mode lets the model inspect and edit the
   current page via tools — `get_selection`, `get_page_summary`,
   `get_design_system`, `rename_nodes`, `set_auto_layout`, `align_nodes`,
   `set_fill`, `set_text`. Tools run in the sandbox (`src/main/tools.ts`); the UI
   drives the loop (`src/ui/ai/agent.ts`) over a text protocol (the model emits
   ` ```tool ` JSON blocks), so it works across **every** provider *and* the CLI
   bridge without per-vendor function-calling formats.
5. ✅ **Phase 5** — **MCP relay**. `bridge/mcp-server.mjs` is a zero-dep stdio
   MCP server exposing the Figma tools (defined once in `bridge/tools.mjs`); the bridge relays `tools/call` to the
   plugin over SSE and back. In Agent mode, the **Claude CLI** provider now
   drives the canvas via native MCP tool-calling (`src/ui/ai/cliMcp.ts`); other
   CLIs keep the Phase-4 text protocol. The whole relay loop is verified; the
   only version-sensitive seam is `claude`'s own MCP flags (see `bridge/README`).
6. ✅ **Phase 6** — Ideation + image generation + web. Design mode shows
   **ideation chips** (3 variations, dark/light theme, more minimal…) that boost
   the prompt. Three new agent tools, handled UI-side: `generate_image` (OpenAI
   `gpt-image-1` / Gemini image → placed on the canvas or used as a node fill),
   `web_fetch` (URL → readable text, with a bridge fallback for CORS), and
   `web_search` (keyword search via the bridge's `/search`). Set an image
   provider + key in ⚙ Settings → *Image generation*.

### Bridge security

The bridge runs local CLIs and fetches URLs, so it only answers requests that
carry its token (`x-bridge-token`). The token is generated on first run, stored
in `~/.html-to-figma-bridge/token` (override with `BRIDGE_TOKEN`), and printed
on startup. It also only accepts the plugin's `null` origin, checks the `Host`
header against DNS rebinding, and `/fetch` refuses private/loopback addresses.

## Architecture

The plugin runs in two worlds that talk over `postMessage`:

- **UI iframe** (`src/ui`) — has a real DOM. It renders the HTML in a nested
  offscreen `<iframe>` (so `<head>` CSS, `<body>` background and `@font-face`
  all apply), measures every element (`getBoundingClientRect` +
  `getComputedStyle`), resolves every CSS colour through a 1×1 canvas (handles
  `oklch()`/`hsl()`/`color()`, not just `rgb()`), fetches images, and serialises
  a plain [`LayerNode`](src/shared/types.ts) tree.
- **Sandbox** (`src/main`) — has the Figma API. It preloads fonts and rebuilds
  the tree as native Figma nodes, reporting progress as it goes.

`src/shared/types.ts` is the serialisable contract between the two.

## Develop

```bash
npm install
npm run build      # one-off build → dist/
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
npm test           # unit tests (node --test, bundled with esbuild)
```

Unit tests live in `test/unit/` and cover the DOM-free pieces: CSS value
parsers (`src/ui/cssParse.ts`), the agent tool-call parser and SSE reader, the
bridge's SSRF guard and search parser (`bridge/net.mjs`), and a check that the
UI tool catalogue matches the bridge's MCP tool list.

Then in the Figma desktop app: **Plugins → Development → Import plugin from
manifest…** and pick `manifest.json`. Re-run after each build (or use `watch`).

The build inlines the React bundle + CSS into a single self-contained
`dist/ui.html`, as Figma requires.

## Notes & limits

- **URL import** fetches the page from the browser, so sites with strict CORS
  policies may refuse — paste their HTML directly as a fallback.
- Gradients: linear (angle + `to <side>` keywords) and radial are reproduced
  with corner-to-corner accuracy; conic is approximated as radial. Box-shadow
  parses comma-separated layers; exotic CSS may approximate.
- Text gradients (`background-clip: text`) render as solid text.
- Inline `<svg>` becomes editable vectors, except SVGs Figma's importer mangles
  (dashed strokes like progress rings, gradients, filters, masks/clip-paths,
  `url(#…)` paint refs) — those are rasterised through the browser for fidelity,
  which needs image import enabled (otherwise they fall back to vectors).
- CSS `transform` (rotate/scale) and `::before`/`::after` pseudo-elements are
  not yet reproduced.
- Per-side borders share a single colour (Figma's stroke model); differing
  colours collapse to the heaviest side.
