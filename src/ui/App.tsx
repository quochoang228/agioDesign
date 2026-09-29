import { useEffect, useRef, useState, useCallback } from 'react';
import type { DragEvent as ReactDragEvent, SyntheticEvent } from 'react';
import type { ConvertOptions, PluginToUiMessage, UiToPluginMessage, WidthPreset } from '../shared/types';
import { WIDTH_PRESETS, resolveRenderWidth } from '../shared/types';
import { htmlToLayerTree } from './converter';
import { ChatPanel } from './ai/ChatPanel';
import { ExportPanel } from './export/ExportPanel';
import { ResizeGrip } from './ResizeGrip';
import { Segmented } from './Segmented';
import { IconBack, IconCheck, IconClose, IconCode, IconExport, IconEye, IconFile, IconLink, IconSparkle, IconUpload } from './icons';

const DEFAULT_OPTIONS: ConvertOptions = {
  useAutoLayout: false,
  importImages: true,
  wrapInComponent: false,
  scale: 1,
  widthPreset: 'desktop',
  customWidth: 1280,
};

/** Render-width categories shown as a segmented control, in display order. */
const WIDTH_CHOICES: { preset: WidthPreset; label: string }[] = [
  { preset: 'mobile', label: 'Mobile' },
  { preset: 'tablet', label: 'Tablet' },
  { preset: 'desktop', label: 'Desktop' },
  { preset: 'custom', label: 'Custom' },
];

const TABS = [
  { value: 'design' as const, label: <><IconCode />Design</> },
  { value: 'code' as const, label: <><IconExport />Code</> },
  { value: 'ai' as const, label: <><IconSparkle />AI</> },
];

const SOURCES = [
  { value: 'paste' as const, label: <><IconCode />Code</> },
  { value: 'url' as const, label: <><IconLink />URL</> },
  { value: 'file' as const, label: <><IconFile />File</> },
];

const SAMPLE_HTML = `<div style="font-family:Inter,sans-serif;width:360px;padding:24px;background:#0d1117;border-radius:16px;color:#fff;display:flex;flex-direction:column;gap:16px">
  <div style="display:flex;align-items:center;gap:12px">
    <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#ec4899)"></div>
    <div>
      <div style="font-size:16px;font-weight:600">agioDesign</div>
      <div style="font-size:13px;color:#8b949e">Paste · Import · Convert</div>
    </div>
  </div>
  <button style="padding:12px;border:none;border-radius:10px;background:#6366f1;color:#fff;font-weight:600;font-size:14px">Get started</button>
</div>`;

/** Post a typed message to the plugin sandbox. */
function send(msg: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

type Tab = 'design' | 'code' | 'ai';
/** Where the Design tab's HTML comes from. */
type Source = 'paste' | 'url' | 'file';
/** When importing several files, `batch` carries the "file i of n" position. */
type Batch = { i: number; n: number };
type Status =
  | { kind: 'idle' }
  | { kind: 'rendering'; batch?: Batch }
  | { kind: 'building'; done: number; total: number; batch?: Batch }
  | { kind: 'done'; count: number }
  | { kind: 'error'; message: string };

export function App() {
  const [tab, setTab] = useState<Tab>('design');
  const [source, setSource] = useState<Source>('paste');
  const [html, setHtml] = useState(SAMPLE_HTML);
  const [url, setUrl] = useState('');
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [preview, setPreview] = useState<{ html: string; name: string }[] | null>(null);
  const optionsLoaded = useRef(false);
  // Resolves when the sandbox finishes (or fails) the in-flight IMPORT, so a
  // multi-file batch is built one at a time rather than all at once.
  const importDone = useRef<((ok: boolean) => void) | null>(null);

  // Effective render width derived from the persisted width preset / custom value.
  const width = resolveRenderWidth(options);

  // Load persisted options on mount.
  useEffect(() => {
    send({ type: 'GET_SETTINGS' });
    const onMessage = (event: MessageEvent) => {
      const msg = event.data.pluginMessage as PluginToUiMessage | undefined;
      if (!msg) return;
      if (msg.type === 'SETTINGS') {
        setOptions(msg.options);
        optionsLoaded.current = true;
      } else if (msg.type === 'PROGRESS') {
        setStatus((s) =>
          s.kind === 'building'
            ? { ...s, done: msg.done, total: msg.total }
            : { kind: 'building', done: msg.done, total: msg.total },
        );
      } else if (msg.type === 'DONE') {
        importDone.current?.(true);
      } else if (msg.type === 'ERROR') {
        setStatus({ kind: 'error', message: msg.message });
        importDone.current?.(false);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Persist options whenever they change (after the initial load).
  useEffect(() => {
    if (optionsLoaded.current) send({ type: 'SAVE_SETTINGS', options });
  }, [options]);

  const setOption = useCallback(<K extends keyof ConvertOptions>(key: K, value: ConvertOptions[K]) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }, []);

  const busy = status.kind === 'rendering' || status.kind === 'building';

  // Read dropped/selected .html/.svg files into state (appends, de-dupes by name).
  const addFiles = useCallback((list: FileList | File[]) => {
    const chosen = Array.from(list).filter((f) => /\.(html?|svg)$/i.test(f.name));
    if (!chosen.length) {
      send({ type: 'NOTIFY', message: 'Please choose .html or .svg files.', error: true });
      return;
    }
    chosen.forEach((f) => {
      const reader = new FileReader();
      reader.onload = () =>
        setFiles((prev) => {
          const content = String(reader.result || '');
          const next = prev.filter((p) => p.name !== f.name);
          return [...next, { name: f.name, content }];
        });
      reader.onerror = () =>
        send({ type: 'NOTIFY', message: `Could not read ${f.name}.`, error: true });
      reader.readAsText(f);
    });
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  type Doc = { html: string; name: string; baseUrl?: string };

  // Build the list of documents to import (one per file, or one for paste/url).
  const resolveSources = useCallback(async (): Promise<Doc[]> => {
    if (source === 'paste') return [{ html, name: 'Imported HTML' }];
    if (source === 'file') {
      if (!files.length) throw new Error('Choose one or more files first.');
      return files.map((f) => ({ html: f.content, name: f.name.replace(/\.[^.]+$/, '') }));
    }
    let target = url.trim();
    if (!target) throw new Error('Enter a URL first.');
    if (!/^https?:\/\//.test(target)) target = 'https://' + target;
    const res = await fetch(target, { mode: 'cors' });
    if (!res.ok) throw new Error(`Fetch failed (${res.status}).`);
    let page = await res.text();
    // Rewrite relative asset URLs so images resolve against the origin.
    const base = new URL(target);
    page = page.replace(/(src|href)=["'](?!https?:|data:|#)([^"']+)["']/g, (_m, attr, path) => {
      try {
        return `${attr}="${new URL(path, base).href}"`;
      } catch {
        return `${attr}="${path}"`;
      }
    });
    return [{ html: page, name: base.hostname, baseUrl: base.href }];
  }, [source, html, url, files]);

  const onImport = useCallback(async () => {
    try {
      const sources = await resolveSources();
      const n = sources.length;
      let totalLayers = 0;
      for (let i = 0; i < n; i++) {
        const src = sources[i];
        const batch = n > 1 ? { i: i + 1, n } : undefined;
        setStatus({ kind: 'rendering', batch });
        const { tree } = await htmlToLayerTree(src.html, width, options.importImages, src.baseUrl);
        setStatus({ kind: 'building', done: 0, total: 0, batch });
        // Wait for the sandbox to finish this file before sending the next.
        const ok = await new Promise<boolean>((resolve) => {
          importDone.current = resolve;
          send({
            type: 'IMPORT',
            tree,
            options,
            sourceName: src.name,
            batchIndex: i,
            batchTotal: n,
          });
        });
        importDone.current = null;
        if (!ok) return; // an ERROR was already surfaced
        totalLayers++;
      }
      setStatus({ kind: 'done', count: totalLayers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', message });
      send({ type: 'NOTIFY', message, error: true });
    }
  }, [resolveSources, width, options]);

  // Import a single HTML document (from the AI Agent) through the same pipeline
  // the converter tabs use. Returns whether the sandbox finished successfully.
  const importHtml = useCallback(
    async (html: string, name: string): Promise<boolean> => {
      try {
        setStatus({ kind: 'rendering' });
        const { tree } = await htmlToLayerTree(html, width, options.importImages);
        setStatus({ kind: 'building', done: 0, total: 0 });
        const ok = await new Promise<boolean>((resolve) => {
          importDone.current = resolve;
          send({ type: 'IMPORT', tree, options, sourceName: name });
        });
        importDone.current = null;
        if (ok) setStatus({ kind: 'done', count: 1 });
        return ok;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus({ kind: 'error', message });
        send({ type: 'NOTIFY', message, error: true });
        return false;
      }
    },
    [width, options],
  );

  // Open a live preview of the source(s); enlarge the plugin window for it.
  const onPreview = useCallback(async () => {
    try {
      const sources = await resolveSources();
      setPreview(sources.map((s) => ({ html: s.html, name: s.name })));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: 'error', message });
      send({ type: 'NOTIFY', message, error: true });
    }
  }, [resolveSources]);

  const closePreview = useCallback(() => setPreview(null), []);

  const importFromPreview = useCallback(() => {
    closePreview();
    onImport();
  }, [closePreview, onImport]);

  return (
    <div className="app">
      <header className="topbar">
        <Segmented options={TABS} value={tab} onChange={setTab} size="lg" ariaLabel="Section" />
      </header>

      {tab === 'ai' && <ChatPanel importHtml={importHtml} width={width} />}

      {tab === 'code' && <ExportPanel />}

      {tab === 'design' && (
        <>
          <main className="design">
            <section className="glass card source-card">
              <Segmented options={SOURCES} value={source} onChange={setSource} ariaLabel="Source" />

              {source === 'paste' ? (
                <textarea
                  className="code-input"
                  spellCheck={false}
                  value={html}
                  placeholder="Paste HTML here…"
                  onChange={(e) => setHtml(e.target.value)}
                />
              ) : source === 'url' ? (
                <div className="stack">
                  <input
                    className="input"
                    type="text"
                    placeholder="example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !busy && onImport()}
                  />
                  <p className="hint">
                    Fetched from your browser. Sites that block cross-origin requests won’t load — paste their HTML in
                    Code instead.
                  </p>
                </div>
              ) : (
                <div className="stack">
                  <label
                    className={dragOver ? 'dropzone over' : 'dropzone'}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={onDrop}
                  >
                    <input
                      type="file"
                      accept=".html,.htm,.svg"
                      multiple
                      hidden
                      onChange={(e) => {
                        if (e.target.files?.length) addFiles(e.target.files);
                        e.target.value = ''; // allow re-selecting the same file
                      }}
                    />
                    <span className="dropzone-icon">
                      <IconUpload />
                    </span>
                    <strong>Choose files</strong>
                    <span className="hint">or drop .html / .svg here</span>
                  </label>

                  {files.length > 0 && (
                    <ul className="list">
                      {files.map((f, i) => (
                        <li key={f.name} className="list-row">
                          <IconFile />
                          <span className="list-title" title={f.name}>
                            {f.name}
                          </span>
                          <span className="list-detail">{(f.content.length / 1024).toFixed(0)} KB</span>
                          <button
                            className="icon-btn sm"
                            title="Remove"
                            onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                          >
                            <IconClose />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="hint">Each file becomes its own frame, placed side by side.</p>
                </div>
              )}
            </section>

            <section className="glass card output-card">
              <div className="output-row">
                <span className="card-title">Output</span>
                <span className="spacer" />
                {options.widthPreset === 'custom' ? (
                  <input
                    type="number"
                    className="input px-input"
                    min={64}
                    max={4096}
                    step={1}
                    aria-label="Custom width in px"
                    value={options.customWidth}
                    onChange={(e) =>
                      setOption('customWidth', Math.min(4096, Math.max(0, Math.round(Number(e.target.value) || 0))))
                    }
                  />
                ) : (
                  <span className="list-detail">{width}px</span>
                )}
              </div>
              <Segmented
                options={WIDTH_CHOICES.map((c) => ({
                  value: c.preset,
                  label: c.label,
                  title: c.preset === 'custom' ? 'Custom width' : `${WIDTH_PRESETS[c.preset]}px`,
                }))}
                value={options.widthPreset}
                onChange={(v) => setOption('widthPreset', v)}
                size="sm"
                ariaLabel="Render width"
              />
              <div className="output-row wrap">
                <Segmented
                  options={[0.5, 1, 2].map((v) => ({ value: v, label: `${v}×` }))}
                  value={options.scale}
                  onChange={(v) => setOption('scale', v)}
                  size="sm"
                  ariaLabel="Scale"
                />
                <OptionChip
                  label="Auto layout"
                  hint="Flex containers become auto-layout frames"
                  on={options.useAutoLayout}
                  onChange={(v) => setOption('useAutoLayout', v)}
                />
                <OptionChip
                  label="Images"
                  hint="Fetch and embed images"
                  on={options.importImages}
                  onChange={(v) => setOption('importImages', v)}
                />
                <OptionChip
                  label="Component"
                  hint="Wrap the result in a component"
                  on={options.wrapInComponent}
                  onChange={(v) => setOption('wrapInComponent', v)}
                />
              </div>
            </section>
          </main>

          <footer className="dock glass">
            <StatusLine status={status} />
            <button className="btn btn-glass" onClick={onPreview} disabled={busy}>
              <IconEye />
              Preview
            </button>
            <button className="btn btn-primary" onClick={onImport} disabled={busy}>
              {busy ? 'Working…' : source === 'file' && files.length > 1 ? `Import ${files.length} files` : 'Import to Figma'}
            </button>
          </footer>
        </>
      )}

      {preview && (
        <PreviewOverlay sources={preview} width={width} onClose={closePreview} onImport={importFromPreview} />
      )}
      <ResizeGrip />
    </div>
  );
}

function PreviewOverlay(props: {
  sources: { html: string; name: string }[];
  width: number;
  onClose: () => void;
  onImport: () => void;
}) {
  const { sources, width, onClose, onImport } = props;
  const [index, setIndex] = useState(0);
  const [frameH, setFrameH] = useState(900);
  const [paneW, setPaneW] = useState(560);
  const stageRef = useRef<HTMLDivElement>(null);
  const current = sources[Math.min(index, sources.length - 1)];

  // Track the available preview width so the artwork scales to fit.
  useEffect(() => {
    const measure = () => {
      if (stageRef.current) setPaneW(stageRef.current.clientWidth);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // After the iframe loads, poll its content height (JS apps mount late).
  const onFrameLoad = useCallback((e: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = e.currentTarget;
    let n = 0;
    const tick = () => {
      try {
        const d = frame.contentDocument;
        const h = d ? Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight || 0) : 0;
        if (h > 0) setFrameH(h);
      } catch {
        /* ignore */
      }
      if (++n < 16) setTimeout(tick, 200);
    };
    tick();
  }, []);

  const scale = Math.min(1, paneW / width);

  return (
    <div className="overlay">
      <header className="sheet-head glass">
        <button className="icon-btn" onClick={onClose} title="Back">
          <IconBack />
        </button>
        <strong>Preview</strong>
        <span className="muted">
          {width}px · {Math.round(scale * 100)}%
        </span>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={onImport}>
          Import{sources.length > 1 ? ` ${sources.length}` : ''}
        </button>
      </header>

      {sources.length > 1 && (
        <nav className="chips preview-chips">
          {sources.map((s, i) => (
            <button
              key={s.name + i}
              className={i === index ? 'chip active' : 'chip'}
              onClick={() => setIndex(i)}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </nav>
      )}

      <div className="overlay-body" ref={stageRef}>
        <div
          className="preview-scaler"
          style={{ width: width * scale, height: frameH * scale }}
        >
          <iframe
            className="preview-frame"
            title="preview"
            sandbox="allow-scripts allow-same-origin"
            srcDoc={current.html}
            onLoad={onFrameLoad}
            style={{
              width,
              height: frameH,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          />
        </div>
      </div>
    </div>
  );
}

/** Compact on/off pill for a boolean output option; the hint shows as a tooltip. */
function OptionChip(props: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      className={props.on ? 'opt-chip on' : 'opt-chip'}
      aria-pressed={props.on}
      title={props.hint}
      onClick={() => props.onChange(!props.on)}
    >
      {props.on && <IconCheck />}
      {props.label}
    </button>
  );
}

function StatusLine({ status }: { status: Status }) {
  const fileTag = (b?: Batch) => (b ? `File ${b.i}/${b.n} · ` : '');
  if (status.kind === 'idle') return <span className="status muted" />;
  if (status.kind === 'rendering')
    return <span className="status">{fileTag(status.batch)}Rendering…</span>;
  if (status.kind === 'building') {
    const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
    return (
      <span className="status">
        <span className="progress">
          <span className="progress-fill" style={{ width: `${pct}%` }} />
        </span>
        {fileTag(status.batch)}Building {status.done}/{status.total || '…'}
      </span>
    );
  }
  if (status.kind === 'done')
    return (
      <span className="status ok">Done · {status.count} {status.count === 1 ? 'frame' : 'frames'}</span>
    );
  return <span className="status err">{status.message}</span>;
}
