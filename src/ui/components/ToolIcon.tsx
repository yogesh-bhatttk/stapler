/**
 * Resolves a tool's icon name to a component.
 *
 * The registry in `core/tools.ts` names icons as strings so that core stays free of
 * UI imports (PLAN §2.2 keeps the layers separable for the website twin). This map
 * is the single place that binding happens.
 */
import {
  Eraser,
  FilePlus,
  FileSearch,
  FileText,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  Minimize2,
  PenTool,
  ShieldAlert,
  Sparkles,
  SplitSquareHorizontal,
  type LucideIcon
} from 'lucide-preact';

const ICONS: Record<string, LucideIcon> = {
  Eraser,
  FilePlus,
  FileSearch,
  FileText,
  Image: ImageIcon,
  Layers,
  LayoutGrid,
  Minimize2,
  PenTool,
  ShieldAlert,
  Sparkles,
  SplitSquareHorizontal
};

export function ToolIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = ICONS[name] ?? FileText;
  return <Icon size={size} aria-hidden="true" />;
}

export function toolIconComponent(name: string): LucideIcon {
  return ICONS[name] ?? FileText;
}
