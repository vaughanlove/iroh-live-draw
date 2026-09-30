// Harness runner: node harness.mjs <scenario> [--app-url URL]
// Exit non-zero on the first failed expectation.
const scenario = process.argv[2] ?? 'live';
const appUrlArg = process.argv.find((a) => a.startsWith('--app-url='));
if (appUrlArg) process.env.APP_URL = appUrlArg.split('=')[1];

const mod = await import(`./scenarios/${scenario}.mjs`).catch(() => null);
if (!mod?.default) {
  console.error(`unknown scenario: ${scenario}`);
  process.exit(2);
}
try {
  await mod.default();
} catch (e) {
  console.error('SCENARIO FAILED:', e?.message ?? e);
  process.exit(1);
}
