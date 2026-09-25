/**
 * The code points XML 1.0 has no representation for, shared by every OOXML
 * writer (`docx-writer.ts`, `pptx-writer.ts`, `xlsx-writer.ts`).
 *
 * A PDF's text layer can carry NUL, BEL or a stray form feed — a producer bug,
 * a subset font with a broken `/ToUnicode` map, a Type3 font — and a literal
 * control character in a part makes the whole package unparseable. Word reports
 * that as "unreadable content", PowerPoint offers a repair that can drop
 * content, Excel calls the workbook corrupt. The `docx` package and pptxgenjs
 * escape `& < >` but pass these through, so every string headed for them has to
 * go through here first (CONV-3). Tab, newline and carriage return are legal and
 * kept.
 */
export function stripInvalidXmlChars(str: string): string {
  // Written as a code-point scan rather than a regex character class because the
  // class would have to be spelled with escapes for characters that must never
  // appear literally in this source file in the first place.
  let out = '';
  let clean = true;
  for (const ch of str) {
    const code = ch.codePointAt(0) as number;
    const valid =
      code === 0x9 ||
      code === 0xa ||
      code === 0xd ||
      (code >= 0x20 && code <= 0xd7ff) ||
      // 0xD800–0xDFFF are surrogates. A well-formed pair arrives from `for…of`
      // as one code point above 0xFFFF and passes on the last clause; a *lone*
      // surrogate lands in this gap and is dropped, which is the only correct
      // answer — it is not a character.
      (code >= 0xe000 && code <= 0xfffd) ||
      code >= 0x10000;
    if (valid) out += ch;
    else clean = false;
  }
  return clean ? str : out;
}
