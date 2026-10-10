/**
 * AUDIT-2026-10-10 — component-level checks for agent D's UI fixes.
 *
 * There is no DOM in this suite (see `setup.ts`), so components are called as
 * functions with `preact/hooks` replaced by a minimal, render-free stand-in, and
 * the returned vnode tree is expanded for the components a test names. That is
 * enough to assert the props a control actually renders with — its accessible
 * name, its `aria-describedby`, whether it exists at all — rather than
 * inferring them from the source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, type VNode } from 'preact';

const hooks = vi.hoisted(() => ({
  log: [] as string[],
  /** Values handed out by successive `useState` calls, before falling back to the initial. */
  stateOverrides: [] as unknown[],
  contexts: new Map<unknown, unknown>()
}));

vi.mock('preact/hooks', async importOriginal => {
  const real = await importOriginal<typeof import('preact/hooks')>();
  let ids = 0;
  return {
    ...real,
    useState: (initial: unknown) => {
      hooks.log.push('useState');
      const value =
        hooks.stateOverrides.length > 0
          ? hooks.stateOverrides.shift()
          : typeof initial === 'function'
            ? (initial as () => unknown)()
            : initial;
      return [value, () => {}];
    },
    useReducer: (_r: unknown, initial: unknown) => {
      hooks.log.push('useReducer');
      return [initial, () => {}];
    },
    useEffect: () => void hooks.log.push('useEffect'),
    useLayoutEffect: () => void hooks.log.push('useLayoutEffect'),
    useRef: (current: unknown) => {
      hooks.log.push('useRef');
      return { current };
    },
    useMemo: (factory: () => unknown) => {
      hooks.log.push('useMemo');
      return factory();
    },
    useCallback: (fn: unknown) => {
      hooks.log.push('useCallback');
      return fn;
    },
    useId: () => {
      hooks.log.push('useId');
      return `id${++ids}`;
    },
    useContext: (context: { Provider?: unknown }) => {
      hooks.log.push('useContext');
      return hooks.contexts.has(context) ? hooks.contexts.get(context) : null;
    }
  };
});

const activeToolMock = vi.hoisted(() => ({ tool: null as unknown }));
vi.mock('../../src/ui/useActiveTool', () => ({ useActiveTool: () => activeToolMock.tool }));

const { Field, TextInput, NumberInput, Select } = await import('../../src/ui/components/Field');
const { ActionBar } = await import('../../src/ui/shell/ActionBar');
const { FileTabs } = await import('../../src/ui/shell/FileTabs');
const { ShortcutsPanel } = await import('../../src/ui/tools/shortcuts/ShortcutsPanel');
const { CompressPanel } = await import('../../src/ui/tools/compress/CompressPanel');
const { AcroFormOverlay } = await import('../../src/ui/tools/sign/AcroFormOverlay');
const { Button } = await import('../../src/ui/components/Button');
const { findTool } = await import('../../src/core/tools');
const { activeJob } = await import('../../src/core/notify');
const { formFields } = await import('../../src/ui/tools/sign/state');
const store = await import('../../src/core/store');

type AnyVNode = VNode<Record<string, unknown>>;

/**
 * Expands `node`, calling every component in `expand` (and context providers)
 * as a function; everything else is left as a vnode. Returns the flat list.
 */
function render(node: unknown, expand: ReadonlySet<unknown>, out: AnyVNode[] = []): AnyVNode[] {
  if (Array.isArray(node)) {
    for (const child of node) render(child, expand, out);
    return out;
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out;
  const vnode = node as AnyVNode;
  const type = vnode.type as unknown as { Provider?: unknown } & ((p: unknown) => unknown);
  if (typeof type === 'function' && type.Provider === type) {
    // A context provider: its value is what `useContext` returns below it.
    const previous = hooks.contexts.get(type);
    const had = hooks.contexts.has(type);
    hooks.contexts.set(type, vnode.props.value);
    render(vnode.props.children, expand, out);
    if (had) hooks.contexts.set(type, previous);
    else hooks.contexts.delete(type);
    return out;
  }
  if (typeof type === 'function' && expand.has(type)) {
    render(type({ ...vnode.props, ref: vnode.ref }), expand, out);
    return out;
  }
  out.push(vnode);
  render(vnode.props.children, expand, out);
  return out;
}

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as AnyVNode).props?.children);
};

beforeEach(() => {
  hooks.log.length = 0;
  hooks.stateOverrides.length = 0;
  hooks.contexts.clear();
});

afterEach(() => {
  activeJob.value = null;
  store.documents.value = [];
  store.activeDocId.value = null;
  formFields.value = null;
});

describe('UI17 — Field links its hint', () => {
  const expand = new Set<unknown>([Field, TextInput, NumberInput, Select]);

  it('the labelled control is described by the hint, and keeps its own description', () => {
    const tree = render(
      Field({
        label: 'Pages per file',
        hint: 'Comma-separated page numbers.',
        children: (id: string) => [
          h(TextInput, { id, 'aria-describedby': 'own-error' }),
          h(NumberInput, { id: 'unrelated' })
        ]
      } as never),
      expand
    );
    const hint = tree.find(
      v => v.type === 'span' && textOf(v) === 'Comma-separated page numbers.'
    )!;
    expect(hint.props.id).toBeTruthy();
    const inputs = tree.filter(v => v.type === 'input');
    expect(inputs[0].props['aria-describedby']).toBe(`own-error ${hint.props.id}`);
    // A different control inside the field is not the labelled one.
    expect(inputs[1].props['aria-describedby']).toBeUndefined();
  });

  it('a field without a hint adds nothing, and a select is linked too', () => {
    const tree = render(
      Field({
        label: 'Format',
        hint: 'Smaller files.',
        children: (id: string) =>
          h(Select, { id, value: 'a', options: [{ value: 'a', label: 'A' }], onChange: () => {} })
      } as never),
      expand
    );
    const hint = tree.find(v => v.type === 'span' && textOf(v) === 'Smaller files.')!;
    expect(tree.find(v => v.type === 'select')!.props['aria-describedby']).toBe(hint.props.id);

    const bare = render(
      Field({ label: 'Name', children: (id: string) => h(TextInput, { id }) } as never),
      expand
    );
    expect(bare.find(v => v.type === 'input')!.props['aria-describedby']).toBeUndefined();
  });
});

describe('UI4 — the action bar renders no primary button for a view-only tool', () => {
  const primaries = () =>
    render(ActionBar(), new Set()).filter(v => v.type === Button && v.props.variant === 'primary');

  it('none for compare, read aloud, reflow, history, side by side, shortcuts', () => {
    for (const id of ['compare', 'read-aloud', 'reflow', 'history', 'side-by-side', 'shortcuts']) {
      activeToolMock.tool = findTool(id);
      expect(primaries(), id).toHaveLength(0);
    }
  });

  it('still one for a tool that writes a file', () => {
    activeToolMock.tool = findTool('compress');
    expect(primaries()).toHaveLength(1);
  });
});

describe('UI16 — file tabs', () => {
  function seedTwo(dirty: boolean) {
    store.documents.value = [
      { id: 'a', name: 'a.pdf', pages: [], baseline: [], annotations: [], dirty },
      { id: 'b', name: 'b.pdf', pages: [], baseline: [], annotations: [], dirty: false }
    ] as never;
    store.activeDocId.value = 'a';
  }

  it('is a labelled group, and the unsaved state is text in the tab’s name', () => {
    seedTwo(true);
    const tree = render(FileTabs(), new Set());
    expect(tree[0].props.role).toBe('group');
    const tabA = tree.find(v => v.type === 'button' && textOf(v).includes('a.pdf'))!;
    expect(textOf(tabA)).toBe('Unsaved changesa.pdf');
    const hidden = render(tabA.props.children, new Set()).find(v => v.props.className === 'srOnly');
    expect(textOf(hidden)).toBe('Unsaved changes');
    // The dot itself is presentational.
    const dot = render(tabA.props.children, new Set()).find(
      v => v.type === 'span' && v.props['aria-hidden'] === 'true'
    );
    expect(dot).toBeDefined();
  });

  it('a tab blocked by a running job stays focusable and says why', () => {
    seedTwo(false);
    activeJob.value = { label: 'Working', progress: null, cancel: () => {} } as never;
    const tree = render(FileTabs(), new Set());
    const tabB = tree.find(v => v.type === 'button' && textOf(v) === 'b.pdf')!;
    expect(tabB.props.disabled).toBeUndefined();
    expect(tabB.props['aria-disabled']).toBe('true');
    const reason = tree.find(v => v.props.id === tabB.props['aria-describedby'])!;
    expect(textOf(reason)).toBe('Finish the current operation before switching documents.');

    // The active tab's close control is blocked the same way, and still reachable.
    const close = tree.find(v => v.props.role === 'button' && v.props['aria-disabled'] === 'true')!;
    expect(close.props.tabIndex).toBe(0);
    const closeReason = tree.find(v => v.props.id === close.props['aria-describedby'])!;
    expect(textOf(closeReason)).toBe('Finish the current operation before closing this document.');
  });
});

describe('UI18 — the shortcut conflict is announced', () => {
  it('the live region is rendered before and with the message', () => {
    const empty = render(ShortcutsPanel(), new Set()).find(v => v.props.role === 'alert');
    expect(empty).toBeDefined();
    expect(textOf(empty)).toBe('');

    // editingId, conflictMsg
    hooks.stateOverrides.push('undo', 'Conflict with "Redo". Choose another key.');
    const shown = render(ShortcutsPanel(), new Set()).find(v => v.props.role === 'alert');
    expect(textOf(shown)).toBe('Conflict with "Redo". Choose another key.');
  });
});

describe('UI30 — CompressPanel calls the same hooks with and without a document', () => {
  it('hook order does not depend on the early return', () => {
    store.documents.value = [];
    store.activeDocId.value = null;
    hooks.log.length = 0;
    expect(CompressPanel()).toBeNull();
    const withoutDoc = [...hooks.log];
    expect(withoutDoc).toContain('useEffect');

    store.documents.value = [
      { id: 'd', name: 'd.pdf', pages: [], baseline: [], annotations: [], dirty: false }
    ] as never;
    store.activeDocId.value = 'd';
    hooks.log.length = 0;
    CompressPanel();
    expect(hooks.log).toEqual(withoutDoc);
  });
});

describe('UI9 — AcroFormOverlay controls are named', () => {
  it('textarea, checkbox and select carry the /TU tooltip or the field name', () => {
    const rect = { pageIndex: 0, x: 0, y: 0, width: 0.1, height: 0.1 };
    formFields.value = {
      isXfa: false,
      fields: [
        {
          name: 'surname',
          tooltip: 'Surname',
          type: 'TextField',
          value: '',
          isReadOnly: false,
          rects: [rect]
        },
        { name: 'agree', type: 'CheckBox', value: false, isReadOnly: false, rects: [rect] },
        {
          name: 'country',
          tooltip: 'Country of residence',
          type: 'Dropdown',
          value: 'NZ',
          options: ['NZ', 'AU'],
          isReadOnly: false,
          rects: [rect]
        },
        {
          name: 'size',
          type: 'RadioGroup',
          value: 'S',
          options: ['S', 'M'],
          isReadOnly: false,
          rects: [rect, rect]
        }
      ]
    } as never;
    const tree = render(AcroFormOverlay({ pageIndex: 0, width: 600, height: 800 }), new Set());
    expect(tree.find(v => v.type === 'textarea')!.props['aria-label']).toBe('Surname');
    const inputs = tree.filter(v => v.type === 'input');
    expect(inputs.find(v => v.props.type === 'checkbox')!.props['aria-label']).toBe('agree');
    expect(tree.find(v => v.type === 'select')!.props['aria-label']).toBe('Country of residence');
    expect(inputs.filter(v => v.props.type === 'radio').map(v => v.props['aria-label'])).toEqual([
      'size: S',
      'size: M'
    ]);
  });
});
