/**
 * DIST-03 / DIST-08 — the landing pages are rendered from `src/landing/pages.ts`
 * at build time, so nothing on disk can be opened to check them; this checks the
 * render instead. (The output bytes were compared against the hand-written files
 * these replaced when they were removed; see DIST-03's 2026-10-06 note.)
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { COMPRESS_TARGET_SIZES, LANDING_PAGES, SITE_ORIGIN } from '../../src/landing/pages';
import { renderLandingPage, renderSitemap } from '../../src/landing/template';

const ROOT = path.resolve(__dirname, '../..');

describe('landing pages', () => {
  it('have unique slugs and an entry script that exists', () => {
    const slugs = LANDING_PAGES.map(page => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const page of LANDING_PAGES) {
      expect(existsSync(path.join(ROOT, `src/ui/landing/${page.entry}.entry.ts`)), page.slug).toBe(
        true
      );
      // A root `.html` file would shadow the generated page.
      expect(existsSync(path.join(ROOT, `${page.slug}.html`)), page.slug).toBe(false);
    }
  });

  it('render their own title, canonical, h1 and entry script', () => {
    for (const page of LANDING_PAGES) {
      const html = renderLandingPage(page);
      expect(html.startsWith('<!doctype html>\n')).toBe(true);
      expect(html).toContain(`<title>${page.name} — Stapler</title>`);
      expect(html).toContain(`<link rel="canonical" href="${SITE_ORIGIN}/${page.slug}" />`);
      expect(html).toContain(`<h1 class="landingTitle">${page.h1}</h1>`);
      expect(html).toContain(`src="/src/ui/landing/${page.entry}.entry.ts"`);
      expect(html.includes('application/ld+json')).toBe(page.faq !== undefined);
    }
  });

  it('give each fixed compress size its target and links to the other sizes', () => {
    for (const size of COMPRESS_TARGET_SIZES) {
      const page = LANDING_PAGES.find(candidate => candidate.slug === size.slug);
      expect(page, size.slug).toBeDefined();
      const html = renderLandingPage(page!);
      expect(html).toContain(`<body data-compress-target="${size.target}">`);
      expect(html).not.toContain(`href="/${size.slug}"`);
      for (const other of COMPRESS_TARGET_SIZES.filter(candidate => candidate !== size)) {
        expect(html).toContain(`href="/${other.slug}">${other.label}</a>`);
      }
    }
  });

  it('are all in the sitemap, after the site root', () => {
    const locs = [...renderSitemap().matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
    expect(locs).toEqual([
      `${SITE_ORIGIN}/`,
      ...LANDING_PAGES.map(page => `${SITE_ORIGIN}/${page.slug}`)
    ]);
  });

  it('are build inputs of the web target only', async () => {
    const { default: factory } = (await import('../../vite.config')) as unknown as {
      default: () => { build: { rollupOptions: { input: Record<string, string> } } };
    };
    const inputs = (target: string) => {
      const previous = process.env.BUILD_TARGET;
      process.env.BUILD_TARGET = target;
      try {
        return factory().build.rollupOptions.input;
      } finally {
        if (previous === undefined) delete process.env.BUILD_TARGET;
        else process.env.BUILD_TARGET = previous;
      }
    };
    const web = inputs('web');
    for (const page of LANDING_PAGES) {
      expect(web[page.slug]).toBe(path.join(ROOT, `${page.slug}.html`));
    }
    expect(Object.keys(inputs('ext')).sort()).toEqual(['background', 'editor']);
    expect(Object.keys(inputs('firefox')).sort()).toEqual(['background', 'editor']);
  });
});
