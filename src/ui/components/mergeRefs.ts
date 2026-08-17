import type { Ref, RefCallback } from 'preact';

/**
 * Combines a forwarded ref with a ref the component already needs internally
 * (e.g. to measure or focus its own root element) so both receive the node.
 * `forwardRef` gives every component exactly one ref slot, but several of these
 * already had a local `useRef` on the same element before DS-03's forwardRef
 * pass — this lets both keep working rather than one silently losing the node.
 */
export function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(node);
      else (ref as { current: T | null }).current = node;
    }
  };
}
