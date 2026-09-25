import type { ComponentChildren } from 'preact';
import { Fragment } from 'preact';

/**
 * Renders a translated sentence whose `{placeholders}` stand for markup —
 * `<kbd>`, links, emphasis — instead of text.
 *
 * The alternative, translating the words around the markup as separate keys
 * (`t('Press')` <kbd/> `t('to rotate')`), hands translators fragments they
 * cannot reorder, which is exactly what AUDIT UI-8 flagged. Here the whole
 * sentence is one key and each language places the slots where its grammar
 * wants them. Placeholders with no matching slot are left as text.
 */
export function withSlots(
  text: string,
  slots: Record<string, ComponentChildren>
): ComponentChildren[] {
  return text.split(/(\{\w+\})/g).map((part, index) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name && name in slots ? <Fragment key={index}>{slots[name]}</Fragment> : part;
  });
}
