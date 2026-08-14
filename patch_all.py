import sys

# 1. Fix AccPanel
f = "src/ui/tools/acc/AccPanel.tsx"
with open(f, 'r') as file:
    content = file.read()
content = content.replace("color: '#666'", "color: 'var(--text-secondary)'")
with open(f, 'w') as file:
    file.write(content)

# 2. Add e2e test for paste
test_code = """
test('CNV-07: Paste image as page from clipboard', async ({ page, context }) => {
  await openApp(page);
  // Need to bypass clipboard permissions in Playwright
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // Write a small image to the clipboard using JS evaluation
  await page.evaluate(async () => {
    // 1x1 red PNG
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await fetch(`data:image/png;base64,${base64}`);
    const blob = await res.blob();
    const item = new ClipboardItem({ 'image/png': blob });
    await navigator.clipboard.write([item]);
  });

  // Trigger paste
  await page.keyboard.press('Control+V'); // or just 'Paste'? Playwright doesn't easily trigger the system paste without a focused input. 
  // Let's dispatch a paste event manually on window
  await page.evaluate(() => {
    window.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
  });

  // The importImages dialog should appear
  const dialog = page.getByRole('dialog', { name: /Import 1 image/ });
  await dialog.getByRole('button', { name: 'Add' }).click();

  // A new page should appear
  await expect(page.locator('.page-grid img')).toHaveCount(1);
});
"""
f_test = "tests/e2e/import.spec.ts"
with open(f_test, 'a') as file:
    file.write(test_code)

