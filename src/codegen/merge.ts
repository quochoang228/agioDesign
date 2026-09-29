/**
 * Responsive merge: several El trees (one per breakpoint frame, smallest first)
 * → a single DOM tree whose elements carry one declaration set per breakpoint.
 *
 * Children are matched between frames by layer name (unique names first, then
 * by occurrence order), then by content (identical text / SVG / image), then by
 * component. Elements that can't be matched — or whose content differs — are
 * kept as separate DOM nodes and hidden at the breakpoints where they don't
 * exist. A single frame is just the degenerate one-breakpoint case.
 */
import type { Decls } from './css';
import type { El } from './build';

export interface MEl {
  /** The element at each breakpoint (undefined = absent there). */
  slots: (El | undefined)[];
  children: MEl[];
  /** Assigned class name (undefined for bare text nodes / style-less elements). */
  cls?: string;
}

export interface MatchReport {
  matched: number;
  unmatched: { name: string; breakpoint: number }[];
}

const lastSlot = (slots: (El | undefined)[]): El => {
  for (let i = slots.length - 1; i >= 0; i--) if (slots[i]) return slots[i]!;
  throw new Error('empty merge slot');
};

export const firstSlot = (m: MEl): El => m.slots.find(Boolean)!;

function compatible(prev: El, next: El): boolean {
  if (prev.kind !== next.kind || prev.tag !== next.tag) return false;
  if (prev.kind === 'FRAME') return true;
  return prev.sig === next.sig;
}

const nameOf = (e: El) => e.node?.name ?? '';

function mergeNode(slots: (El | undefined)[], report: MatchReport): MEl {
  const m: MEl = { slots, children: [] };
  const first = slots.find(Boolean)!;

  // Text content is identical across slots (sig-checked), so align children by index.
  if (first.kind !== 'FRAME') {
    const len = first.children.length;
    for (let k = 0; k < len; k++) m.children.push(mergeNode(slots.map((s) => s?.children[k]), report));
    return m;
  }

  const entries: { slots: (El | undefined)[] }[] = [];
  const n = slots.length;
  slots.forEach((s, i) => {
    if (!s) return;
    const kids = s.children;
    const match = new Array<number>(kids.length).fill(-1);
    const taken = new Set<number>();
    const free = (e: number, k: El) => !taken.has(e) && !entries[e].slots[i] && compatible(lastSlot(entries[e].slots), k);
    const claim = (k: number, e: number) => {
      match[k] = e;
      taken.add(e);
    };

    // 1) names unique on both sides.
    const kidCount = new Map<string, number>();
    kids.forEach((k) => kidCount.set(nameOf(k), (kidCount.get(nameOf(k)) ?? 0) + 1));
    kids.forEach((k, ki) => {
      if (kidCount.get(nameOf(k)) !== 1) return;
      const cands = entries.map((_, e) => e).filter((e) => nameOf(lastSlot(entries[e].slots)) === nameOf(k) && free(e, k));
      if (cands.length === 1) claim(ki, cands[0]);
    });
    // 2) same name, paired in order.
    kids.forEach((k, ki) => {
      if (match[ki] >= 0) return;
      const e = entries.findIndex((en, ei) => nameOf(lastSlot(en.slots)) === nameOf(k) && free(ei, k));
      if (e >= 0) claim(ki, e);
    });
    // 3) identical content (text / svg / image) regardless of name.
    kids.forEach((k, ki) => {
      if (match[ki] >= 0 || k.kind === 'FRAME') return;
      const e = entries.findIndex((en, ei) => lastSlot(en.slots).sig === k.sig && free(ei, k));
      if (e >= 0) claim(ki, e);
    });
    // 4) same component, in order.
    kids.forEach((k, ki) => {
      const comp = k.node?.component;
      if (match[ki] >= 0 || !comp) return;
      const e = entries.findIndex((en, ei) => lastSlot(en.slots).node?.component === comp && free(ei, k));
      if (e >= 0) claim(ki, e);
    });

    // Assign, inserting unmatched kids right after their previous sibling.
    let cursor = -1;
    kids.forEach((k, ki) => {
      if (match[ki] >= 0) {
        entries[match[ki]].slots[i] = k;
        cursor = match[ki];
        if (i > 0) report.matched++;
        return;
      }
      const slotsNew = new Array<El | undefined>(n).fill(undefined);
      slotsNew[i] = k;
      const at = cursor + 1;
      entries.splice(at, 0, { slots: slotsNew });
      // Indices ≥ at shifted by one.
      for (let j = 0; j < match.length; j++) if (match[j] >= at) match[j]++;
      const shifted = new Set<number>();
      taken.forEach((t) => shifted.add(t >= at ? t + 1 : t));
      taken.clear();
      shifted.forEach((t) => taken.add(t));
      cursor = at;
    });
  });

  if (n > 1) {
    for (const e of entries) {
      const at = e.slots.findIndex(Boolean);
      if (e.slots.some((x) => !x)) report.unmatched.push({ name: nameOf(e.slots[at]!), breakpoint: at });
    }
  }

  // Where a breakpoint orders flex children differently from the DOM, add `order`.
  slots.forEach((s, i) => {
    if (!s || s.decls.display !== 'flex') return;
    const present = entries.filter((e) => e.slots[i]);
    const idx = present.map((e) => s.children.indexOf(e.slots[i]!));
    const sorted = idx.every((v, j) => j === 0 || v > idx[j - 1]);
    if (!sorted) present.forEach((e, j) => (e.slots[i]!.decls.order = String(idx[j])));
  });

  m.children = entries.map((e) => mergeNode(e.slots, report));
  return m;
}

export function mergeTrees(roots: El[]): { tree: MEl; report: MatchReport } {
  const report: MatchReport = { matched: 0, unmatched: [] };
  return { tree: mergeNode(roots, report), report };
}

/* ---------------- class names ---------------- */

export class ClassNamer {
  private bySig = new Map<string, string>();
  private used = new Map<string, number>();

  assign(m: MEl): void {
    const el = firstSlot(m);
    if (el.kind !== 'TEXTNODE') {
      const hasStyle = m.slots.some((s) => s && Object.keys(s.decls).length);
      const absent = m.slots.some((s) => !s);
      if (hasStyle || absent) {
        const sig = el.tag + JSON.stringify(m.slots.map((s) => (s ? s.decls : null)));
        let cls = this.bySig.get(sig);
        if (!cls) {
          const stem = el.name || 'el';
          const n = (this.used.get(stem) ?? 0) + 1;
          this.used.set(stem, n);
          cls = n === 1 ? stem : `${stem}-${n}`;
          this.bySig.set(sig, cls);
        }
        m.cls = cls;
      }
    }
    m.children.forEach((c) => this.assign(c));
  }
}

/* ---------------- cascade ---------------- */

const INLINE = new Set(['span', 'a']);

function defaultDisplay(tag: string): string {
  if (INLINE.has(tag)) return 'inline';
  if (tag === 'button') return 'inline-block';
  return 'block';
}

/**
 * Per-breakpoint declaration deltas for one element: index 0 is the full base
 * style, later entries only what changes at that min-width (with resets for
 * properties that go away, and display:none where the element is absent).
 */
export function cascade(m: MEl): Decls[] {
  const tag = firstSlot(m).tag;
  const out: Decls[] = [];
  let state: Decls | null = null;
  m.slots.forEach((s, i) => {
    const delta: Decls = {};
    if (!s) {
      if (i === 0 || state?.display !== 'none') delta.display = 'none';
      state = { ...(state ?? {}), display: 'none' };
    } else if (i === 0 || !state) {
      Object.assign(delta, s.decls);
      state = { ...s.decls };
    } else {
      for (const [k, v] of Object.entries(s.decls)) if (state[k] !== v) delta[k] = v;
      for (const k of Object.keys(state)) {
        if (k in s.decls) continue;
        delta[k] = k === 'display' ? defaultDisplay(tag) : k === 'position' ? 'static' : 'unset';
      }
      state = { ...s.decls };
    }
    out.push(delta);
  });
  return out;
}
