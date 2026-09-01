// Smoke test: spawn corp, do the MCPL host handshake, poke every organ.
// The face window will appear, an expression will show, and a short phrase
// will be spoken aloud. Gamepad/mic events during the perceive window print.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PERCEIVE_S = Number(process.env.SMOKE_PERCEIVE_S ?? '10');
const proc = spawn('node', ['dist/src/index.js', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });

let nextId = 1;
const waiting = new Map();

function request(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error(`timeout waiting for ${method}`)); }, (PERCEIVE_S + 20) * 1000);
  });
}

createInterface({ input: proc.stdout }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { console.log('[non-json]', line); return; }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result); }
    return;
  }
  if (msg.method === 'push/event') {
    console.log('\n>>> PUSH EVENT:', msg.params?.featureSet, '\n' + (msg.params?.payload?.content?.[0]?.text ?? ''));
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { accepted: true } }) + '\n');
    return;
  }
  console.log('[server msg]', JSON.stringify(msg).slice(0, 200));
});

const toolText = (r) => r?.content?.[0]?.text ?? JSON.stringify(r);

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { experimental: { mcpl: { version: '0.5' } } },
    clientInfo: { name: 'smoke-host', version: '0.0.1' },
  });
  console.log('initialize OK:', init.serverInfo.name, '| mcpl:', JSON.stringify(init.capabilities?.experimental?.mcpl?.version));
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const receipt = await request('featureSets/update', {
    effectiveCapabilities: ['tools', 'pushEvents'],
    enabled: ['body.perceive', 'body.touch', 'body.hearing', 'body.voice', 'body.face'],
  });
  console.log('policy receipt:', JSON.stringify(receipt));

  const tools = await request('tools/list', {});
  console.log('tools:', tools.tools.map((t) => t.name).join(', '));

  console.log('\nbody_status:\n' + toolText(await request('tools/call', { name: 'body_status', arguments: {} })));

  console.log('\nface → happy:', toolText(await request('tools/call', { name: 'face_expression', arguments: { name: 'happy' } })));

  console.log('say:', toolText(await request('tools/call', { name: 'say', arguments: { text: 'Salut, Gabriel! The body works.' } })));

  console.log(`\nperceive (${PERCEIVE_S}s) — move a stick, squeeze a trigger, or speak...`);
  console.log(toolText(await request('tools/call', { name: 'perceive', arguments: { timeoutSeconds: PERCEIVE_S } })));

  console.log('\nsmoke test PASSED');
} catch (e) {
  console.error('\nsmoke test FAILED:', e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
}
