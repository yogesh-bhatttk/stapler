/**
 * GAP-4 / GAP-5 — applies tool parameters carried in a link, then removes them.
 *
 * `#/tool/compress?target=100KB` pre-fills Compress in "Aim for a size" mode;
 * `#/tool/image-to-size?target=20KB&max=600` and
 * `#/tool/pdf-to-img?target=200KB&max=1600` do the same for the image tools.
 * The landing pages (`compress-pdf-to-100kb.html` …) build exactly these links,
 * and the extension editor accepts them too, because both builds route on the
 * hash. Parsing and clamping are in `core/deep-link.ts`; garbage is ignored.
 *
 * The query is stripped from the address once applied (a `replace`, not a new
 * history entry), so a reload, a Back, or returning to the tool later never
 * re-applies it over what the person has since typed.
 */
import { useEffect } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import {
  IMAGE_TARGET_BOUNDS,
  PDF_TARGET_BOUNDS,
  parseMaxDimensionParam,
  parseSizeParam,
  readToolLink,
  sizeParamBytes
} from '../core/deep-link';
import { compressMode, compressTarget } from './tools/compress/state';
import { pdfToImageSettings } from './tools/state';
import { imageSizeSettings } from './tools/image-size/state';

/** Keys this module consumes, and so strips from a real query string. */
const LINK_KEYS = ['target', 'max', 'mode'] as const;

/** Applies `params` to the named tool. Returns true when anything was applied. */
export function applyToolParams(toolId: string | null, params: URLSearchParams): boolean {
  switch (toolId) {
    case 'compress': {
      const target = parseSizeParam(params.get('target'), PDF_TARGET_BOUNDS);
      if (target) {
        compressTarget.value = { amount: target.amount, unit: target.unit };
        compressMode.value = 'target';
        return true;
      }
      const mode = params.get('mode');
      if (mode === 'target' || mode === 'quality') {
        compressMode.value = mode;
        return true;
      }
      return false;
    }
    case 'pdf-to-img': {
      const target = parseSizeParam(params.get('target'), IMAGE_TARGET_BOUNDS);
      const max = parseMaxDimensionParam(params.get('max'));
      if (!target && max === null) return false;
      const current = pdfToImageSettings.value;
      pdfToImageSettings.value = {
        ...current,
        ...(target
          ? {
              sizeMode: 'target' as const,
              format: 'jpeg' as const,
              targetKb: Math.round(sizeParamBytes(target) / 1000)
            }
          : {}),
        ...(max !== null ? { maxDimension: max } : {})
      };
      return true;
    }
    case 'image-to-size': {
      const target = parseSizeParam(params.get('target'), IMAGE_TARGET_BOUNDS);
      const max = parseMaxDimensionParam(params.get('max'));
      if (!target && max === null) return false;
      const current = imageSizeSettings.value;
      imageSizeSettings.value = {
        ...current,
        ...(target ? { useTarget: true, target } : {}),
        ...(max !== null ? { maxDimension: max } : {})
      };
      return true;
    }
    default:
      return false;
  }
}

/** Removes the consumed keys from the page's real query string, if any are there. */
function stripPageSearch(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of LINK_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) window.history.replaceState(window.history.state, '', url.href);
}

/** Mount once inside the router. Renders nothing. */
export function ToolLinkParams(): null {
  const [location, navigate] = useLocation();
  useEffect(() => {
    const link = readToolLink(location, window.location.search);
    if (!link.toolId) return;
    applyToolParams(link.toolId, link.params);
    stripPageSearch();
    if (link.hashHadQuery) navigate(link.path, { replace: true });
  }, [location]);
  return null;
}
