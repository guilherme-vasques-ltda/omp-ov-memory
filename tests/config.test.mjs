import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateEndpoint, EXTENSION_CONFIG_DEFAULTS } from '../src/config.ts';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ov-config-'));
  mkdirSync(join(home, '.openviking'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const write = (name, obj) => writeFileSync(join(home, '.openviking', name), JSON.stringify(obj));
  const read = (config = {}, env = {}) => loadConfig(home, { home, env, config });
  return { home, write, read };
}

test('defaults match brief and keep compatible engine fields', t => {
  const { home, read } = fixture(t);
  const cfg = read();
  assert.equal(cfg.endpoint, 'http://127.0.0.1:1933');
  assert.equal(cfg.takeover.enabled, false);
  assert.equal(cfg.takeover.tokenThreshold, 30000);
  assert.equal(cfg.takeover.contextTokenThreshold, 30000);
  assert.equal(cfg.takeover.keepRecentTurns, 3);
  assert.equal(cfg.archive.chunkTokenBudget, 50000);
  assert.equal(cfg.resumeContextBudget, 32000);
  assert.equal(cfg.commitTokenThreshold, 20000);
  assert.equal(cfg.requestTimeoutMs, 2000);
  assert.equal(cfg.stateDir, join(home, '.openviking', 'omp-ov-memory'));
  assert.equal(EXTENSION_CONFIG_DEFAULTS.recallTokenBudget, 2000);
  cfg.bypassPatterns.push('private');
  assert.deepEqual(read().bypassPatterns, []);
});

test('credentials resolve per field env then ovcli then ov.conf', t => {
  const { write, read } = fixture(t);
  write('ov.conf', { server: { url: 'https://server.example', root_api_key: 'server-key', account: 'server-account', user: 'server-user', peer_id: 'server-peer' } });
  write('ovcli.conf', { url: 'https://cli.example', api_key: 'cli-key', user_id: 'cli-user' });
  const cfg = read({}, { OPENVIKING_API_KEY: 'env-key', OPENVIKING_USER: 'env-user', OPENVIKING_PEER_ID: 'env-peer' });
  assert.equal(cfg.endpoint, 'https://cli.example');
  assert.equal(cfg.apiKey, 'env-key');
  assert.equal(cfg.account, 'server-account');
  assert.equal(cfg.user, 'env-user');
  assert.equal(cfg.peerId, 'env-peer');
  assert.equal(read().apiKey, 'cli-key');
});

test('server-only credentials and wildcard bind fall back to loopback', t => {
  const { write, read } = fixture(t);
  write('ov.conf', { server: { host: '0.0.0.0', port: 1934, root_api_key: 'server-key' } });
  assert.equal(read().endpoint, 'http://127.0.0.1:1934');
  assert.equal(read().apiKey, 'server-key');
});

test('remote credential HTTP and URL embedded credentials fail without echoing values', () => {
  assert.throws(() => validateEndpoint('http://remote.example', 'secret-value'), /require HTTPS/);
  assert.throws(() => validateEndpoint('https://name:secret-value@remote.example'), error => !error.message.includes('secret-value'));
  assert.equal(validateEndpoint('http://127.1.2.3:1933', 'key'), 'http://127.1.2.3:1933');
  assert.equal(validateEndpoint('http://[::1]:1933', 'key'), 'http://[::1]:1933');
  assert.throws(() => validateEndpoint('file:///tmp/ov'), /HTTP/);
});

test('user config merges nested fields and takeover aliases stay aligned', t => {
  const { home, write, read } = fixture(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ takeover: { enabled: false, tokenThreshold: 30000, keepRecentTurns: 3 } }));
  write('omp-ov-memory.jsonc', { takeover: { contextTokenThreshold: 40000 }, archive: { rawTailTokenBudget: 5000 }, recallLimit: 7 });
  const cfg = read({ takeover: { tokenThreshold: 45000 } });
  assert.equal(cfg.takeover.tokenThreshold, 45000);
  assert.equal(cfg.takeover.contextTokenThreshold, 45000);
  assert.equal(cfg.takeover.keepRecentTurns, 3);
  assert.equal(cfg.archive.rawTailTokenBudget, 5000);
  assert.equal(cfg.archive.chunkTokenBudget, 50000);
  assert.equal(cfg.recallLimitConfigured, true);
});

test('invalid config fails closed without leaking malformed file contents', t => {
  const { home, read } = fixture(t);
  assert.throws(() => read({ requestTimeoutMs: 2001 }), /requestTimeoutMs/);
  assert.throws(() => read({ captureAllowlist: [1] }), /string array/);
  assert.throws(() => read({ handoff: { enabled: 'yes' } }), /boolean/);
  assert.throws(() => read({ unkown: true }), /Unknown/);
  writeFileSync(join(home, '.openviking', 'ovcli.conf'), '{"api_key":"private-key" INVALID}');
  assert.throws(() => read(), error => !error.message.includes('private-key') && /Invalid/.test(error.message));
});
