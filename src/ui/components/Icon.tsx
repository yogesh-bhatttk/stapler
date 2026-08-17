import type { LucideIcon, LucideProps } from 'lucide-preact';
import { forwardRef } from 'preact/compat';

export interface IconProps extends Omit<LucideProps, 'ref'> {
  icon: LucideIcon;
}

/**
 * Renders a Lucide icon at a consistent default size, hidden from assistive tech.
 *
 * Icons here are always decorative — every control that carries one also carries a text
 * label or an `aria-label` — so `aria-hidden` is the right default rather than something
 * each call site has to remember.
 */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { icon: IconComponent, size = 16, color = 'currentColor', ...props },
  ref
) {
  return <IconComponent ref={ref} size={size} color={color} aria-hidden="true" {...props} />;
});
