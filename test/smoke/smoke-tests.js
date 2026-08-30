// Real browser activity so the /proc tab sampler has something to observe
// and monocart's machine sampler reports non-zero CPU.
const { test, expect } = require('@playwright/test');

test('tab consumes measurable CPU then settles', async ({ page }) => {
  await page.setContent('<h1>smoke</h1>');
  // Spin the renderer for ~2.5 seconds (bounded, well under timeout).
  await page.evaluate(() => {
    return new Promise((resolve) => {
      const end = performance.now() + 2500;
      function busy() {
        if (performance.now() < end) {
          Math.sqrt(Math.random());
          setTimeout(busy, 0);
        } else {
          resolve();
        }
      }
      busy();
    });
  });
  await expect(page.locator('h1')).toHaveText('smoke');
});
