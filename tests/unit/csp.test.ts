import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cspModule from '../../scripts/csp.mjs';

/**
 * Audit 2026-09-25 PLT-3 / PLT-4 — one CSP, shipped three ways (the extension
 * manifest, the web build's injected `<meta>`, and the unbundled privacy
 * page), plus two copies of its allowlist (`scripts/csp.mjs` and the
 * zero-dependency `.claude/hooks/check-invariants.mjs`). This file is what
 * keeps them from drifting apart.
 */
const { STAPLER_CSP, CSP_DIRECTIVES, OCR_MODEL_CONNECT_SOURCES, cspFindings } = cspModule as {
  STAPLER_CSP: string;
  CSP_DIRECTIVES: Record<string, string[]>;
  OCR_MODEL_CONNECT_SOURCES: string[];
  cspFindings: (csp: string) => string[];
};

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

describe('CSP', () => {
  it('the manifest ships exactly the shared policy', () => {
    const manifest = JSON.parse(read('public/manifest.json'));
    expect(manifest.content_security_policy.extension_pages).toBe(STAPLER_CSP);
    expect(cspFindings(STAPLER_CSP)).toEqual([]);
  });

  it('the privacy page carries a policy at least as strict, with no remote source', () => {
    const html = read('public/privacy.html');
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
    expect(csp).toBeTruthy();
    expect(cspFindings(csp!)).toEqual([]);
    expect(csp).not.toMatch(/https?:/);
    expect(csp).toContain("default-src 'self'");
  });

  it('refuses a bare CDN host, a remote source outside connect-src, and a missing default-src', () => {
    expect(
      cspFindings(STAPLER_CSP.replace(OCR_MODEL_CONNECT_SOURCES[0], 'https://cdn.jsdelivr.net'))
    ).not.toEqual([]);
    expect(cspFindings(`${STAPLER_CSP} img-src https://evil.example;`)).not.toEqual([]);
    expect(cspFindings(STAPLER_CSP.replace("default-src 'self'; ", ''))).not.toEqual([]);
    expect(
      cspFindings(STAPLER_CSP.replace("'wasm-unsafe-eval'", "'wasm-unsafe-eval' 'unsafe-eval'"))
    ).not.toEqual([]);
  });

  it('allows exactly the pinned OCR model directories the downloader requests', async () => {
    const { OCR_LANGUAGES, splitLangCodes, resolveModelUrl, setModelBaseOverride } =
      await import('../../src/core/ocr/model');
    setModelBaseOverride(null);
    const codes = [...new Set(OCR_LANGUAGES.flatMap(lang => splitLangCodes(lang.code)))];
    const urls = codes.map(code => resolveModelUrl(code));
    // Every URL the downloader can build is covered by one allowed prefix…
    for (const url of urls) {
      expect(
        OCR_MODEL_CONNECT_SOURCES.some(prefix => url.startsWith(prefix)),
        url
      ).toBe(true);
    }
    // …and every allowed prefix is actually used, so nothing stale lingers.
    for (const prefix of OCR_MODEL_CONNECT_SOURCES) {
      expect(
        urls.some(url => url.startsWith(prefix)),
        prefix
      ).toBe(true);
      expect(prefix.endsWith('/')).toBe(true);
    }
  });

  it('the invariant hook duplicates the same allowlist', () => {
    const hook = read('.claude/hooks/check-invariants.mjs');
    const block = /const CSP_ALLOWED_SOURCES = (\{[\s\S]*?\n\});/.exec(hook)?.[1];
    expect(block).toBeTruthy();
    // The block is a plain object literal of string arrays; evaluate it as data.
    const hookAllowlist = new Function(`return ${block};`)() as Record<string, string[]>;
    expect(hookAllowlist).toEqual(CSP_DIRECTIVES);
  });
});

describe('web build CSP meta (PLT-4)', () => {
  it('is injected by the web target and not the extension targets', async () => {
    const configModule = await import('../../vite.config');
    const factory = configModule.default as unknown as () => { plugins: { name?: string }[] };
    const names = (target: string | undefined) => {
      const previous = process.env.BUILD_TARGET;
      if (target === undefined) delete process.env.BUILD_TARGET;
      else process.env.BUILD_TARGET = target;
      try {
        return factory()
          .plugins.flat()
          .map(plugin => plugin?.name);
      } finally {
        if (previous === undefined) delete process.env.BUILD_TARGET;
        else process.env.BUILD_TARGET = previous;
      }
    };
    expect(names(undefined)).toContain('stapler:web-csp');
    expect(names('web')).toContain('stapler:web-csp');
    expect(names('ext')).not.toContain('stapler:web-csp');
    expect(names('firefox')).not.toContain('stapler:web-csp');
  });

  it('emits the shared policy as the first <head> element', async () => {
    const { webCspMeta } = await import('../../vite.config');
    const plugin = webCspMeta();
    const hook = plugin.transformIndexHtml as {
      order: string;
      handler: () => { tag: string; attrs: Record<string, string>; injectTo: string }[];
    };
    const [tag] = hook.handler();
    expect(tag.tag).toBe('meta');
    expect(tag.attrs['http-equiv']).toBe('Content-Security-Policy');
    expect(tag.attrs.content).toBe(STAPLER_CSP);
    expect(tag.injectTo).toBe('head-prepend');
  });
});
