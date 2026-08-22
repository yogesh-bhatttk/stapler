/**
 * The tool the current route names.
 *
 * `useParams` only works inside the matching `<Route>`, and the options panel and action
 * bar are siblings of the canvas in the shell — outside it. They read `useParams`
 * originally, which always came back empty, so `findTool` returned null and *neither
 * rendered anything for any tool*: no options, no primary action. Deriving from the
 * location works wherever the component sits.
 */
import { useEffect } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { activeToolId, findTool, type ToolDefinition } from '../core/tools';

const TOOL_ROUTE = /^\/tool\/([^/?#]+)/;

export function useActiveTool(): ToolDefinition | null {
  const [location] = useLocation();
  const tool = findTool(location.match(TOOL_ROUTE)?.[1]);

  // DOC-10's operation log needs "which tool was active" outside any component,
  // in `core/history.ts`, which cannot call a router hook itself.
  useEffect(() => {
    activeToolId.value = tool?.id ?? null;
  }, [tool?.id]);

  return tool;
}
