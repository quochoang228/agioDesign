# agioDesign

**Two-way design ↔ code for Figma, with an AI design agent built in.**

agioDesign is a Figma plugin that:

- **Design** — turns raw **HTML/CSS**, a **live URL** or local **.html/.svg files** into fully editable Figma layers (auto layout, text, gradients, images, vectors).
- **Code** — exports Figma frames to **HTML + CSS**, **Tailwind**, **React (JSX)** or **React + Tailwind**, including **responsive pages merged from several breakpoint frames**.
- **AI** — generates screens from a prompt and edits the current page as an agent, with **Claude, GPT, Gemini** (your API key) or your installed **Claude Code / Codex / opencode CLI** via a local bridge (MCP included).
- **Dev Mode** — acts as a Figma Dev Mode code generator (HTML + CSS, Tailwind, React).

It started as a rewrite of the classic [html-to-figma DEV-plugin](https://www.figma.com/community/plugin/1005496056687344906) ([sergcen/html-to-figma](https://github.com/sergcen/html-to-figma)) and was previously called *HTML to Figma Pro*.

---

## Contents

- [Quick start](#quick-start)
- [Bắt đầu nhanh (Tiếng Việt)](#bắt-đầu-nhanh-tiếng-việt)
- [Design tab — HTML → Figma](#design-tab--html--figma)
- [Code tab — Figma → HTML / Tailwind / React](#code-tab--figma--html--tailwind--react)
- [AI tab — generate & agent](#ai-tab--generate--agent)
- [Local bridge (CLI + MCP)](#local-bridge-cli--mcp)
- [Dev Mode code generator](#dev-mode-code-generator)
- [Project structure](#project-structure)
- [Architecture](#architecture)
- [Development](#development)
- [Packaging & private sharing](#packaging--private-sharing)
- [Limitations](#limitations)
- [Credits & license](#credits--license)

---

## Quick start

Requires the **Figma desktop app** (development plugins can't be imported in the browser).

### From a release zip

1. Unzip `agioDesign-v<version>.zip` somewhere permanent.
2. Figma desktop → open any design file → **Plugins → Development → Import plugin from manifest…** → pick `agioDesign/manifest.json`.
3. Run it from **Plugins → Development → agioDesign**.

### From source

```bash
npm install
npm run build        # → dist/code.js + dist/ui.html
```

Then import the repo's `manifest.json` the same way. Use `npm run watch` while developing and re-run the plugin after each rebuild.

---

## Bắt đầu nhanh (Tiếng Việt)

agioDesign là plugin Figma chuyển **HTML → Figma** và **Figma → HTML/Tailwind/React**, kèm trợ lý AI thiết kế.

1. Cài **Figma desktop**.
2. Giải nén bản phát hành (hoặc `npm install && npm run build` nếu dùng mã nguồn).
3. Figma → **Plugins → Development → Import plugin from manifest…** → chọn `manifest.json`.
4. Chạy **Plugins → Development → agioDesign**:
   - **Design**: dán HTML, nhập URL hoặc kéo thả file `.html` → **Import to Figma**.
   - **Code**: chọn frame trong Figma → chọn định dạng (HTML/Tailwind/React) và kiểu layout (Fixed/Fluid/Scale) → **Export code** → xem trước, copy hoặc tải về. Chọn nhiều frame (Mobile + Desktop) và bật **Responsive** để ghép thành một trang có breakpoint.
   - **AI**: vào ⚙ Settings, chọn nhà cung cấp và dán API key của bạn, rồi mô tả màn hình muốn tạo. Chế độ **Agent** cho AI chỉnh trực tiếp trang Figma đang mở.
5. (Tuỳ chọn) Cài **bridge** để dùng Claude Code / Codex CLI có sẵn trên máy thay cho API key — xem [Local bridge](#local-bridge-cli--mcp).

---

## Design tab — HTML → Figma

Sources: **Code** (paste HTML), **URL** (fetched from the plugin), **File** (pick or drop several `.html`/`.svg` files; each becomes its own frame, tiled left → right). **Preview** renders the source at the chosen width before importing.

Output options: render width (**Mobile 390 / Tablet 768 / Desktop 1280 / Custom**), scale (0.5× / 1× / 2×), **Auto layout** (CSS flex → Figma auto layout), **Images** (fetch and embed), **Component** (wrap the result in a component).

How it works: the HTML is rendered in an offscreen iframe so real CSS applies; every element is measured (`getBoundingClientRect` + `getComputedStyle`, per-text-node `Range` measurement), colours are resolved through a 1×1 canvas (so `oklch()`, `hsl()`, `color()` work), images are fetched, and a plain `LayerNode` tree is sent to the sandbox, which preloads fonts and builds native nodes.

| | Supported |
|---|---|
| Layout | Absolute frames, **flex → auto layout** (direction, gap, padding, alignment, `flex-grow`), z-index stacking order, same-origin iframes |
| Styling | Solid fills, linear/radial gradients, per-side borders, box-shadows (multi-layer, inset), corner radii, opacity |
| Text | Font family/weight/italic with a safe fallback chain, size, line height, letter spacing, alignment, decoration, case, mixed-style runs and links |
| Images | `<img>`, CSS `background-image`, `object-fit` / `background-size` → Figma scale modes |
| SVG | Inline `<svg>` → editable vectors; SVGs Figma's importer mangles (dashed strokes, gradients, filters, masks, `url(#…)` paints) are rasterised for fidelity |

---

## Code tab — Figma → HTML / Tailwind / React

Select one or more frames in Figma, open **Code**, pick options and press **Export code**. The sandbox serialises the selection once; every option change re-runs the generator instantly on the cached result.

### Formats

| Format | Output |
|---|---|
| **HTML** | `index.html` with CSS in a `<style>` block, a separate `styles.css`, or inline `style=""` |
| **Tailwind** | HTML with utility classes (named utilities where possible, arbitrary values/properties otherwise), Tailwind CDN for zero-config preview |
| **React** | A ready-to-run **Vite** starter (`package.json`, `index.html`, `src/main.jsx`, `src/<Component>.jsx`, `src/styles.css`, `public/assets/`) |
| **React TW** | Same starter with Tailwind classes in JSX |

### Layout modes

| Mode | What you get |
|---|---|
| **Fixed** | Pixel-exact sizes and positions |
| **Fluid** | Auto layout → flexbox with FILL/HUG/FIXED sizing; absolute children follow their constraints (left/right/center/stretch/scale); the frame width becomes a centred `max-width` |
| **Scale** | Every length is `n * var(--u)` with `--u: calc(100vw / frameWidth)` — the page looks identical at any viewport width |

Other options: image density **@1x / @2x / @3x** for flattened layers, **Embed images** (single file with base64) or separate files with `srcset`, **Variables** (Figma variables → CSS custom properties with fallbacks), **Semantic tags**, **rem** units, CSS placement and a **class prefix**.

### Responsive breakpoints

Select several frames of the same screen (e.g. *Mobile 390* and *Desktop 1440*), keep **Responsive** on and give each frame a min-width (auto-guessed from its width). They merge into **one** page:

- the smallest frame is the base style; larger frames emit only the properties that change, inside `@media (min-width: …)` (Tailwind: `min-[…]:` variants);
- layers are matched by name (unique names first, then by order), then by identical content (text/SVG/image), then by component;
- layers present in only some frames are kept in the DOM and hidden elsewhere; reordered flex children get `order`;
- the notes panel lists unmatched layers so you can rename them.

### Fidelity

- Gradients: linear, radial, angular (conic) rebuilt from Figma's `gradientTransform`, so angle and stop positions match; diamond is approximated as radial.
- Image fills: fill / fit (as `<img>` with `object-fit` when possible), crop and tile.
- Strokes: inside / center / outside (via `outline` + offset), per-side weights, dashed.
- Effects: drop and inner shadows, layer blur, background blur; blend modes; opacity; rotation.
- Text: mixed-style runs as `<span>`s, hyperlinks as `<a>`, auto-width / auto-height / fixed boxes, truncation and line clamp, vertical alignment, text case, gradient text.
- Vectors and small vector-only groups (icons ≤ 64 px) become inline SVG; masks and unsupported layers are flattened to PNG.
- Fonts: families on Google Fonts get a single `css2` `<link>` with only the weights/italics used; others are reported so you can self-host them.
- Identical styles share one class; class names come from layer names.

### Result sheet

Live **preview** at Mobile / Tablet / Desktop / frame widths, code tabs, **Copy**, **Download** (single `.html` or a `.zip`), notes and warnings (click a layer name to select it in Figma).

**Refine with AI** sends the generated file to the provider configured in the AI tab and asks for a semantic, readable rewrite that renders identically. Embedded images are swapped for placeholders so they cost no tokens, and restored afterwards. You can compare original vs. refined and revert.

---

## AI tab — generate & agent

Open **⚙ Settings**, choose a provider and model, and paste your API key (stored in `figma.clientStorage` on your machine; only sent to that vendor's API).

| Provider | Models (editable — type any id your key can use) |
|---|---|
| Claude · Anthropic API | `claude-opus-5-5` (default), `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-haiku-4-5` |
| OpenAI | `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4o` |
| Google Gemini | `gemini-2.5-pro`, `gemini-2.5-flash` |
| Claude CLI / Codex CLI / opencode | via the [local bridge](#local-bridge-cli--mcp) — reuses the CLI's own login, no key |

**Design mode** — describe a screen; the model writes a self-contained HTML document that goes through the same converter as the Design tab. Each reply has **Import to Figma**; ideation chips (variations, dark/light, more minimal…) boost the prompt.

**Agent mode** — the model inspects and edits the current page with tools:

| Tool | Does |
|---|---|
| `get_selection`, `get_page_summary`, `get_design_system` | Read the selection, page, local styles and components |
| `rename_nodes`, `set_auto_layout`, `align_nodes`, `set_fill`, `set_text` | Edit layers |
| `generate_image` | OpenAI `gpt-image-1` / Gemini image → placed on the canvas or used as a fill |
| `export_html` | Export frames to HTML / Tailwind / React |
| `web_fetch`, `web_search` | Read a URL / search the web (search needs the bridge) |

Tools run in the sandbox (`src/main/tools.ts`) or the UI (image, web); the loop (`src/ui/ai/agent.ts`) uses a text protocol (the model emits ```` ```tool ```` JSON blocks), so it works with every provider. With the **Claude CLI** provider, the agent uses native **MCP** tool-calling through the bridge instead.

---

## Local bridge (CLI + MCP)

The Figma sandbox can't start processes, so a small companion server on `127.0.0.1:3939` does it: it runs your installed `claude` / `codex` / `opencode`, streams the output, relays MCP tool calls to the plugin, and backs `web_fetch` / `web_search`.

**Install (once, no terminal):**

- *From source*: double-click `bridge/Install Bridge (macOS).command` / `(Windows).cmd` / `(Linux).sh` (needs Node.js 18+), or `npm run bridge:install`.
- *From a release zip*: run the executable in `Bridge (optional)/<OS>/` — no Node.js needed.

It registers itself to start at login (launchd / Startup folder / XDG autostart). Then in the plugin: **AI → Settings → Local bridge → Connect** and click **Allow** in the native dialog. The same panel turns it on/off.

| Command | |
|---|---|
| `npm run bridge` | Run in the foreground (development) |
| `npm run bridge:install` / `bridge:uninstall` / `bridge:status` | Manage the login item |
| `npm run smoke:mcp` | End-to-end check of the Claude CLI ↔ MCP relay |

**Security:** every route except `/health` and `/pair` needs the `x-bridge-token` header. The token lives in `~/.agiodesign-bridge/token` and reaches the plugin only through `/pair` after you click Allow. Only the plugin's `null` origin is accepted, the `Host` header is checked (DNS rebinding), prompts go to CLIs via stdin, and `/fetch` refuses private/loopback addresses. Details and endpoints: [`bridge/README.md`](bridge/README.md).

MCP: `bridge/mcp-server.mjs` is a zero-dependency stdio MCP server exposing the Figma tools (defined once in `bridge/tools.mjs`, kept in sync with the UI catalogue by a unit test).

---

## Dev Mode code generator

In Figma **Dev Mode**, choose agioDesign as the code language source (HTML + CSS, Tailwind or React). The inspected layer is serialised and generated in the sandbox with your saved Code-tab options; image files are referenced as `assets/<name>`.

---

## Project structure

```
manifest.json            Figma plugin manifest (design + dev/codegen)
build.mjs                esbuild: sandbox bundle + single-file inlined UI (--release minifies)
src/
  main/                  Sandbox (Figma API)
    code.ts              Message router, settings, window size, codegen entry
    builder.ts           LayerNode tree → Figma nodes (Design tab)
    tools.ts             Agent tools
    export/              Figma → ExportNode serialiser, export handlers, Dev Mode codegen
  ui/                    UI iframe (React)
    App.tsx              Tabs: Design / Code / AI
    converter.ts         HTML → LayerNode (DOM measurement)
    export/              Code tab (ExportPanel) + AI refine
    ai/                  Chat, agent loop, providers, bridge client, image & web tools
  codegen/               Pure generator: ExportNode → HTML/CSS, Tailwind, React, zip
  shared/                Contracts: types.ts (LayerNode, messages), export.ts (ExportNode), agent.ts
bridge/                  Local bridge: server, MCP server, installer, single-binary entry (cli.mjs)
scripts/package.mjs      Source-free release zip (plugin + compiled bridge)
test/unit/               Unit tests (node --test)
test/roundtrip.ts        HTML → Figma tree → HTML fidelity harness
```

## Architecture

A Figma plugin runs in two worlds that talk over `postMessage`:

- **UI iframe** (`src/ui`) has a DOM and network access: it renders/measures HTML for the Design tab, runs the AI providers and the Code tab's generator and preview.
- **Sandbox** (`src/main`) has the Figma API: it builds nodes from a `LayerNode` tree, serialises nodes into an `ExportNode` tree (+ image bytes), and executes agent tools.

The Figma → code generator (`src/codegen`) is pure TypeScript — no DOM, no Figma API — so the same code runs in the UI, in the sandbox (Dev Mode, `export_html` tool) and in unit tests. Its pipeline: `ExportNode` → `El` tree with per-element declarations (`build.ts`) → breakpoint merge, class dedupe and CSS cascade (`merge.ts`) → HTML/CSS, Tailwind or JSX (`index.ts`).

---

## Development

| Script | |
|---|---|
| `npm run build` / `npm run watch` | Build `dist/` once / on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests: CSS parsers, agent tool parser, SSE reader, bridge SSRF guard and search parser, tool-catalogue sync, and the Figma → code generator (flexbox, constraints, scale units, gradients, text runs, breakpoints, Tailwind/React, assets, zip, AI refine helpers) |
| `npm run roundtrip` | Builds `test/roundtrip.html`: serve the repo root (e.g. `python3 -m http.server`) and open `/test/roundtrip.html?file=sample.html&layout=fixed&autolayout=1` to compare the source page with HTML regenerated from its Figma tree (`&view=src\|gen`, `&layout=fixed\|fluid\|scale`, `&format=tailwind`) |
| `npm run package` | Release zip (see below) |

---

## Packaging & private sharing

```bash
npm run package                                   # → release/agioDesign-v<version>.zip
npm run package -- --no-bridge                    # plugin only (~150 KB)
AGIO_TARGETS=bun-darwin-arm64,bun-linux-x64 npm run package   # choose bridge targets
```

The zip holds build output only: `agioDesign/` (manifest + minified `dist/`), `Bridge (optional)/` with the bridge compiled by [bun](https://bun.sh) into one executable per OS (default: macOS Apple Silicon, macOS Intel, Windows x64), a Vietnamese `HUONG-DAN.txt` and `THIRD-PARTY-NOTICES.txt`. The script aborts if the bundle contains an API key or your home-folder path. Bridge executables are unsigned, so macOS/Windows show a warning the first time (instructions are in `HUONG-DAN.txt`). JavaScript shipped to a client can always be read — this keeps the *source* private, not the behaviour.

---

## Limitations

**HTML → Figma**
- URL import is fetched from the plugin, so sites with strict CORS may refuse — paste their HTML instead.
- Conic gradients are approximated as radial; text gradients (`background-clip: text`) become solid text.
- CSS `transform` (rotate/scale) and `::before` / `::after` are not reproduced yet.
- Per-side borders share one colour (Figma's stroke model).

**Figma → code**
- Frames without auto layout export as absolutely positioned elements; use *Scale* or add auto layout for responsive output.
- Grid auto layout is exported with absolute positions; diamond gradients are approximated.
- Breakpoint merging relies on layer names; layers that differ in content (text, raster) are duplicated and toggled per breakpoint.
- Image-fill opacity on backgrounds and inner shadows on text are not expressible in CSS and are dropped (with a note).

---

## Credits & license

- Based on the ideas of [sergcen/html-to-figma](https://github.com/sergcen/html-to-figma).
- Bundles [React](https://react.dev) (MIT); release bridge executables embed the [Bun](https://bun.sh) runtime (MIT, includes WebKit JavaScriptCore under LGPL-2.1).

© 2026 QuocHoang. License terms: see `package.json`.
