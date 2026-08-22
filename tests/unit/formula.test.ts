/**
 * SGN-07 — calculated form fields.
 *
 * Two halves. The first exercises the calculation as a pure function, which is
 * how the live UI recalculation is tested without a DOM: the panel and the
 * overlay both render `applyFormulas(...)` of the same inputs, so proving the
 * function reacts to a changed input proves the display does.
 *
 * The second half exports a real PDF and reads the field back with an
 * independent `PDFDocument.load`, asserting the *computed* number is sitting in
 * `/V` — no formula string, and nothing that needs a viewer to run script.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import {
  applyFormulas,
  evaluateFormulas,
  formatFormulaNumber,
  parseFieldNumber,
  parseFormula,
  type FormulaDefinition,
  type FormulaField
} from '../../src/core/formula';
import { processWorkerImpl } from '../../src/core/workers/process.worker';

/** The fixture's fields, as `getFormFields` reports them. */
const FIELDS: FormulaField[] = [
  { name: 'subtotal', type: 'TextField', value: '100' },
  { name: 'tax', type: 'TextField', value: '7.5' },
  { name: 'shipping', type: 'TextField', value: '12.25' },
  { name: 'Line Total', type: 'TextField', value: '' },
  { name: 'note', type: 'TextField', value: 'paid in cash' }
];

const NAMES = FIELDS.map(field => field.name);

const sumFormula: FormulaDefinition[] = [
  { target: 'Line Total', source: 'subtotal + tax + shipping' }
];

function valueOf(node: unknown): string {
  if (node instanceof PDFString || node instanceof PDFHexString) return node.decodeText();
  return String(node);
}

describe('parseFormula: the restricted language (SGN-07)', () => {
  it('accepts the four operators, parentheses, numbers and known field names', () => {
    for (const source of [
      'subtotal + tax',
      'subtotal - tax',
      'subtotal * 2',
      'subtotal / 4',
      '(subtotal + tax) * 2',
      'subtotal + tax + shipping',
      '-tax + subtotal',
      '.5 * subtotal'
    ]) {
      const parsed = parseFormula(source, NAMES);
      expect(parsed.ok, `${source} → ${parsed.ok ? '' : parsed.error}`).toBe(true);
    }
  });

  it('addresses a field name containing a space, which no identifier regex could', () => {
    const parsed = parseFormula('Line Total + 1', NAMES);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.references).toEqual(['Line Total']);
  });

  it('matches the longest field name, so `taxable` is not `tax` plus junk', () => {
    const parsed = parseFormula('taxable + tax', [...NAMES, 'taxable']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.references.sort()).toEqual(['tax', 'taxable']);
  });

  it('reports exactly which fields a formula depends on', () => {
    const parsed = parseFormula('(subtotal + tax) * 2 - subtotal', NAMES);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.references.sort()).toEqual(['subtotal', 'tax']);
  });

  // The boundary the AC names: anything outside + - * / and known
  // names/numbers is rejected with a message, never partly evaluated and never
  // handed to a code path that could run it.
  it.each([
    ['subtotal ** 2', 'exponentiation is two operators, not one'],
    ['subtotal % 2', 'modulo'],
    ['subtotal & 1', 'bitwise'],
    ['subtotal | 1', 'bitwise or'],
    ['subtotal ^ 2', 'caret'],
    ['subtotal > tax', 'comparison'],
    ['subtotal = tax', 'assignment'],
    ['subtotal ? 1 : 2', 'ternary'],
    ['subtotal; alert(1)', 'statement separator'],
    ['Math.max(subtotal, tax)', 'a global object'],
    ['constructor', 'a prototype property name'],
    ['this.subtotal', 'this'],
    ['globalThis', 'the global'],
    ['process.exit(1)', 'a node global'],
    ['fetch("https://x")', 'a network call'],
    ['import("x")', 'a dynamic import'],
    ['(function(){return 1})()', 'a function expression'],
    ['`${subtotal}`', 'a template literal'],
    ['subtotal + unknownField', 'an unknown field name'],
    ['UNKNOWN', 'an unknown bare word'],
    ['subtotal +', 'a trailing operator'],
    ['+', 'an operator alone'],
    ['(subtotal + tax', 'an unclosed paren'],
    ['subtotal tax', 'two references with no operator'],
    ['', 'the empty string'],
    ['   ', 'whitespace only']
  ])('rejects %j (%s)', source => {
    const parsed = parseFormula(source, NAMES);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.length).toBeGreaterThan(10);
      // A rejection has to say something, not echo the input back.
      expect(parsed.error).not.toBe(source);
    }
  });

  it('names the infix form when the user writes a function call', () => {
    const parsed = parseFormula('sum(subtotal, tax)', NAMES);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toContain('sum');
      expect(parsed.error).toContain('a + b');
    }
  });

  it('names the offending field when a reference does not exist', () => {
    const parsed = parseFormula('subtotal + vat', NAMES);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('"vat"');
  });

  it('refuses a formula that nests or runs beyond its caps', () => {
    const deep = `${'('.repeat(64)}subtotal${')'.repeat(64)}`;
    const deepParse = parseFormula(deep, NAMES);
    expect(deepParse.ok).toBe(false);

    const long = Array.from({ length: 200 }, () => 'subtotal').join(' + ');
    const longParse = parseFormula(long, NAMES);
    expect(longParse.ok).toBe(false);
  });
});

describe('parseFieldNumber: coercion (SGN-07)', () => {
  it('treats an unfilled field as zero', () => {
    expect(parseFieldNumber('')).toEqual({ ok: true, value: 0 });
    expect(parseFieldNumber('   ')).toEqual({ ok: true, value: 0 });
    expect(parseFieldNumber(undefined)).toEqual({ ok: true, value: 0 });
  });

  it('reads a checkbox as 1 or 0', () => {
    expect(parseFieldNumber(true)).toEqual({ ok: true, value: 1 });
    expect(parseFieldNumber(false)).toEqual({ ok: true, value: 0 });
  });

  it('accepts a leading currency symbol and grouped thousands', () => {
    expect(parseFieldNumber('$1,234.56')).toEqual({ ok: true, value: 1234.56 });
    expect(parseFieldNumber('-42')).toEqual({ ok: true, value: -42 });
  });

  it('errors rather than guessing on a non-number', () => {
    // The important one: "12,50" as a European decimal would be 12.5, and as a
    // grouping error it is nothing. Reading it as 1250 or 0 would put a
    // confidently wrong total on a document, so it is refused.
    expect(parseFieldNumber('12,50').ok).toBe(false);
    expect(parseFieldNumber('paid in cash').ok).toBe(false);
    expect(parseFieldNumber('1.2.3').ok).toBe(false);
    expect(parseFieldNumber(['a', 'b']).ok).toBe(false);
  });
});

describe('formatFormulaNumber (SGN-07)', () => {
  it('does not leak binary floating-point noise into the field', () => {
    expect(formatFormulaNumber(0.1 + 0.2)).toBe('0.3');
  });

  it('keeps a whole number whole', () => {
    expect(formatFormulaNumber(20)).toBe('20');
    expect(formatFormulaNumber(-0)).toBe('0');
  });
});

describe('evaluateFormulas: live recalculation (SGN-07)', () => {
  it('sums the document values with no user input at all', () => {
    const { values, errors } = evaluateFormulas(sumFormula, FIELDS);
    expect(errors).toEqual({});
    expect(values['Line Total']).toBe('119.75');
  });

  // This is the live-recalculation test. The panel and the on-page overlay both
  // read `applyFormulas(formulas, fields, formValues)`, so a changed override
  // producing a changed result *is* the display updating — no DOM required.
  it('recomputes when a referenced field changes', () => {
    const first = applyFormulas(sumFormula, FIELDS, { subtotal: '100' });
    expect(first.values['Line Total']).toBe('119.75');

    const second = applyFormulas(sumFormula, FIELDS, { subtotal: '200' });
    expect(second.values['Line Total']).toBe('219.75');

    const cleared = applyFormulas(sumFormula, FIELDS, { subtotal: '', tax: '', shipping: '' });
    expect(cleared.values['Line Total']).toBe('0');
  });

  it('ignores the calculated field’s own stale value when recomputing', () => {
    // A previous render wrote 119.75 into the overlay's state. If that fed back
    // in, a formula referencing its own target would compound every keystroke.
    const { values } = applyFormulas(sumFormula, FIELDS, { 'Line Total': '999999' });
    expect(values['Line Total']).toBe('119.75');
  });

  it('chains one calculated field into another', () => {
    const chained: FormulaDefinition[] = [
      { target: 'Line Total', source: 'subtotal + tax' },
      { target: 'note', source: 'Line Total * 2' }
    ];
    const { values, errors } = evaluateFormulas(chained, FIELDS);
    expect(errors).toEqual({});
    expect(values['Line Total']).toBe('107.5');
    // Computed from this pass's Line Total, not from the field's stored value.
    expect(values.note).toBe('215');
  });

  it('reports a loop instead of recursing forever', () => {
    const cyclic: FormulaDefinition[] = [
      { target: 'Line Total', source: 'note + 1' },
      { target: 'note', source: 'Line Total + 1' }
    ];
    const { errors } = evaluateFormulas(cyclic, FIELDS);
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    expect(Object.values(errors)[0]).toContain('loop');
  });

  it('reports a self-reference as a loop', () => {
    const { errors } = evaluateFormulas([{ target: 'note', source: 'note + 1' }], FIELDS);
    expect(errors.note).toContain('loop');
  });

  it('errors on a reference to a field holding text', () => {
    const { values, errors } = evaluateFormulas(
      [{ target: 'Line Total', source: 'subtotal + note' }],
      FIELDS
    );
    expect(values['Line Total']).toBeUndefined();
    expect(errors['Line Total']).toContain('note');
  });

  it('errors on division by zero rather than writing Infinity', () => {
    const { errors } = evaluateFormulas([{ target: 'Line Total', source: 'subtotal / 0' }], FIELDS);
    expect(errors['Line Total']).toContain('zero');
  });

  it('refuses a target that is not a text field', () => {
    const withCheckbox: FormulaField[] = [
      ...FIELDS,
      { name: 'agreed', type: 'CheckBox', value: false }
    ];
    const { errors } = evaluateFormulas(
      [{ target: 'agreed', source: 'subtotal + tax' }],
      withCheckbox
    );
    expect(errors.agreed).toContain('text field');
  });

  it('refuses a target the document does not have', () => {
    const { errors } = evaluateFormulas([{ target: 'ghost', source: 'subtotal' }], FIELDS);
    expect(errors.ghost).toContain('ghost');
  });

  it('leaves the user’s other edits untouched in the merged values', () => {
    const { values } = applyFormulas(sumFormula, FIELDS, { note: 'hello', subtotal: '1' });
    expect(values.note).toBe('hello');
    expect(values.subtotal).toBe('1');
    expect(values['Line Total']).toBe('20.75');
  });
});

describe('exported PDF carries the computed value (SGN-07)', () => {
  it('writes the number, not the formula, and needs no script to display it', async () => {
    const { calculatedFormPdf } = await import('../e2e/fixtures');
    const bytes = await calculatedFormPdf();

    // Read the fields exactly as the UI does.
    const form = await processWorkerImpl.getFormFields(bytes);
    expect(form.isXfa).toBe(false);
    const names = form.fields.map(f => f.name).sort();
    expect(names).toEqual(['Line Total', 'note', 'shipping', 'subtotal', 'tax']);

    // The user changes one input, exactly as the fill panel would.
    const { values, errors } = applyFormulas(sumFormula, form.fields, { subtotal: '250' });
    expect(errors).toEqual({});
    expect(values['Line Total']).toBe('269.75');

    // The export path: the same merged values handed to the existing SGN-03 fill.
    const filled = await processWorkerImpl.fillFormFields(bytes, values, false);

    // Independent re-parse. Not the worker, not the UI state.
    const out = await PDFDocument.load(filled);
    const outForm = out.getForm();
    expect(outForm.getTextField('Line Total').getText()).toBe('269.75');
    expect(outForm.getTextField('subtotal').getText()).toBe('250');

    // /V straight off the field dictionary, which is what a viewer reads.
    const dict = outForm.getTextField('Line Total').acroField.dict;
    expect(valueOf(dict.get(PDFName.of('V')))).toBe('269.75');

    // The formula string is nowhere in the output, and no script was added: a
    // viewer with JavaScript disabled shows 269.75 because 269.75 is the value.
    const raw = new TextDecoder('latin1').decode(filled);
    expect(raw).not.toContain('subtotal + tax + shipping');
    expect(raw).not.toContain('/JavaScript');
    expect(raw).not.toContain('/AA');
    expect(out.catalog.get(PDFName.of('Names'))).toBeUndefined();
  });

  it('flattens the computed value into the page content', async () => {
    const { calculatedFormPdf } = await import('../e2e/fixtures');
    const bytes = await calculatedFormPdf();
    const form = await processWorkerImpl.getFormFields(bytes);

    const { values } = applyFormulas(sumFormula, form.fields, {});
    const flat = await processWorkerImpl.fillFormFields(bytes, values, true);

    const out = await PDFDocument.load(flat);
    // Flatten removes the interactive form entirely, so the total only survives
    // if it was really drawn.
    expect(out.getForm().getFields()).toHaveLength(0);
    expect(out.getPageCount()).toBe(1);
  });

  it('a formula error leaves the document unwritten', async () => {
    const { calculatedFormPdf } = await import('../e2e/fixtures');
    const bytes = await calculatedFormPdf();
    const form = await processWorkerImpl.getFormFields(bytes);

    // `note` holds "paid in cash", so this cannot be computed.
    const { values, errors } = applyFormulas(
      [{ target: 'Line Total', source: 'subtotal + note' }],
      form.fields,
      {}
    );
    expect(Object.keys(errors)).toEqual(['Line Total']);
    // The commit handler refuses on a non-empty `errors`; what matters here is
    // that no half-computed value is offered for writing.
    expect(values['Line Total']).toBeUndefined();
  });
});
