/**
 * The grouped, searchable tool list shared by the home launcher and the
 * phone-width tools sheet (GAP-3), so the two can never disagree about which
 * tools exist, how they are grouped, or what a query matches.
 */
import { TOOLS, groupedTools, toolGroupLabel, type ToolDefinition } from '../core/tools';
import { fuzzyRank } from '../core/fuzzy';

export interface ToolSection {
  /** A stable identifier: the registry group, or `'Matches'` while searching. */
  group: string;
  /** Already translated. */
  label: string;
  tools: ToolDefinition[];
}

export function searchToolGroups(query: string, t: (key: string) => string): ToolSection[] {
  if (!query.trim()) {
    return groupedTools().map(entry => ({ ...entry, label: t(toolGroupLabel(entry.group)) }));
  }
  // While searching, a single ranked list beats four sparse groups. The
  // haystack holds the translated text *and* the English, so a query in
  // either language finds the tool.
  const matches = fuzzyRank(TOOLS, query, tool => [
    `${t(tool.title)} ${t(toolGroupLabel(tool.group))} ${t(tool.summary)}`,
    `${tool.title} ${tool.group} ${tool.summary}`
  ]);
  return matches.length > 0 ? [{ group: 'Matches', label: t('Matches'), tools: matches }] : [];
}
