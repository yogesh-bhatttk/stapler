/**
 * DIST-03 / DIST-08 — the website twin's per-tool landing pages, as data.
 *
 * This is the single source of every landing page's text. There are no landing
 * `.html` files in the repo: the `stapler:landing-pages` Vite plugin
 * (`vite.config.ts`) renders each entry below with `renderLandingPage`
 * (`./template.ts`) as a virtual `<root>/<slug>.html` module, so `pnpm build:web`
 * emits `dist/web/<slug>.html` and `pnpm dev` serves `/<slug>.html`. The
 * extension build never sees them.
 *
 * Kept free of imports and of non-erasable TypeScript, so Node can load it
 * directly (`scripts/check-invariants.mjs` scans the rendered pages).
 */

export const SITE_ORIGIN = 'https://stapler.app';

/** One card in the three-up feature row under the hero. */
export interface LandingPoint {
  readonly title: string;
  readonly body: string;
}

/** One question of the page's FAQPage structured data. */
export interface LandingFaq {
  readonly question: string;
  readonly answer: string;
}

export interface LandingPage {
  /** URL path and file name: `/<slug>` is served from `<slug>.html`. */
  readonly slug: string;
  /** The tool's name; `<title>` and `og:title` are `${name} — Stapler`. */
  readonly name: string;
  /** `<meta name="description">`, and the WebApplication description when there is an FAQ. */
  readonly description: string;
  readonly ogDescription: string;
  /** Completes "Skip to the … tool". */
  readonly skipLabel: string;
  readonly h1: string;
  readonly intro: string;
  /**
   * `install`: the disabled Chrome Web Store button plus a secondary "use it now"
   * link. `use-now`: the "use it now" link alone, as the primary call to action.
   */
  readonly cta: 'install' | 'use-now';
  readonly ctaNote: string;
  readonly points: readonly LandingPoint[];
  /** "Other target sizes" links between the features and the tool. */
  readonly sizeLinks?: readonly { readonly slug: string; readonly label: string }[];
  /** The heading directly above the embedded tool (`#tool`). */
  readonly appHeading: string;
  /** When present, the page carries WebApplication + FAQPage JSON-LD. */
  readonly faq?: readonly LandingFaq[];
  /** The page's script: `src/ui/landing/<entry>.entry.ts`. */
  readonly entry: string;
  /** Extra `<body>` attributes the entry script reads. */
  readonly bodyAttrs?: Readonly<Record<string, string>>;
}

const WORKS_ON_THIS_PAGE = 'Works fully on this page. No upload, no account, no daily limit.';

/** CNV-08..13: the same first and last card on all six converter pages. */
const convertNothingLeaves: LandingPoint = {
  title: 'Nothing leaves your device',
  body: "No uploads, no account, no telemetry. Open DevTools' Network tab and watch it stay empty while you convert."
};
const convertPreview = (output: string): LandingPoint => ({
  title: 'See it before you save',
  body: `Every conversion opens in a full preview before you commit to the ${output}, so you can check what carried over and what didn't.`
});
const convertNoPdfRequired = (input: string): LandingPoint => ({
  title: 'No PDF required',
  body: `Pick a ${input} straight from your device. There's nothing to open first — the file you're converting is the input.`
});

// ---------------------------------------------------------------------------
// DIST-08 / GAP-4 — "compress PDF to X" pages. The fixed sizes share one copy,
// written once below; the pick-your-own page differs only where it has to.

/** The fixed targets, in the order they are linked and listed in the sitemap. */
export const COMPRESS_TARGET_SIZES = [
  { slug: 'compress-pdf-to-100kb', label: '100 KB', target: '100KB' },
  { slug: 'compress-pdf-to-200kb', label: '200 KB', target: '200KB' },
  { slug: 'compress-pdf-to-500kb', label: '500 KB', target: '500KB' },
  { slug: 'compress-pdf-to-1mb', label: '1 MB', target: '1MB' }
] as const;

const CUSTOM_SIZE_SLUG = 'compress-pdf-to-size';

const sizeMeasured: LandingPoint = {
  title: 'Measured, not guessed',
  body: 'Every attempt is a real re-encode. The size Stapler reports is the size of the file you save — never an estimate.'
};
const sizeHonest = (target: string): LandingPoint => ({
  title: 'Honest when it cannot',
  body: `Scans and photos usually shrink a long way. A document that is mostly text and embedded fonts may not reach ${target} — Stapler tells you instead of degrading it into something unreadable.`
});
const sizeNothingLeaves: LandingPoint = {
  title: 'Nothing leaves your device',
  body: 'Compression runs in a worker on this page. No upload, no account, no daily limit.'
};
const sizeFaqAnswer = (target: string): string =>
  `No. Stapler re-encodes images and scanned pages at progressively lower resolution and quality, measuring each attempt. When even the lowest setting it will use is still over ${target}, it tells you the smallest size it reached and lets you decide whether to save that file or keep the original.`;
const sizeFaqUpload: LandingFaq = {
  question: 'Is my PDF uploaded anywhere?',
  answer:
    'No. Compression runs in your browser, on this page. The file never leaves your device, and there is no account or daily limit.'
};

const fixedSizePage = (size: (typeof COMPRESS_TARGET_SIZES)[number]): LandingPage => ({
  slug: size.slug,
  name: `Compress PDF to ${size.label}`,
  description: `Aim a PDF at ${size.label} in your browser, with no upload. Every attempt is measured, and if ${size.label} cannot be reached without wrecking the document, Stapler says so.`,
  ogDescription: `Shrink a PDF to ${size.label} or less entirely on your device — and get an honest answer when it cannot get that small.`,
  skipLabel: 'compress',
  h1: `Compress a PDF to ${size.label}`,
  intro: `Upload forms often cap files at ${size.label}. Stapler tries real compression settings, measures every result, and keeps the best-quality file at or under your target. If the document cannot get that small, it shows the smallest size it can make and asks before saving anything.`,
  cta: 'use-now',
  ctaNote: `The ${size.label} target is already filled in below. Open a PDF to start.`,
  points: [sizeMeasured, sizeHonest(size.label), sizeNothingLeaves],
  sizeLinks: [
    ...COMPRESS_TARGET_SIZES.filter(other => other !== size),
    { slug: CUSTOM_SIZE_SLUG, label: 'Another size' }
  ],
  appHeading: `Compress to ${size.label} right here`,
  faq: [
    { question: `Will every PDF get down to ${size.label}?`, answer: sizeFaqAnswer(size.label) },
    sizeFaqUpload
  ],
  entry: 'compress-pdf-to-size',
  bodyAttrs: { 'data-compress-target': size.target }
});

const customSizePage: LandingPage = {
  slug: CUSTOM_SIZE_SLUG,
  name: 'Compress PDF to a specific size',
  description:
    'Type the size a form asks for — 150 KB, 2 MB, anything — and Stapler aims a PDF at it in your browser, with no upload and an honest result.',
  ogDescription:
    'Aim a PDF at the exact file size you need, entirely on your device, and get an honest answer when it cannot get that small.',
  skipLabel: 'compress',
  h1: 'Compress a PDF to a specific size',
  intro:
    'Enter the limit your upload form gives, in KB or MB. Stapler tries real compression settings, measures every result, and keeps the best-quality file at or under it. If the document cannot get that small, it shows the smallest size it can make and asks before saving anything.',
  cta: 'use-now',
  ctaNote: 'Compress opens below in “Aim for a size” mode. Open a PDF and enter your target.',
  points: [sizeMeasured, sizeHonest('a very small target'), sizeNothingLeaves],
  sizeLinks: COMPRESS_TARGET_SIZES,
  appHeading: 'Pick your size right here',
  faq: [
    { question: 'Will every PDF reach the size I type?', answer: sizeFaqAnswer('your target') },
    sizeFaqUpload
  ],
  entry: 'compress-pdf-to-size'
};

// ---------------------------------------------------------------------------

/** Every landing page, in sitemap order. */
export const LANDING_PAGES: readonly LandingPage[] = [
  {
    slug: 'merge-pdf',
    name: 'Merge PDF',
    description:
      'Combine several PDFs and images into one document, entirely in your browser. No upload, no account, no daily limit — and no extension required to try it.',
    ogDescription:
      'Combine several PDFs and images into one document. Nothing is uploaded — try it right on this page.',
    skipLabel: 'merge',
    h1: 'Merge PDFs, entirely on your device',
    intro:
      'Combine several PDFs and images into one document, reordering pages as you go. Every byte stays on this device — nothing is ever uploaded to a server.',
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      {
        title: 'Nothing leaves your device',
        body: "No uploads, no account, no telemetry. Open DevTools' Network tab and watch it stay empty while you merge."
      },
      {
        title: 'Any mix of PDFs and images',
        body: 'Drop in PDFs, PNGs, and JPEGs together — Stapler brings them into one document in the order you choose.'
      },
      {
        title: 'No quota, no watermark',
        body: 'Merge as many pages as your device can hold, from up to 20 open documents at a time. What you export is exactly what you made.'
      }
    ],
    appHeading: 'Try merge right here',
    entry: 'merge-pdf'
  },
  {
    slug: 'compress-pdf',
    name: 'Compress PDF',
    description:
      "Shrink a PDF's file size in your browser, with no upload and an honest result — if there is nothing to gain, Stapler says so instead of re-saving a bigger file.",
    ogDescription:
      "Reduce a PDF's file size entirely on your device. Try it right on this page — no install required.",
    skipLabel: 'compress',
    h1: 'Compress PDFs without the guesswork',
    intro:
      'Reduce file size, and see the real result before you save it. If a file is already as small as it can get, Stapler tells you honestly rather than emitting something bigger.',
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      {
        title: 'Nothing leaves your device',
        body: 'Compression runs locally in a worker thread. No document is ever sent anywhere to be processed.'
      },
      {
        title: 'Never emits a bigger file',
        body: 'If compressing would make the file larger, Stapler falls back to the original and says so — it never silently hands back something worse.'
      },
      {
        title: 'See the size before you save',
        body: 'Preview the before/after size so you know exactly what you are getting before you export.'
      }
    ],
    appHeading: 'Try compress right here',
    entry: 'compress-pdf'
  },
  ...COMPRESS_TARGET_SIZES.map(fixedSizePage),
  customSizePage,
  {
    slug: 'sign-pdf',
    name: 'Sign PDF',
    description:
      'Sign and fill PDFs in your browser: a stamped signature, text, dates, and check marks, with no upload and no account. Try it right on this page.',
    ogDescription:
      'Place a signature, text, dates, and check marks on a PDF, entirely on your device.',
    skipLabel: 'sign',
    h1: 'Sign and fill PDFs on your own device',
    intro:
      'Place a stamped signature, typed text, dates, and check marks anywhere on the page. Existing form fields are detected and filled directly — nothing is uploaded to sign it.',
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      {
        title: 'Nothing leaves your device',
        body: 'A signature is sensitive. It is drawn or typed and stamped locally — never sent to a server to be "processed."'
      },
      {
        title: 'Fills real form fields',
        body: 'Existing AcroForm text fields, dates, and checkboxes are detected and filled in place, not just drawn over.'
      },
      {
        title: 'Reusable signature',
        body: 'Draw or type your signature once and stamp it again on later pages and documents.'
      }
    ],
    appHeading: 'Try sign & fill right here',
    entry: 'sign-pdf'
  },
  {
    slug: 'scan-cleanup',
    name: 'Scan Cleanup',
    description:
      'Straighten and whiten a photographed or scanned page in your browser. No upload, no account — try it right on this page.',
    ogDescription:
      'Deskew and clean up a phone-camera photo of a document into a proper scanned page, entirely on your device.',
    skipLabel: 'scan cleanup',
    h1: 'Turn a phone photo into a clean scan',
    intro:
      'Straighten a crooked page, even out the lighting, and whiten the background of a photographed or scanned document — all processed locally, nothing uploaded.',
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      {
        title: 'Nothing leaves your device',
        body: 'Deskew and cleanup run in a worker on your machine — the photo of your document never reaches a server.'
      },
      {
        title: 'Automatic straightening',
        body: 'Detects the page edges in a crooked photo and squares it up, with a manual override when it needs a nudge.'
      },
      {
        title: 'Even, readable pages',
        body: 'Corrects uneven lighting and shadow so the result reads like a proper scan, not a photo.'
      }
    ],
    appHeading: 'Try scan cleanup right here',
    entry: 'scan-cleanup'
  },
  {
    slug: 'redact-pdf',
    name: 'Redact PDF',
    description:
      'Permanently remove sensitive content from a PDF in your browser — not just a black box drawn over it. No upload, no account. Try it right on this page.',
    ogDescription:
      'Remove content permanently, then prove it was removed — entirely on your device.',
    skipLabel: 'redact',
    h1: 'Redact PDFs, and prove it stuck',
    intro:
      'Mark the areas to remove and Stapler deletes the underlying text and image data, not just paints a black box over it — the most sensitive documents never leave your device.',
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      {
        title: 'Nothing leaves your device',
        body: 'The document you are redacting is, by definition, the one you trust least with an upload. It never gets one.'
      },
      {
        title: 'Real removal, not a black box',
        body: 'Marked text and image content is deleted from the underlying PDF, so it cannot be recovered by copy-pasting or lifting a layer.'
      },
      {
        title: 'Verify it yourself',
        body: 'Search the exported file for the redacted text afterward — it is gone, not just covered.'
      }
    ],
    appHeading: 'Try redact right here',
    entry: 'redact-pdf'
  },
  {
    slug: 'pdf-to-word',
    name: 'PDF to Word',
    description:
      "Convert a PDF to an editable .docx, entirely in your browser. Beta: text and structure are preserved, not the PDF's exact layout. No upload, no account.",
    ogDescription:
      'Convert a PDF to an editable .docx. Nothing is uploaded — try it right on this page.',
    skipLabel: 'PDF to Word',
    h1: 'Convert PDF to Word, entirely on your device',
    intro:
      "Turn a PDF into an editable .docx with a full preview before you save. This is a beta converter: text and document structure carry over, not the PDF's exact layout, fonts, or pagination. Every byte stays on this device.",
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      convertNothingLeaves,
      {
        title: 'Text and structure, not layout',
        body: "Stapler pulls out the text and document structure. Fonts, exact positioning, and pagination are not reproduced — that's the beta tradeoff, stated plainly."
      },
      convertPreview('.docx')
    ],
    appHeading: 'Try PDF to Word right here',
    entry: 'pdf-to-word'
  },
  {
    slug: 'word-to-pdf',
    name: 'Word to PDF',
    description:
      "Turn a .docx into a PDF, entirely in your browser. Beta: content and structure are preserved, not Word's exact layout. No upload, no account.",
    ogDescription: 'Turn a .docx into a PDF. Nothing is uploaded — try it right on this page.',
    skipLabel: 'Word to PDF',
    h1: 'Convert Word to PDF, entirely on your device',
    intro:
      "Pick a .docx from your device and Stapler turns it into a PDF, with a full preview before you save. This is a beta converter: content and structure carry over, not Word's exact layout, fonts, or pagination. Every byte stays on this device.",
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [convertNothingLeaves, convertNoPdfRequired('.docx'), convertPreview('PDF')],
    appHeading: 'Try Word to PDF right here',
    entry: 'word-to-pdf'
  },
  {
    slug: 'pdf-to-excel',
    name: 'PDF to Excel',
    description:
      'Pull detected tables from a PDF into a .xlsx, entirely in your browser. Beta: cell values, not formulas or formatting. No upload, no account.',
    ogDescription:
      'Pull tables from a PDF into a .xlsx. Nothing is uploaded — try it right on this page.',
    skipLabel: 'PDF to Excel',
    h1: 'Convert PDF to Excel, entirely on your device',
    intro:
      "Stapler detects tables in a PDF and pulls them into a .xlsx, with a full preview before you save. This is a beta converter: cell values carry over, not formulas or Excel's formatting. Every byte stays on this device.",
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      convertNothingLeaves,
      {
        title: 'Detected tables, not guaranteed ones',
        body: 'A PDF has no tables, only text that lines up like one. Stapler detects and extracts cell values — always check the preview against the source page.'
      },
      convertPreview('.xlsx')
    ],
    appHeading: 'Try PDF to Excel right here',
    entry: 'pdf-to-excel'
  },
  {
    slug: 'excel-to-pdf',
    name: 'Excel to PDF',
    description:
      "Turn a .xlsx workbook into a paginated PDF, entirely in your browser. Beta: cell values, not Excel's exact layout. No upload, no account.",
    ogDescription:
      'Turn a .xlsx workbook into a PDF. Nothing is uploaded — try it right on this page.',
    skipLabel: 'Excel to PDF',
    h1: 'Convert Excel to PDF, entirely on your device',
    intro:
      "Pick a .xlsx from your device and Stapler draws each sheet as a paginated grid, with a full preview before you save. This is a beta converter: cell values carry over, not Excel's own printed layout. Every byte stays on this device.",
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [convertNothingLeaves, convertNoPdfRequired('.xlsx'), convertPreview('PDF')],
    appHeading: 'Try Excel to PDF right here',
    entry: 'excel-to-pdf'
  },
  {
    slug: 'pdf-to-ppt',
    name: 'PDF to PowerPoint',
    description:
      "Place each PDF page's text and images onto a slide, entirely in your browser. Beta: positioned boxes, not an editable deck. No upload, no account.",
    ogDescription: 'Turn a PDF into a slide deck. Nothing is uploaded — try it right on this page.',
    skipLabel: 'PDF to PowerPoint',
    h1: 'Convert PDF to PowerPoint, entirely on your device',
    intro:
      "Stapler places each page's text and images onto its own slide, with a full preview before you save. This is a beta converter: it produces positioned boxes where the page drew them, not an editable deck with real text placeholders. Every byte stays on this device.",
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [
      convertNothingLeaves,
      {
        title: 'Positioned boxes, not an editable deck',
        body: "This is the widest gap of Stapler's six converters: each page's text and images land on a slide at the position the page drew them, not inside editable placeholders."
      },
      convertPreview('.pptx')
    ],
    appHeading: 'Try PDF to PowerPoint right here',
    entry: 'pdf-to-ppt'
  },
  {
    slug: 'ppt-to-pdf',
    name: 'PowerPoint to PDF',
    description:
      'Turn a .pptx deck into a PDF, entirely in your browser. Beta: text and pictures placed where the deck put them. No upload, no account.',
    ogDescription: 'Turn a .pptx deck into a PDF. Nothing is uploaded — try it right on this page.',
    skipLabel: 'PowerPoint to PDF',
    h1: 'Convert PowerPoint to PDF, entirely on your device',
    intro:
      'Pick a .pptx from your device and Stapler draws each slide as its own page, text and pictures where the deck put them, with a full preview before you save. This is a beta converter. Every byte stays on this device.',
    cta: 'install',
    ctaNote: WORKS_ON_THIS_PAGE,
    points: [convertNothingLeaves, convertNoPdfRequired('.pptx'), convertPreview('PDF')],
    appHeading: 'Try PowerPoint to PDF right here',
    entry: 'ppt-to-pdf'
  }
];
