// Launches the packaged app, opens every tab and the setup wizard, and fails on any
// renderer error or a main process that dies. Run after `npm run package` on Windows CI
// so an Electron upgrade is proven on the OS the carts use.
// Usage: node .erb/scripts/smoke-electron.mjs <path to packaged exe>
import { _electron as electron } from 'playwright';

const exe = process.argv[2];
const app = await electron.launch({ executablePath: exe, timeout: 60000 });
const errors = [];
let closing = false;
let exited = false;
app.process().on('exit', (code) => {
    exited = true;
    if (!closing) errors.push(`main process exited (${code})`);
});
const win = await app.firstWindow({ timeout: 60000 });
win.on('pageerror', (e) => errors.push(`renderer: ${e.message}`));
win.on('console', (m) => { if (m.type() === 'error') errors.push(`renderer console: ${m.text()}`); });
await win.waitForLoadState('domcontentloaded');

const versions = await app.evaluate(() => process.versions);
console.log(`electron ${versions.electron}, node ${versions.node}, chrome ${versions.chrome}`);

const tabs = ['vMix / X-Air', 'Bitfocus', 'Live Captions', 'Auto AV', 'Upload', 'Offseason AD', 'Setup'];
for (const tab of tabs) {
    await win.getByText(tab, { exact: true }).first().click({ timeout: 10000 });
    await win.waitForTimeout(2000);
    console.log(`opened ${tab}`);
}
await win.getByText("Let's Get Started").click({ timeout: 10000 });
await win.waitForTimeout(2000);
console.log('opened setup wizard');

closing = true;
if (!exited) await app.close();
if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
}
console.log('smoke test passed');
