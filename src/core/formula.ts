/**
 * SGN-07 — calculated AcroForm fields.
 *
 * Pure arithmetic over field *names*, deliberately separated from the worker that
 * writes the result into the PDF: everything interesting here is a parsing and
 * coercion question, and those are only testable if the calculation can be called
 * with a plain object of strings. Nothing in this file touches a document.
 *
 * The language is a closed infix grammar — four operators, parentheses, decimal
 * literals, and names that must already exist in the document's `/AcroForm`.
 * There is no identifier table beyond the document's own field list, no function
 * call syntax, and no `Function`/`eval` anywhere in the evaluator: the parser can
 * only ever produce the three node kinds in `FormulaNode`, so a hostile formula
 * string has nothing to reach. That restriction is the feature. A general
 * expression evaluator over a user-supplied document is an attack surface that
 * `+ - * /` across known field names simply does not have.
 *
 * Infix was chosen over a `sum(a, b)` call surface because it covers sum,
 * difference, product *and* quotient in one grammar of about forty lines, and
 * because a person totalling an invoice writes `subtotal + tax`. Function syntax
 * is detected and rejected with a message naming the infix form, rather than
 * failing with a bare "unexpected character".
 */

/** The only operators that exist. There is no way to add a fifth from outside. */
export type FormulaOperator = '+' | '-' | '*' | '/';

export type FormulaNode =
  | { kind: 'number'; value: number }
  | { kind: 'field'; name: string }
  | { kind: 'op'; op: FormulaOperator; left: FormulaNode; right: FormulaNode };

/**
 * Structural minimum this module needs from a form field. `FormFieldData` from
 * the process worker is assignable to it, but nothing here imports the worker —
 * the calculation stays testable without a PDF.
 */
export interface FormulaField {
  name: string;
  type: string;
  value: string | string[] | boolean;
}

/** One user-designated calculated field: `target` displays `source` evaluated. */
export interface FormulaDefinition {
  /** Name of the existing text field that receives the computed value. */
  target: string;
  /** The formula as typed, e.g. `subtotal + tax`. */
  source: string;
}

export type ParsedFormula =
  { ok: true; ast: FormulaNode; references: string[] } | { ok: false; error: string };

export interface FormulaEvaluation {
  /** Target field name → the computed value, formatted for writing into `/V`. */
  values: Record<string, string>;
  /** Target field name → why it could not be computed. Blocks the export. */
  errors: Record<string, string>;
}

/** Shown next to the formula input and reused in every rejection message. */
export const FORMULA_SYNTAX_HINT =
  'Use field names, numbers, + - * / and parentheses — for example ' +
  '"subtotal + tax" or "(hours * rate) / 2".';

/**
 * Decimal places kept before the result is stringified. Six is enough to make
 * `0.1 + 0.2` read `0.3` instead of `0.30000000000000004`, and few enough that
 * no plausible form total is rounded visibly.
 */
const FORMULA_DECIMALS = 6;

/** Beyond this the result would stringify in exponent notation into `/V`. */
const MAX_MAGNITUDE = 1e15;

/**
 * Caps on the token stream and the parenthesis nesting. The parser is recursive
 * descent, so an adversarial `((((((…))))))` is a stack overflow rather than a
 * parse error without a depth limit — and a formula string can arrive from a
 * pasted, document-adjacent source.
 */
const MAX_TOKENS = 256;
const MAX_DEPTH = 32;

type Token =
  | { kind: 'number'; value: number; at: number }
  | { kind: 'field'; name: string; at: number }
  | { kind: 'op'; op: FormulaOperator; at: number }
  | { kind: 'lparen'; at: number }
  | { kind: 'rparen'; at: number };

const OPERATORS = new Set<string>(['+', '-', '*', '/']);

/** Characters a mistyped field name is likely made of, for a better error. */
const WORDISH = /[A-Za-z0-9_.\-[\]#$]/;

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

/**
 * Field names are matched *first* and *longest-first* against the document's own
 * list, which is what lets a form built by someone else be referenced at all:
 * PDF field names routinely contain spaces (`Total Amount`), dots
 * (`name.first`), and occasionally a hyphen — none of which an identifier regex
 * would survive. The consequence, stated because it is observable: a field
 * literally named `2` shadows the numeric literal `2`, and a field named `a-b`
 * is one reference rather than a subtraction.
 */
function tokenize(source: string, fieldNames: readonly string[]): Token[] | { error: string } {
  // Longest first so `taxable` never matches as `tax` with a dangling `able`.
  const names = [...fieldNames].filter(name => name.length > 0).sort((a, b) => b.length - a.length);

  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (tokens.length >= MAX_TOKENS) {
      return { error: `That formula is too long (over ${MAX_TOKENS} terms).` };
    }

    const name = names.find(candidate => source.startsWith(candidate, i));
    if (name !== undefined) {
      tokens.push({ kind: 'field', name, at: i });
      i += name.length;
      continue;
    }

    if (isDigit(char) || (char === '.' && isDigit(source[i + 1] ?? ''))) {
      let end = i;
      while (end < source.length && isDigit(source[end])) end++;
      if (source[end] === '.') {
        end++;
        while (end < source.length && isDigit(source[end])) end++;
      }
      const text = source.slice(i, end);
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: `"${text}" is not a number.` };
      tokens.push({ kind: 'number', value, at: i });
      i = end;
      continue;
    }

    if (OPERATORS.has(char)) {
      tokens.push({ kind: 'op', op: char as FormulaOperator, at: i });
      i++;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'lparen', at: i });
      i++;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'rparen', at: i });
      i++;
      continue;
    }

    // Everything below is a rejection. The message matters more than the code
    // path: "unexpected character" sends a user hunting through a formula that
    // is, nine times out of ten, referencing a field name they misremembered.
    if (WORDISH.test(char)) {
      let end = i;
      while (end < source.length && WORDISH.test(source[end])) end++;
      const word = source.slice(i, end);
      // `sum(a, b)` and friends: name the supported spelling instead.
      if (source[end] === '(') {
        return {
          error:
            `Function calls like "${word}(…)" are not supported. Write "a + b" rather than ` +
            `"${word}(a, b)". ${FORMULA_SYNTAX_HINT}`
        };
      }
      return { error: `This document has no form field named "${word}". ${FORMULA_SYNTAX_HINT}` };
    }

    return {
      error: `"${char}" is not allowed in a formula (at position ${i + 1}). ${FORMULA_SYNTAX_HINT}`
    };
  }

  if (tokens.length === 0) return { error: 'The formula is empty.' };
  return tokens;
}

/**
 * Recursive descent over the token stream. `+ -` bind loosest, then `* /`, then
 * a unary minus, then a primary. Unary minus is desugared to `0 - x` so the AST
 * keeps exactly three node kinds and the evaluator has no fourth case.
 */
function parseTokens(tokens: Token[]): { ast: FormulaNode } | { error: string } {
  let pos = 0;
  let failure: string | null = null;

  const fail = (message: string): null => {
    failure ??= message;
    return null;
  };

  const describe = (token: Token | undefined): string => {
    if (!token) return 'the end of the formula';
    if (token.kind === 'field') return `"${token.name}"`;
    if (token.kind === 'number') return `${token.value}`;
    if (token.kind === 'op') return `"${token.op}"`;
    return token.kind === 'lparen' ? '"("' : '")"';
  };

  const parseExpression = (depth: number): FormulaNode | null => {
    if (depth > MAX_DEPTH) return fail('That formula nests too deeply.');
    let left = parseTerm(depth);
    if (!left) return null;
    for (;;) {
      const token = tokens[pos];
      if (token?.kind !== 'op' || (token.op !== '+' && token.op !== '-')) break;
      pos++;
      const right = parseTerm(depth);
      if (!right) return null;
      left = { kind: 'op', op: token.op, left, right };
    }
    return left;
  };

  const parseTerm = (depth: number): FormulaNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;
    for (;;) {
      const token = tokens[pos];
      if (token?.kind !== 'op' || (token.op !== '*' && token.op !== '/')) break;
      pos++;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { kind: 'op', op: token.op, left, right };
    }
    return left;
  };

  const parseUnary = (depth: number): FormulaNode | null => {
    if (depth > MAX_DEPTH) return fail('That formula nests too deeply.');
    const token = tokens[pos];
    if (token?.kind === 'op' && (token.op === '-' || token.op === '+')) {
      pos++;
      const operand = parseUnary(depth + 1);
      if (!operand) return null;
      if (token.op === '+') return operand;
      return { kind: 'op', op: '-', left: { kind: 'number', value: 0 }, right: operand };
    }
    return parsePrimary(depth);
  };

  const parsePrimary = (depth: number): FormulaNode | null => {
    const token = tokens[pos];
    if (!token) return fail('The formula ends after an operator — something is missing.');
    if (token.kind === 'number') {
      pos++;
      return { kind: 'number', value: token.value };
    }
    if (token.kind === 'field') {
      pos++;
      return { kind: 'field', name: token.name };
    }
    if (token.kind === 'lparen') {
      pos++;
      const inner = parseExpression(depth + 1);
      if (!inner) return null;
      if (tokens[pos]?.kind !== 'rparen') return fail('A "(" in the formula is never closed.');
      pos++;
      return inner;
    }
    return fail(`The formula has ${describe(token)} where a field name or number was expected.`);
  };

  const ast = parseExpression(0);
  if (!ast) return { error: failure ?? 'The formula could not be read.' };
  if (pos < tokens.length) {
    return { error: `The formula has extra ${describe(tokens[pos])} at the end.` };
  }
  return { ast };
}

function collectReferences(node: FormulaNode, into: Set<string>): void {
  if (node.kind === 'field') into.add(node.name);
  else if (node.kind === 'op') {
    collectReferences(node.left, into);
    collectReferences(node.right, into);
  }
}

/**
 * Parse `source` against the field names this document actually has. A name that
 * is not in `fieldNames` is a hard rejection — there is no way to reference
 * anything the document does not contain, which is what keeps the language
 * closed.
 */
export function parseFormula(source: string, fieldNames: readonly string[]): ParsedFormula {
  if (source.trim().length === 0) return { ok: false, error: 'The formula is empty.' };

  const tokens = tokenize(source, fieldNames);
  if ('error' in tokens) return { ok: false, error: tokens.error };

  const parsed = parseTokens(tokens);
  if ('error' in parsed) return { ok: false, error: parsed.error };

  const references = new Set<string>();
  collectReferences(parsed.ast, references);
  return { ok: true, ast: parsed.ast, references: [...references] };
}

/**
 * Coerce one field's stored value to a number.
 *
 * An empty field is 0 — an unfilled line on an invoice contributes nothing, and
 * refusing to total a half-filled form would make the feature useless. Anything
 * non-empty that is not a number is an *error*, never a silent 0: reading "12,50"
 * as zero would put a confidently wrong total on a document.
 */
export function parseFieldNumber(
  raw: string | string[] | boolean | undefined
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  // A checkbox is a well-defined 1 or 0, which makes "count the ticked boxes"
  // work without a second syntax for it.
  if (typeof raw === 'boolean') return { ok: true, value: raw ? 1 : 0 };
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: true, value: 0 };
    if (raw.length > 1) {
      return { ok: false, error: 'has more than one option selected, so it has no single value' };
    }
    return parseFieldNumber(raw[0]);
  }

  let text = raw.trim();
  if (text.length === 0) return { ok: true, value: 0 };

  // A typed currency symbol is common enough in a real form that erroring on it
  // would read as a bug. Only a leading one, and only these.
  text = text.replace(/^[$€£¥₹]\s*/, '');
  // Thousands separators, accepted only in genuine grouping positions. This
  // deliberately rejects the European "1.234,56": misreading it as 1.234 would
  // be a wrong total, and a wrong total must be an error, not a guess.
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');

  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text)) {
    return { ok: false, error: `is not a number ("${raw.trim()}")` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: `is not a number ("${raw.trim()}")` };
  return { ok: true, value };
}

/**
 * Format a computed number for writing into `/V`.
 *
 * Rounded to `FORMULA_DECIMALS` to remove binary floating-point noise, then
 * stringified without trailing zeros — `10 * 2` is "20", not "20.00". Currency
 * presentation is deliberately not attempted; see the ticket writeup.
 */
export function formatFormulaNumber(value: number): string {
  const rounded = Number(value.toFixed(FORMULA_DECIMALS));
  if (Object.is(rounded, -0)) return '0';
  return String(rounded);
}

/**
 * Evaluate every calculated field against the document's fields plus the user's
 * in-progress edits.
 *
 * `overrides` is the fill panel's live state; a name absent from it falls back to
 * the field's stored value. A target's *own* entry in `overrides` is ignored — a
 * calculated field is derived, so its previous display must never feed back into
 * its own recomputation.
 *
 * Returns computed values and errors side by side rather than throwing, because
 * the UI shows both live and the export needs to refuse on the errors.
 */
export function evaluateFormulas(
  formulas: readonly FormulaDefinition[],
  fields: readonly FormulaField[],
  overrides: Readonly<Record<string, string | string[] | boolean>> = {}
): FormulaEvaluation {
  const values: Record<string, string> = {};
  const errors: Record<string, string> = {};

  const byName = new Map(fields.map(field => [field.name, field]));
  const fieldNames = fields.map(field => field.name);

  // Last definition wins for a duplicated target, matching how the UI stores
  // them (one row per target).
  const byTarget = new Map<string, FormulaDefinition>();
  for (const formula of formulas) byTarget.set(formula.target, formula);

  const parsed = new Map<string, ParsedFormula>();
  const resolved = new Map<string, { ok: true; value: number } | { ok: false; error: string }>();

  const resolveTarget = (
    target: string,
    stack: string[]
  ): { ok: true; value: number } | { ok: false; error: string } => {
    const cached = resolved.get(target);
    if (cached) return cached;

    if (stack.includes(target)) {
      const cycle = [...stack.slice(stack.indexOf(target)), target].join(' → ');
      return { ok: false, error: `The formulas refer to each other in a loop (${cycle}).` };
    }

    const formula = byTarget.get(target);
    /* istanbul ignore next -- resolveTarget is only called for known targets */
    if (!formula) return { ok: false, error: `"${target}" has no formula.` };

    let ast = parsed.get(target);
    if (!ast) {
      ast = parseFormula(formula.source, fieldNames);
      parsed.set(target, ast);
    }
    if (!ast.ok) {
      const outcome = { ok: false as const, error: ast.error };
      resolved.set(target, outcome);
      return outcome;
    }

    const evaluate = (
      node: FormulaNode
    ): { ok: true; value: number } | { ok: false; error: string } => {
      if (node.kind === 'number') return { ok: true, value: node.value };
      if (node.kind === 'field') {
        // A referenced field that is itself calculated is computed, not read:
        // otherwise a chain of two formulas would use last render's value.
        if (byTarget.has(node.name)) return resolveTarget(node.name, [...stack, target]);
        const source = overrides[node.name] ?? byName.get(node.name)?.value;
        const parsedValue = parseFieldNumber(source);
        if (!parsedValue.ok) {
          return { ok: false, error: `Field "${node.name}" ${parsedValue.error}.` };
        }
        return parsedValue;
      }
      const left = evaluate(node.left);
      if (!left.ok) return left;
      const right = evaluate(node.right);
      if (!right.ok) return right;
      switch (node.op) {
        case '+':
          return { ok: true, value: left.value + right.value };
        case '-':
          return { ok: true, value: left.value - right.value };
        case '*':
          return { ok: true, value: left.value * right.value };
        case '/':
          if (right.value === 0) return { ok: false, error: 'The formula divides by zero.' };
          return { ok: true, value: left.value / right.value };
      }
    };

    const outcome = evaluate(ast.ast);
    resolved.set(target, outcome);
    return outcome;
  };

  for (const target of byTarget.keys()) {
    const field = byName.get(target);
    if (!field) {
      errors[target] = `This document has no form field named "${target}".`;
      continue;
    }
    // Only a text field can hold an arbitrary computed string. Writing a total
    // into a checkbox or a dropdown would either be refused by `fillFormFields`
    // or silently select nothing.
    if (field.type !== 'TextField') {
      errors[target] =
        `"${target}" is a ${field.type}, not a text field, so it cannot show a calculated value.`;
      continue;
    }

    const outcome = resolveTarget(target, []);
    if (!outcome.ok) {
      errors[target] = outcome.error;
      continue;
    }
    if (!Number.isFinite(outcome.value) || Math.abs(outcome.value) >= MAX_MAGNITUDE) {
      errors[target] = `The result of "${target}" is too large to put in a form field.`;
      continue;
    }
    values[target] = formatFormulaNumber(outcome.value);
  }

  return { values, errors };
}

/**
 * The values to actually write on export: the user's edits with every calculated
 * field's computed value laid over the top.
 *
 * The UI renders from this and the export writes from this, so what was on screen
 * and what lands in `/V` cannot drift — they are the same function of the same
 * inputs. `errors` being non-empty is what blocks the save.
 */
export function applyFormulas(
  formulas: readonly FormulaDefinition[],
  fields: readonly FormulaField[],
  overrides: Readonly<Record<string, string | string[] | boolean>> = {}
): { values: Record<string, string | string[] | boolean>; errors: Record<string, string> } {
  const { values, errors } = evaluateFormulas(formulas, fields, overrides);
  return { values: { ...overrides, ...values }, errors };
}
