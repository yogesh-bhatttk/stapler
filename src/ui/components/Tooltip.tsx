/**
 * A hover/focus tooltip. Shows on focus as well as hover — a tooltip that only
 * responds to `mouseenter` is invisible to a keyboard user, which is the most
 * common way this primitive gets built wrong.
 */
import { cloneElement, isValidElement, type VNode } from 'preact';
import { forwardRef } from 'preact/compat';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import styles from './Tooltip.module.css';

interface TooltipChildProps {
  'aria-describedby'?: string;
  onMouseEnter?: (event: MouseEvent) => void;
  onMouseLeave?: (event: MouseEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export interface TooltipProps {
  content: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** A single element — its props are extended with `aria-describedby`. */
  children: VNode<TooltipChildProps>;
}

/** Runs the child's own handler (if any) first, then the tooltip's. */
function compose<E>(existing: ((event: E) => void) | undefined, ours: (event: E) => void) {
  return (event: E) => {
    existing?.(event);
    ours(event);
  };
}

export const Tooltip = forwardRef<HTMLSpanElement, TooltipProps>(function Tooltip(
  { content, placement = 'top', children },
  ref
) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const show = () => {
    clearTimeout(hideTimer.current);
    setVisible(true);
  };
  // A short delay survives moving focus/pointer between the trigger and the
  // tooltip itself without a visible flicker.
  const hide = () => {
    hideTimer.current = setTimeout(() => setVisible(false), 80);
  };

  if (!isValidElement(children)) return children;

  // `cloneElement` replaces props outright, not merges them — composing with
  // whatever handler the child already had (rather than overwriting it) so a
  // tooltip never silently disables a wrapped control's own interactivity.
  const childProps = children.props;
  const trigger = cloneElement(children, {
    'aria-describedby': visible ? id : undefined,
    onMouseEnter: compose(childProps.onMouseEnter, show),
    onMouseLeave: compose(childProps.onMouseLeave, hide),
    onFocus: compose(childProps.onFocus, show),
    onBlur: compose(childProps.onBlur, hide),
    onKeyDown: compose(childProps.onKeyDown, (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVisible(false);
    })
  });

  return (
    <span ref={ref} className={styles.wrapper}>
      {trigger}
      {visible && (
        <span role="tooltip" id={id} className={`${styles.bubble} ${styles[placement]}`}>
          {content}
        </span>
      )}
    </span>
  );
});
