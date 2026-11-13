// Run with BetterNCM's bundled Node; evaluate a diagnostic expression from stdin.
import fs from 'node:fs';
import { connectBrowser } from '/Applications/BetterNCM.app/Contents/Resources/app/src/cdp.mjs';
const profile = `${process.env.HOME}/Library/Application Support/BetterNCM-mac`;
const state = JSON.parse(fs.readFileSync(`${profile}/run/state.json`, 'utf8'));
const cdp = await connectBrowser(state.cdpPort);
try {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find(t => t.type === 'page' && t.url.startsWith('orpheus://'));
  if (!target) throw new Error('NetEase main page is unavailable');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const result = await cdp.send('Runtime.evaluate', {
    expression: fs.readFileSync(0, 'utf8'), returnByValue: true, awaitPromise: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  console.log(JSON.stringify(result.result.value, null, 2));
} finally {
  cdp.close();
}
