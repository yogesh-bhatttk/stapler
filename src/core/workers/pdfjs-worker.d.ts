/**
 * `pdfjs-dist` ships no type declarations for its worker build. Stapler only
 * needs the one export it registers on `globalThis.pdfjsWorker`
 * (`pdfjs-setup.ts`), which pdf.js itself consumes; the value is opaque here.
 */
declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
