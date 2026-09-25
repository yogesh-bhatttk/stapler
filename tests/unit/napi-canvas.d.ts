/**
 * `@napi-rs/canvas` is not a direct dependency: it arrives transitively with
 * pdfjs-dist and is only resolvable from pdfjs-dist's own install location. The
 * tests that render through it import it dynamically and fall back to resolving it
 * off pdfjs-dist, treating the result as untyped (`any`, justified at each call
 * site). This shorthand ambient declaration gives the bare-specifier import the
 * same untyped shape so the test tsconfig can type-check those files.
 */
declare module '@napi-rs/canvas';
