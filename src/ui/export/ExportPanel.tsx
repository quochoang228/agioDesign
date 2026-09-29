/**
 * "Code" tab: Figma → HTML/CSS, Tailwind or React. The sandbox serialises the
 * selection once; every option change re-runs the (pure, fast) generator on
 * the cached bundle. Multiple selected frames can be merged into one responsive
 * page by assigning each a breakpoint.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';
import type { PluginToUiMessage, UiToPluginMessage } from '../../shared/types';
import type { Breakpoint, ExportBundle, ExportOptions, SelectionItem } from '../../shared/export';
import { DEFAULT_EXPORT_OPTIONS } from '../../shared/export';
import type { AgentSettings } from '../../shared/agent';
import { DEFAULT_AGENT_SETTINGS, providerMeta } from '../../shared/agent';
import type { GenerateResult } from '../../codegen';
import { generate, zip } from '../../codegen';
import { base64, extForMime, slugify } from '../../codegen/css';
import { getProvider } from '../ai/providers';
import { Segmented } from '../Segmented';
import { IconBack, IconCheck, IconChevron, IconCode, IconEye, IconSparkle, IconStop } from '../icons';
import { buildRefinePrompt, extractCode, stripAssets } from './refine';

function send(msg: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

/** Breakpoint choices; -1 = leave this frame out of the responsive page. */
const BP_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: 'Base' },
  { value: 480, label: '≥ 480' },
  { value: 640, label: '≥ 640' },
  { value: 768, label: '≥ 768' },
  { value: 1024, label: '≥ 1024' },
  { value: 1280, label: '≥ 1280' },
  { value: 1440, label: '≥ 1440' },
  { value: -1, label: 'Skip' },
];

function guessBreakpoint(width: number): number {
  if (width < 600) return 0;
  if (width < 1024) return 768;
  return 1024;
}

const PREVIEW_WIDTHS = [
  { value: 390, label: 'Mobile' },
  { value: 768, label: 'Tablet' },
  { value: 1280, label: 'Desktop' },
];

type Status =
  | { kind: 'idle' }
  | { kind: 'exporting'; done: number; total: number }
  | { kind: 'error'; message: string };

type Refine =
  | { kind: 'idle' }
  | { kind: 'running'; chars: number }
  | { kind: 'done'; code: string }
  | { kind: 'error'; message: string };

interface Snapshot {
  bundle: ExportBundle;
  items: SelectionItem[];
  density: number;
}

function downloadFile(name: string, data: Uint8Array | string, mime: string): void {
  const blob = new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Figma's iframe may deny the async clipboard API.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** Shorten embedded images so the code view stays readable (copy keeps them). */
function forDisplay(code: string): string {
  return code.replace(/data:([\w/+.-]+);base64,([A-Za-z0-9+/=]{64,})/g, (_m, mime: string, b64: string) => {
    return `data:${mime};base64,…(${Math.round((b64.length * 3) / 4 / 1024)} KB)`;
  });
}

/** Replace `assets/<file>` references with data URIs so a preview renders offline. */
function inlineAssetPaths(code: string, bundle: ExportBundle): string {
  let out = code;
  for (const a of bundle.assets) {
    const ext = extForMime(a.mime);
    const uri = `data:${a.mime};base64,${base64(a.hiDpi?.bytes ?? a.bytes)}`;
    out = out.split(`/assets/${a.name}.${ext}`).join(uri).split(`assets/${a.name}.${ext}`).join(uri);
    if (a.hiDpi) out = out.split(`assets/${a.name}@${a.hiDpi.scale}x.${ext}`).join(uri);
  }
  return out;
}

export function ExportPanel() {
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [selection, setSelection] = useState<SelectionItem[]>([]);
  const [responsive, setResponsive] = useState(true);
  const [bpMap, setBpMap] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const loaded = useRef(false);
  const request = useRef('');

  useEffect(() => {
    send({ type: 'EXPORT_GET_STATE' });
    send({ type: 'AGENT_GET_SETTINGS' });
    const onMessage = (event: MessageEvent) => {
      const msg = event.data.pluginMessage as PluginToUiMessage | undefined;
      if (!msg) return;
      switch (msg.type) {
        case 'EXPORT_SETTINGS':
          setOptions(msg.options);
          loaded.current = true;
          break;
        case 'SELECTION':
          setSelection(msg.items);
          break;
        case 'AGENT_SETTINGS':
          setAgent(msg.settings);
          break;
        case 'EXPORT_PROGRESS':
          if (msg.requestId === request.current) setStatus({ kind: 'exporting', done: msg.done, total: msg.total });
          break;
        case 'EXPORT_RESULT':
          if (msg.requestId !== request.current) break;
          setSnapshot((s) => ({ bundle: msg.bundle, items: s?.items ?? [], density: s?.density ?? 2 }));
          setStatus({ kind: 'idle' });
          setOpen(true);
          break;
        case 'EXPORT_ERROR':
          if (msg.requestId === request.current) setStatus({ kind: 'error', message: msg.message });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (loaded.current) send({ type: 'EXPORT_SAVE_SETTINGS', options });
  }, [options]);

  const set = useCallback(<K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => {
    setOptions((o) => ({ ...o, [k]: v }));
  }, []);

  const bpOf = useCallback((s: SelectionItem) => bpMap[s.id] ?? guessBreakpoint(s.width), [bpMap]);

  const onExport = useCallback(() => {
    if (!selection.length) return;
    const id = `x${Date.now()}`;
    request.current = id;
    setSnapshot((s) => (s ? { ...s, items: selection, density: options.density } : { bundle: { roots: [], assets: [], warnings: [], variables: {} }, items: selection, density: options.density }));
    setStatus({ kind: 'exporting', done: 0, total: 0 });
    send({
      type: 'EXPORT_SELECTION',
      requestId: id,
      ids: selection.map((s) => s.id),
      density: options.density,
      srcset: options.images === 'files',
    });
  }, [selection, options.density, options.images]);

  const exporting = status.kind === 'exporting';
  const multi = selection.length >= 2;

  // Stable identity so the result sheet only regenerates when inputs change.
  const breakpoints = useMemo<Breakpoint[] | undefined>(() => {
    const items = snapshot?.items ?? [];
    if (!responsive || items.length < 2) return undefined;
    return items.map((s) => ({ rootId: s.id, minWidth: bpOf(s) })).filter((b) => b.minWidth >= 0);
  }, [responsive, snapshot?.items, bpOf]);

  return (
    <>
      <main className="design">
        <section className="glass card">
          <div className="output-row">
            <span className="card-title">Selection</span>
            <span className="spacer" />
            {multi && (
              <button
                type="button"
                className={responsive ? 'opt-chip on' : 'opt-chip'}
                aria-pressed={responsive}
                title="Merge the selected frames into one responsive page"
                onClick={() => setResponsive((v) => !v)}
              >
                {responsive && <IconCheck />}
                Responsive
              </button>
            )}
          </div>
          {selection.length === 0 ? (
            <p className="hint">Select one or more frames in Figma to export them as code.</p>
          ) : (
            <ul className="list">
              {selection.map((s) => (
                <li key={s.id} className="list-row">
                  <span className="list-title" title={s.name}>
                    {s.name}
                  </span>
                  <span className="list-detail">
                    {s.width}×{s.height}
                  </span>
                  {multi && responsive && (
                    <select
                      className="inline-select bp-select"
                      aria-label={`Breakpoint for ${s.name}`}
                      value={bpOf(s)}
                      onChange={(e) => setBpMap((m) => ({ ...m, [s.id]: Number(e.target.value) }))}
                    >
                      {BP_CHOICES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          )}
          {multi && responsive && (
            <p className="hint">
              Frames of the same screen become one page: the smallest is the base style, larger ones apply from their
              min-width. Layers are matched by name.
            </p>
          )}
        </section>

        <OptionsCard options={options} set={set} />
      </main>

      <footer className="dock glass">
        <span className={status.kind === 'error' ? 'status err' : 'status'}>
          {status.kind === 'exporting' ? (
            <>
              <span className="progress">
                <span
                  className="progress-fill"
                  style={{ width: `${status.total ? Math.round((status.done / status.total) * 100) : 0}%` }}
                />
              </span>
              Reading {status.done}/{status.total || '…'}
            </>
          ) : status.kind === 'error' ? (
            status.message
          ) : snapshot?.bundle.roots.length ? (
            <button className="text-link" onClick={() => setOpen(true)}>
              Last export
            </button>
          ) : null}
        </span>
        <button className="btn btn-primary" onClick={onExport} disabled={!selection.length || exporting}>
          <IconCode />
          {exporting ? 'Exporting…' : 'Export code'}
        </button>
      </footer>

      {open && snapshot && snapshot.bundle.roots.length > 0 && (
        <ResultSheet
          snapshot={snapshot}
          options={options}
          breakpoints={breakpoints}
          agent={agent}
          onClose={() => setOpen(false)}
          onReexport={onExport}
          stale={snapshot.density !== options.density}
        />
      )}
    </>
  );
}

function Chip(props: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
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

function OptionsCard({ options, set }: { options: ExportOptions; set: <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => void }) {
  return (
    <section className="glass card output-card">
      <div className="output-row">
        <span className="card-title">Format</span>
      </div>
      <Segmented
        options={[
          { value: 'html' as const, label: 'HTML' },
          { value: 'tailwind' as const, label: 'Tailwind' },
          { value: 'react' as const, label: 'React' },
          { value: 'react-tailwind' as const, label: 'React TW', title: 'React + Tailwind' },
        ]}
        value={options.format}
        onChange={(v) => set('format', v)}
        size="sm"
        ariaLabel="Output format"
      />
      <div className="output-row">
        <span className="card-title">Layout</span>
      </div>
      <Segmented
        options={[
          { value: 'fixed' as const, label: 'Fixed', title: 'Exact pixel sizes' },
          { value: 'fluid' as const, label: 'Fluid', title: 'Responsive widths from auto layout and constraints' },
          { value: 'scale' as const, label: 'Scale', title: 'Scales proportionally with the viewport' },
        ]}
        value={options.layout}
        onChange={(v) => set('layout', v)}
        size="sm"
        ariaLabel="Layout mode"
      />
      <p className="hint">
        {options.layout === 'fixed'
          ? 'Pixel-exact copy of the design.'
          : options.layout === 'fluid'
            ? 'Auto layout → flexbox, constraints → responsive positions; the frame width becomes a max-width.'
            : 'Every size is relative to the viewport width — looks identical at any screen size.'}
      </p>
      <div className="output-row wrap">
        <Segmented
          options={[1, 2, 3].map((v) => ({ value: v as 1 | 2 | 3, label: `@${v}x`, title: `Flattened images at ${v}× density` }))}
          value={options.density}
          onChange={(v) => set('density', v)}
          size="sm"
          ariaLabel="Image density"
        />
        <Chip
          label="Embed images"
          hint="Inline images as base64 (single file). Off: separate files in a zip, with srcset."
          on={options.images === 'embed'}
          onChange={(v) => set('images', v ? 'embed' : 'files')}
        />
        <Chip label="Variables" hint="Figma variables → CSS custom properties" on={options.useVariables} onChange={(v) => set('useVariables', v)} />
        <Chip label="Semantic tags" hint="button / h1 / nav… from layer names and links" on={options.semanticTags} onChange={(v) => set('semanticTags', v)} />
        {options.layout !== 'scale' && (
          <Chip label="rem" hint="Use rem instead of px" on={options.units === 'rem'} onChange={(v) => set('units', v ? 'rem' : 'px')} />
        )}
      </div>
      {(options.format === 'html' || options.format === 'react') && (
        <div className="output-row wrap">
          {options.format === 'html' && (
            <Segmented
              options={[
                { value: 'style-tag' as const, label: '<style>' },
                { value: 'external' as const, label: 'CSS file' },
                { value: 'inline' as const, label: 'Inline' },
              ]}
              value={options.cssMode}
              onChange={(v) => set('cssMode', v)}
              size="sm"
              ariaLabel="CSS placement"
            />
          )}
          <span className="spacer" />
          <input
            className="input px-input"
            placeholder="prefix-"
            aria-label="Class prefix"
            title="Class-name prefix"
            value={options.classPrefix}
            onChange={(e) => set('classPrefix', e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
          />
        </div>
      )}
    </section>
  );
}

function ResultSheet(props: {
  snapshot: Snapshot;
  options: ExportOptions;
  breakpoints?: Breakpoint[];
  agent: AgentSettings;
  stale: boolean;
  onClose: () => void;
  onReexport: () => void;
}) {
  const { snapshot, options, breakpoints, agent } = props;
  const { bundle } = snapshot;
  const title = bundle.roots[0]?.name ?? 'Export';

  const preview = useMemo<GenerateResult>(
    () => generate({ bundle, options, breakpoints, target: 'preview', title }),
    [bundle, options, breakpoints, title],
  );
  const download = useMemo<GenerateResult>(
    () => generate({ bundle, options, breakpoints, target: 'download', title }),
    [bundle, options, breakpoints, title],
  );

  const [tab, setTab] = useState<number>(-1); // -1 = preview
  const [width, setWidth] = useState(() => Math.round(bundle.roots[0]?.width ?? 1280));
  const [refine, setRefine] = useState<Refine>({ kind: 'idle' });
  const [showBefore, setShowBefore] = useState(false);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Options/breakpoints changed → the refined code no longer matches.
  useEffect(() => {
    abort.current?.abort();
    setRefine({ kind: 'idle' });
  }, [download]);

  const mainTab = download.tabs[0];
  const refined = refine.kind === 'done' ? refine.code : undefined;
  const tabContent = (i: number) => (i === 0 && refined ? refined : download.tabs[i]?.content ?? '');

  const previewDoc = useMemo(() => {
    if (refined && !showBefore && mainTab.lang === 'html') return inlineAssetPaths(refined, bundle);
    return preview.document;
  }, [refined, showBefore, mainTab, bundle, preview.document]);

  const meta = providerMeta(agent.provider);
  const usesBridge = meta.kind === 'cli';
  const ready = usesBridge ? !!agent.bridgeUrl && !!agent.bridgeToken : !!agent.apiKeys[agent.provider];

  const onRefine = useCallback(async () => {
    if (refine.kind === 'running') {
      abort.current?.abort();
      setRefine({ kind: 'idle' });
      return;
    }
    if (!ready) {
      setRefine({ kind: 'error', message: `Set up ${meta.label} in the AI tab first.` });
      return;
    }
    const { code, restore } = stripAssets(mainTab.content);
    const controller = new AbortController();
    abort.current = controller;
    setRefine({ kind: 'running', chars: 0 });
    let chars = 0;
    try {
      const text = await getProvider(agent.provider).generate({
        model: agent.model,
        system: buildRefinePrompt(mainTab.lang),
        messages: [{ role: 'user', content: `\`\`\`${mainTab.lang}\n${code}\n\`\`\`` }],
        apiKey: agent.apiKeys[agent.provider],
        bridgeUrl: agent.bridgeUrl,
        bridgeToken: agent.bridgeToken,
        signal: controller.signal,
        onText: (d) => {
          chars += d.length;
          setRefine({ kind: 'running', chars });
        },
      });
      if (controller.signal.aborted) return;
      setRefine({ kind: 'done', code: restore(extractCode(text)) });
      setShowBefore(false);
    } catch (e) {
      if (controller.signal.aborted) return;
      setRefine({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [refine.kind, ready, meta.label, mainTab, agent]);

  const onCopy = useCallback(async () => {
    const ok = await copyText(tab < 0 ? tabContent(0) : tabContent(tab));
    setCopied(ok);
    if (!ok) send({ type: 'NOTIFY', message: 'Copy failed — select the code and copy manually.', error: true });
    setTimeout(() => setCopied(false), 1500);
  }, [tab, download, refined]);

  const onDownload = useCallback(() => {
    const stem = slugify(title) || 'export';
    const mainPath = options.format.startsWith('react') ? download.files.find((f) => f.path.endsWith('.jsx'))?.path : 'index.html';
    const files = download.files.map((f) => (refined && f.path === mainPath ? { ...f, content: refined } : f));
    if (files.length === 1) downloadFile(`${stem}.html`, files[0].content as string, 'text/html');
    else downloadFile(`${stem}.zip`, zip(files), 'application/zip');
    send({ type: 'NOTIFY', message: files.length === 1 ? 'Saved HTML file' : `Saved ${files.length} files (zip)` });
  }, [title, options.format, download, refined]);

  const code = tab >= 0 ? forDisplay(tabContent(tab)) : '';
  const frameWidths = [...new Set(bundle.roots.map((r) => Math.round(r.width)))];
  const unmatched = download.report?.unmatched ?? [];

  return (
    <div className="overlay">
      <header className="sheet-head glass">
        <button className="icon-btn" onClick={props.onClose} title="Back">
          <IconBack />
        </button>
        <strong>Code</strong>
        <span className="muted">
          {download.stats.elements} el · {download.stats.classes} classes
        </span>
        <span className="spacer" />
        <button
          className="btn btn-glass btn-sm"
          onClick={onRefine}
          title={ready ? `Rewrite with ${meta.label} for semantic, readable code` : `Configure ${meta.label} in the AI tab`}
        >
          {refine.kind === 'running' ? <IconStop /> : <IconSparkle />}
          {refine.kind === 'running' ? `${(refine.chars / 1000).toFixed(1)}k` : refine.kind === 'done' ? 'Refine again' : 'Refine'}
        </button>
        <button className="btn btn-glass btn-sm" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn btn-primary btn-sm" onClick={onDownload}>
          Download
        </button>
      </header>

      <nav className="chips code-tabs">
        <button className={tab < 0 ? 'chip active' : 'chip'} onClick={() => setTab(-1)}>
          <IconEye /> Preview
        </button>
        {download.tabs.map((t, i) => (
          <button key={t.label} className={tab === i ? 'chip active' : 'chip'} onClick={() => setTab(i)}>
            {t.label}
            {i === 0 && refined ? ' ✦' : ''}
          </button>
        ))}
        <span className="spacer" />
        {tab < 0 &&
          [...PREVIEW_WIDTHS, ...frameWidths.filter((w) => !PREVIEW_WIDTHS.some((p) => p.value === w)).map((w) => ({ value: w, label: `${w}` }))].map(
            (p) => (
              <button
                key={p.value}
                className={width === p.value ? 'chip active' : 'chip'}
                onClick={() => setWidth(p.value)}
                title={`${p.value}px`}
              >
                {p.label}
              </button>
            ),
          )}
      </nav>

      {(props.stale || refine.kind === 'error' || refined) && (
        <div className="result-notes">
          {props.stale && (
            <p className="hint">
              Image density changed.{' '}
              <button className="text-link" onClick={props.onReexport}>
                Re-export
              </button>
            </p>
          )}
          {refine.kind === 'error' && <p className="hint err-text">{refine.message}</p>}
          {refined && (
            <p className="hint">
              Showing the AI-refined {mainTab.label}.{' '}
              {mainTab.lang === 'html' && (
                <button className="text-link" onClick={() => setShowBefore((v) => !v)}>
                  {showBefore ? 'Show refined' : 'Show original'}
                </button>
              )}{' '}
              <button className="text-link" onClick={() => setRefine({ kind: 'idle' })}>
                Revert
              </button>
            </p>
          )}
        </div>
      )}

      {tab < 0 ? <PreviewFrame html={previewDoc} width={width} /> : <pre className="code-pre">{code}</pre>}

      {(download.warnings.length > 0 || unmatched.length > 0) && (
        <Details
          title={`${download.warnings.length + (unmatched.length ? 1 : 0)} note${download.warnings.length + (unmatched.length ? 1 : 0) === 1 ? '' : 's'}`}
        >
          {unmatched.length > 0 && (
            <li className="warn-row">
              {download.report!.matched} layers matched across breakpoints; only in one frame: {unmatched.map((u) => u.name).join(', ')}.
              Rename layers to match if they should be shared.
            </li>
          )}
          {download.warnings.map((w, i) => (
            <li key={i} className="warn-row">
              {w.nodeId ? (
                <button className="text-link" onClick={() => send({ type: 'FOCUS_NODE', id: w.nodeId! })}>
                  {w.nodeName ?? w.nodeId}
                </button>
              ) : null}
              {w.nodeId ? ': ' : ''}
              {w.message}
            </li>
          ))}
        </Details>
      )}
    </div>
  );
}

function Details({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="notes glass">
      <button className="notes-head" onClick={() => setOpen((v) => !v)}>
        <IconChevron open={open} />
        {title}
      </button>
      {open && <ul className="notes-list">{children}</ul>}
    </section>
  );
}

function PreviewFrame({ html, width }: { html: string; width: number }) {
  const [frameH, setFrameH] = useState(800);
  const [paneW, setPaneW] = useState(560);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const measure = () => {
      if (stageRef.current) setPaneW(stageRef.current.clientWidth - 28);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const onLoad = useCallback((e: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = e.currentTarget;
    let n = 0;
    const tick = () => {
      try {
        const d = frame.contentDocument;
        const h = d ? Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight || 0) : 0;
        if (h > 0) setFrameH(h);
      } catch {
        /* cross-origin */
      }
      if (++n < 12) setTimeout(tick, 250);
    };
    tick();
  }, []);

  const scale = Math.min(1, paneW / width);
  return (
    <div className="overlay-body" ref={stageRef}>
      <div className="preview-scaler" style={{ width: width * scale, height: frameH * scale }}>
        <iframe
          className="preview-frame"
          title="Code preview"
          sandbox="allow-scripts allow-same-origin"
          srcDoc={html}
          onLoad={onLoad}
          style={{ width, height: frameH, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        />
      </div>
    </div>
  );
}
