import readline from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {join} from 'node:path';
import {homedir} from 'node:os';

process.env.AI_OFFICE_SETTINGS_PATH ||= join(homedir(), 'Documents', 'Private', '09_AI', 'ai-office-islands', 'settings.yaml');
const {saveIntegrationBridgeConfig} = await import('../server/integrations.mjs');

async function ask(prompt) {
  const rl = readline.createInterface({input: stdin, output: stdout});
  try { return await rl.question(prompt); }
  finally { rl.close(); }
}

async function askSecret(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return ask(prompt);
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  try {
    return await new Promise((resolve, reject) => {
      const onData = character => {
        if (character === '\u0003') { cleanup(); reject(new Error('Cancelled.')); }
        else if (character === '\r' || character === '\n') { cleanup(); stdout.write('\n'); resolve(value); }
        else if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      };
      const cleanup = () => stdin.off('data', onData);
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
  }
}

try {
  const workerUrl = (await ask('Integration Worker URL (https://...): ')).trim();
  const token = (await askSecret('Bridge bearer token (input hidden; stored encrypted): ')).trim();
  const routesText = await ask('Agent routes JSON (e.g. {"future":{"provider":"Hermes"}}): ');
  const agents = JSON.parse(routesText);
  const result = await saveIntegrationBridgeConfig({workerUrl, token, agents});
  stdout.write(`Saved encrypted bridge settings for ${result.agents.length} Agent route(s) at ${result.workerUrl}.\n`);
} catch (error) {
  stdout.write(`Could not save bridge settings: ${error.message}\n`);
  process.exitCode = 1;
}
