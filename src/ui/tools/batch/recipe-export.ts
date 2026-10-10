/**
 * The batch tool's "Export recipes" download.
 *
 * AUDIT-2026-10-10 L8 — the object URL used to be revoked synchronously
 * right after `click()`. The click only *starts* the download; Firefox (and
 * Chrome under load) resolve the URL afterwards, so a same-tick revoke could
 * fail the save. Revoked later, like `saveViaDownload` in the platform layer.
 */

/** How long the object URL outlives the click. */
export const RECIPE_EXPORT_REVOKE_MS = 60_000;

export function downloadRecipesJson(recipes: unknown, fileName = 'stapler-recipes.json'): void {
  const blob = new Blob([JSON.stringify(recipes, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), RECIPE_EXPORT_REVOKE_MS);
}
