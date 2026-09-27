// Vite entry for the GAP-4 "compress PDF to a size" pages: /compress-pdf-to-100kb,
// /compress-pdf-to-200kb, /compress-pdf-to-500kb, /compress-pdf-to-1mb and
// /compress-pdf-to-size. One entry for all of them: each page names its target in
// `<body data-compress-target="100KB">` (none on the pick-your-own page), and this
// opens Compress in "Aim for a size" mode with it pre-filled — through the same
// `#/tool/compress?target=…` link the extension editor accepts (ui/deepLink.ts).
import { mountLanding } from '../mountLanding';

const target = document.body.dataset.compressTarget;
mountLanding('compress', target ? `target=${encodeURIComponent(target)}` : 'mode=target');
