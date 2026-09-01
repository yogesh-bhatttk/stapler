/**
 * Resolves a tool's icon name to a component.
 *
 * The registry in `core/tools.ts` names icons as strings so that core stays free of
 * UI imports (PLAN §2.2 keeps the layers separable for the website twin). This map
 * is the single place that binding happens.
 */
import {
  BookOpen,
  Columns2,
  Eraser,
  FileImage,
  FilePlus,
  FileSearch,
  FileText,
  FileType,
  History,
  Image as ImageIcon,
  ImageDown,
  Layers,
  LayoutGrid,
  ListTree,
  Minimize2,
  PenTool,
  ShieldAlert,
  Sparkles,
  SplitSquareHorizontal,
  Volume2,
  type LucideIcon
} from 'lucide-preact';
import { forwardRef } from 'preact/compat';

const ICONS: Record<string, LucideIcon> = {
  BookOpen,
  Columns2,
  Eraser,
  FileImage,
  FilePlus,
  FileSearch,
  FileText,
  FileType,
  History,
  Image: ImageIcon,
  ImageDown,
  Layers,
  LayoutGrid,
  ListTree,
  Minimize2,
  PenTool,
  ShieldAlert,
  Sparkles,
  SplitSquareHorizontal,
  Volume2
};

export const ToolIcon = forwardRef<SVGSVGElement, { name: string; size?: number }>(
  function ToolIcon({ name, size = 16 }, ref) {
    const Icon = ICONS[name] ?? FileText;
    return <Icon ref={ref} size={size} aria-hidden="true" />;
  }
);

export function toolIconComponent(name: string): LucideIcon {
  return ICONS[name] ?? FileText;
}
