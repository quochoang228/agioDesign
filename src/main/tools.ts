/**
 * Sandbox-side Figma tools the AI agent can call (Phase 4). The UI runs the
 * agent loop and forwards each tool call here over `postMessage` (EXEC_TOOL);
 * only the sandbox has the Figma API, so all canvas reads/writes happen here.
 *
 * `documentAccess: dynamic-page` requires async node lookups — use
 * `figma.getNodeByIdAsync`, not the deprecated sync getter.
 */

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

function rgbFromHex(hex: string): RGB {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** Resolve scene nodes by id, falling back to the current selection. */
async function nodesByIds(ids?: string[]): Promise<SceneNode[]> {
  if (Array.isArray(ids) && ids.length) {
    const out: SceneNode[] = [];
    for (const id of ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (n && n.type !== 'PAGE' && n.type !== 'DOCUMENT') out.push(n as SceneNode);
    }
    return out;
  }
  return [...figma.currentPage.selection];
}

function describe(n: SceneNode): Record<string, unknown> {
  const d: Record<string, unknown> = { id: n.id, name: n.name, type: n.type };
  if ('width' in n) {
    d.width = Math.round(n.width);
    d.height = Math.round(n.height);
  }
  if ('x' in n) {
    d.x = Math.round(n.x);
    d.y = Math.round(n.y);
  }
  return d;
}

function hasXY(n: SceneNode): n is SceneNode & LayoutMixin {
  return 'x' in n && 'width' in n;
}

export async function executeTool(name: string, args: any): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_selection': {
        const sel = figma.currentPage.selection;
        return { ok: true, result: { count: sel.length, nodes: sel.map(describe) } };
      }

      case 'get_page_summary': {
        const all = figma.currentPage.children;
        return {
          ok: true,
          result: {
            page: figma.currentPage.name,
            count: all.length,
            nodes: all.slice(0, 200).map((n) => {
              const d = describe(n);
              if ('children' in n) d.children = (n as ChildrenMixin).children.length;
              return d;
            }),
          },
        };
      }

      case 'get_design_system': {
        const [paints, texts] = await Promise.all([
          figma.getLocalPaintStylesAsync(),
          figma.getLocalTextStylesAsync(),
        ]);
        const comps = figma.currentPage.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
        return {
          ok: true,
          result: {
            paintStyles: paints.slice(0, 100).map((s) => ({ id: s.id, name: s.name })),
            textStyles: texts.slice(0, 100).map((s) => ({ id: s.id, name: s.name })),
            components: comps.slice(0, 100).map((c) => ({ id: c.id, name: c.name })),
          },
        };
      }

      case 'rename_nodes': {
        const renames: { id: string; name: string }[] = args?.renames || [];
        let done = 0;
        for (const r of renames) {
          const n = await figma.getNodeByIdAsync(r?.id);
          if (n && typeof r?.name === 'string') {
            (n as BaseNode & { name: string }).name = r.name;
            done++;
          }
        }
        return { ok: true, result: { renamed: done } };
      }

      case 'set_auto_layout': {
        const n = await figma.getNodeByIdAsync(args?.id);
        if (!n || !('layoutMode' in n)) {
          return { ok: false, error: 'Node not found or does not support auto layout.' };
        }
        const f = n as FrameNode;
        f.layoutMode = args?.direction === 'HORIZONTAL' ? 'HORIZONTAL' : 'VERTICAL';
        if (typeof args?.itemSpacing === 'number') f.itemSpacing = args.itemSpacing;
        const p = args?.padding;
        if (typeof p === 'number') {
          f.paddingTop = f.paddingBottom = f.paddingLeft = f.paddingRight = p;
        } else if (p && typeof p === 'object') {
          if (typeof p.top === 'number') f.paddingTop = p.top;
          if (typeof p.right === 'number') f.paddingRight = p.right;
          if (typeof p.bottom === 'number') f.paddingBottom = p.bottom;
          if (typeof p.left === 'number') f.paddingLeft = p.left;
        }
        if (args?.primaryAxisAlign) f.primaryAxisAlignItems = args.primaryAxisAlign;
        if (args?.counterAxisAlign) f.counterAxisAlignItems = args.counterAxisAlign;
        return { ok: true, result: { id: f.id, layoutMode: f.layoutMode } };
      }

      case 'align_nodes': {
        const nodes = (await nodesByIds(args?.ids)).filter(hasXY);
        if (!nodes.length) return { ok: false, error: 'No movable nodes to align.' };
        const minX = Math.min(...nodes.map((n) => n.x));
        const maxR = Math.max(...nodes.map((n) => n.x + n.width));
        const minY = Math.min(...nodes.map((n) => n.y));
        const maxB = Math.max(...nodes.map((n) => n.y + n.height));
        for (const n of nodes) {
          switch (args?.axis) {
            case 'left': n.x = minX; break;
            case 'right': n.x = maxR - n.width; break;
            case 'center-x': n.x = (minX + maxR) / 2 - n.width / 2; break;
            case 'top': n.y = minY; break;
            case 'bottom': n.y = maxB - n.height; break;
            case 'center-y': n.y = (minY + maxB) / 2 - n.height / 2; break;
          }
        }
        if (args?.distribute === 'horizontal' && nodes.length > 2) {
          const s = [...nodes].sort((a, b) => a.x - b.x);
          const gap = (maxR - minX - s.reduce((t, n) => t + n.width, 0)) / (s.length - 1);
          let cur = minX;
          for (const n of s) { n.x = cur; cur += n.width + gap; }
        } else if (args?.distribute === 'vertical' && nodes.length > 2) {
          const s = [...nodes].sort((a, b) => a.y - b.y);
          const gap = (maxB - minY - s.reduce((t, n) => t + n.height, 0)) / (s.length - 1);
          let cur = minY;
          for (const n of s) { n.y = cur; cur += n.height + gap; }
        }
        return { ok: true, result: { aligned: nodes.length, axis: args?.axis ?? null } };
      }

      case 'set_fill': {
        const nodes = await nodesByIds(args?.ids);
        const color = typeof args?.color === 'string' ? rgbFromHex(args.color) : (args?.color as RGB);
        if (!color || typeof color.r !== 'number') {
          return { ok: false, error: 'Provide color as "#rrggbb".' };
        }
        const opacity = typeof args?.opacity === 'number' ? args.opacity : 1;
        let done = 0;
        for (const n of nodes) {
          if ('fills' in n) {
            (n as GeometryMixin).fills = [{ type: 'SOLID', color, opacity }];
            done++;
          }
        }
        return { ok: true, result: { filled: done } };
      }

      // Internal: place generated image bytes (called by the UI, not the model).
      case 'place_image': {
        const bytes = args?.bytes;
        if (!(bytes instanceof Uint8Array) || !bytes.length) return { ok: false, error: 'No image bytes.' };
        const image = figma.createImage(bytes);
        const fill: ImagePaint = { type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash };
        if (args?.targetId) {
          const n = await figma.getNodeByIdAsync(args.targetId);
          if (n && 'fills' in n) {
            (n as GeometryMixin).fills = [fill];
            return { ok: true, result: { filled: args.targetId } };
          }
          return { ok: false, error: 'Target node not found or cannot hold an image fill.' };
        }
        const rect = figma.createRectangle();
        rect.name = typeof args?.name === 'string' ? args.name : 'Generated image';
        rect.resize(Math.max(1, args?.width || 1024), Math.max(1, args?.height || 1024));
        rect.fills = [fill];
        rect.x = Math.round(figma.viewport.center.x - rect.width / 2);
        rect.y = Math.round(figma.viewport.center.y - rect.height / 2);
        figma.currentPage.appendChild(rect);
        figma.currentPage.selection = [rect];
        figma.viewport.scrollAndZoomIntoView([rect]);
        return { ok: true, result: { id: rect.id } };
      }

      case 'set_text': {
        const n = await figma.getNodeByIdAsync(args?.id);
        if (!n || n.type !== 'TEXT') return { ok: false, error: 'Node is not a TEXT node.' };
        const t = n as TextNode;
        if (t.fontName === figma.mixed) {
          return { ok: false, error: 'Text node has mixed fonts; cannot set in one call.' };
        }
        await figma.loadFontAsync(t.fontName as FontName);
        t.characters = String(args?.characters ?? '');
        return { ok: true, result: { id: t.id } };
      }

      default:
        return { ok: false, error: `Unknown tool "${name}".` };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
