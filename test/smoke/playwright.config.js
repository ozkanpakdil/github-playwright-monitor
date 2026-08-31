// Minimal Playwright config for the CI smoke run: one page, one CPU-burning
// tab. Set USE_MONOCART=0 to drop the monocart reporter (native-machine CI leg).
const useMonocart = process.env.USE_MONOCART !== '0';
module.exports = {
  testDir: '.',
  testMatch: ['*.e2e.js'],
  workers: 1,
  reporter: useMonocart
    ? [['monocart-reporter', { outputFile: './monocart-smoke/index.html', json: true }]]
    : [['line']],
  use: {
    headless: true,
  },
};