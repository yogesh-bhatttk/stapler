import { useState, useRef } from 'preact/hooks';
import { forwardRef } from 'preact/compat';
import { mergeRefs } from './mergeRefs';
import styles from './CompareSlider.module.css';

interface CompareSliderProps {
  before: preact.ComponentChildren;
  after: preact.ComponentChildren;
  /** Describes the two visual states controlled by the divider. */
  label?: string;
}

export const CompareSlider = forwardRef<HTMLDivElement, CompareSliderProps>(function CompareSlider(
  { before, after, label = 'Compare before and after' },
  ref
) {
  const [position, setPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handlePointerDown = (e: preact.JSX.TargetedPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    updatePosition(e.clientX);
  };

  const handlePointerMove = (e: preact.JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      updatePosition(e.clientX);
    }
  };

  const handlePointerUp = (e: preact.JSX.TargetedPointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setIsDragging(false);
  };

  const updatePosition = (clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    setPosition((x / rect.width) * 100);
  };

  const onKeyDown = (event: preact.JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = position - step;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = position + step;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = 100;
    if (next === null) return;
    event.preventDefault();
    setPosition(Math.max(0, Math.min(100, next)));
  };

  return (
    <div
      ref={mergeRefs(containerRef, ref)}
      className={styles.container}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className={styles.beforeLayer}>{before}</div>
      <div
        className={styles.afterLayer}
        style={{ clipPath: `polygon(${position}% 0, 100% 0, 100% 100%, ${position}% 100%)` }}
      >
        {after}
      </div>
      <div
        className={styles.scrubber}
        style={{ left: `${position}%` }}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${Math.round(position)}% after image visible`}
        onKeyDown={onKeyDown}
      >
        <div className={styles.handle}>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </div>
      </div>
    </div>
  );
});
