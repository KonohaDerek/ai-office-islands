import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('native local startup leaves encryption keys in macOS Keychain', async () => {
  const launcher = await readFile(new URL('scripts/dev-local.sh', root), 'utf8');
  const guide = await readFile(new URL('docs/local-use.md', root), 'utf8');
  const nativeGuide = guide.split('## Docker Compose')[0];
  assert.match(launcher, /unset AI_OFFICE_ENCRYPTION_KEY AI_OFFICE_ENCRYPTION_KEY_FILE/);
  assert.doesNotMatch(launcher, /\.secrets\/ai-office\.env/);
  assert.match(nativeGuide, /macOS Keychain/);
  assert.doesNotMatch(nativeGuide, /openssl rand.*AI_OFFICE_ENCRYPTION_KEY/);
});
