import { useState, useRef } from 'preact/hooks';
import styles from './CompareSlider.module.css';

interface CompareSliderProps {
  before: preact.ComponentChildren;
  after: preact.ComponentChildren;
}

export function CompareSlider({ before, after }: CompareSliderProps) {
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

  return (
    <div
      ref={containerRef}
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
      <div className={styles.scrubber} style={{ left: `${position}%` }}>
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
}
