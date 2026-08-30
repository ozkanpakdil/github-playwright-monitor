// Minimal Playwright config for the CI smoke run: one page, one CPU-burning tab.
module.exports = {
  testDir: '.',
  testMatch: ['*.tests.js'],
  workers: 1,
  reporter: [
    ['monocart-reporter', { outputFile: './monocart-smoke/index.html', json: true }],
  ],
  use: {
    headless: true,
  },
};
