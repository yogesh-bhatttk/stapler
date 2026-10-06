/**
 * DIST-03 / DIST-08 — the one template every landing page is rendered from
 * (`./pages.ts` holds the text). Runs at build time and in the dev server, in
 * Node, through the `stapler:landing-pages` Vite plugin; never in a browser.
 *
 * The output is laid out the way Prettier lays out HTML at the repo's
 * `printWidth` (an element stays on one line if it fits, otherwise its text is
 * filled across indented lines), so a rendered page reads like a hand-written
 * one in view-source and the build output matches the files it replaced.
 */
import { LANDING_PAGES, SITE_ORIGIN, type LandingPage } from './pages.ts';

const PRINT_WIDTH = 100;

/** Text content. A bare `&` followed by a space ("sign & fill") is valid HTML and left as is. */
function escapeText(text: string): string {
  return text.replace(/&(?=[#A-Za-z0-9])/g, '&amp;').replace(/</g, '&lt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

const pad = (indent: number): string => ' '.repeat(indent);

/** Greedy word fill at `indent`, as Prettier fills inline text. */
function fill(indent: number, text: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && indent + next.length > PRINT_WIDTH) {
      lines.push(pad(indent) + line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(pad(indent) + line);
  return lines;
}

/** `<open>text</close>` on one line if it fits, else open / filled text / close. */
function element(indent: number, open: string, text: string, close: string): string[] {
  const body = escapeText(text);
  const oneLine = `${pad(indent)}${open}${body}${close}`;
  if (oneLine.length <= PRINT_WIDTH) return [oneLine];
  return [pad(indent) + open, ...fill(indent + 2, body), pad(indent) + close];
}

/** A void tag (`<meta … />`), with one attribute per line if it does not fit on one. */
function voidTag(indent: number, name: string, attrs: readonly [string, string][]): string[] {
  const rendered = attrs.map(([key, value]) => `${key}="${escapeAttr(value)}"`);
  const oneLine = `${pad(indent)}<${name} ${rendered.join(' ')} />`;
  if (oneLine.length <= PRINT_WIDTH) return [oneLine];
  return [
    `${pad(indent)}<${name}`,
    ...rendered.map(attr => pad(indent + 2) + attr),
    `${pad(indent)}/>`
  ];
}

export const pageUrl = (slug: string): string => `${SITE_ORIGIN}/${slug}`;

/** WebApplication + FAQPage structured data, for pages that have an FAQ. */
function jsonLd(page: LandingPage): string[] {
  if (!page.faq) return [];
  const data = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: page.name,
      url: pageUrl(page.slug),
      description: page.description,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Any (runs in the browser)',
      browserRequirements: 'Requires JavaScript',
      isAccessibleForFree: true,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map(({ question, answer }) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer }
      }))
    }
  ];
  // `<` is escaped so no string can close the script element early.
  const json = JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
  return [
    '    <script type="application/ld+json">',
    ...json.split('\n').map(line => pad(6) + line),
    '    </script>'
  ];
}

function cta(page: LandingPage): string[] {
  if (page.cta === 'use-now') {
    return [
      '        <div class="landingCtaRow">',
      '          <a class="landingCtaPrimary" href="#tool">Use it now, no install needed</a>',
      '        </div>'
    ];
  }
  return [
    '        <div class="landingCtaRow">',
    '          <button type="button" class="landingCtaPrimary" disabled>',
    '            Install from the Chrome Web Store — coming soon',
    '          </button>',
    '          <a class="landingCtaSecondary" href="#tool">Use it now, no install needed</a>',
    '        </div>'
  ];
}

function sizeLinks(page: LandingPage): string[] {
  if (!page.sizeLinks) return [];
  return [
    '    <nav class="landingCtaRow" aria-label="Other target sizes">',
    ...page.sizeLinks.map(
      ({ slug, label }) =>
        `      <a class="landingCtaSecondary" href="/${escapeAttr(slug)}">${escapeText(label)}</a>`
    ),
    '    </nav>',
    ''
  ];
}

/** The full HTML document for one landing page. */
export function renderLandingPage(page: LandingPage): string {
  const title = `${page.name} — Stapler`;
  const bodyAttrs = Object.entries(page.bodyAttrs ?? {})
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('');
  const lines = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `    <title>${escapeText(title)}</title>`,
    ...voidTag(4, 'meta', [
      ['name', 'description'],
      ['content', page.description]
    ]),
    ...voidTag(4, 'link', [
      ['rel', 'canonical'],
      ['href', pageUrl(page.slug)]
    ]),
    '    <meta property="og:type" content="website" />',
    ...voidTag(4, 'meta', [
      ['property', 'og:title'],
      ['content', title]
    ]),
    ...voidTag(4, 'meta', [
      ['property', 'og:description'],
      ['content', page.ogDescription]
    ]),
    '    <link rel="icon" href="/icons/icon-32.png" />',
    ...jsonLd(page),
    '  </head>',
    `  <body${bodyAttrs}>`,
    ...element(
      4,
      '<a class="landingSkipLink" href="#tool">',
      `Skip to the ${page.skipLabel} tool`,
      '</a>'
    ),
    '',
    '    <header class="landingHero">',
    '      <div class="landingHeroInner">',
    '        <p class="landingEyebrow">Stapler · Offline PDF tools</p>',
    ...element(8, '<h1 class="landingTitle">', page.h1, '</h1>'),
    ...element(8, '<p class="landingSubtitle">', page.intro, '</p>'),
    ...cta(page),
    ...element(8, '<p class="landingCtaNote">', page.ctaNote, '</p>'),
    '      </div>',
    '    </header>',
    '',
    '    <ul class="landingFeatures">',
    ...page.points.flatMap(point => [
      '      <li class="landingFeatureCard">',
      ...element(8, '<h2 class="landingFeatureTitle">', point.title, '</h2>'),
      ...element(8, '<p class="landingFeatureBody">', point.body, '</p>'),
      '      </li>'
    ]),
    '    </ul>',
    '',
    ...sizeLinks(page),
    '    <section class="landingAppSection">',
    ...element(6, '<h2 class="landingAppHeading" id="tool">', page.appHeading, '</h2>'),
    '      <div id="app"></div>',
    '    </section>',
    '',
    '    <noscript>',
    "      Stapler's tools run in your browser and need JavaScript enabled to work. Everything still runs",
    '      locally — nothing is ever sent to a server.',
    '    </noscript>',
    '',
    `    <script type="module" src="/src/ui/landing/${escapeAttr(page.entry)}.entry.ts"></script>`,
    '  </body>',
    '</html>',
    ''
  ];
  return lines.join('\n');
}

/** `sitemap.xml` for the website twin: the root, then every landing page. */
export function renderSitemap(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${SITE_ORIGIN}/</loc></url>`,
    ...LANDING_PAGES.map(page => `  <url><loc>${pageUrl(page.slug)}</loc></url>`),
    '</urlset>',
    ''
  ].join('\n');
}
