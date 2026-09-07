import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const entry = resolve('src/cli/main.ts');
async function cli(dataDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await exec(process.execPath, ['--import', 'tsx', entry, ...args, '--data-dir', dataDir], { env: { ...process.env, ...env }, windowsHide: true });
    return { ...result, code: 0 };
  } catch (error) { const result = error as { stdout: string; stderr: string; code: number }; return result; }
}
test('CLI config and offline doctor do not reveal API keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagen cli 中文 '));
  try {
    let result = await cli(dir, ['configure', '--preset', 'gemini']);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).defaultProfile, 'gemini');
    result = await cli(dir, ['doctor']); assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).networkRequests, 0);
    const secret = 'FAKE_IMAGEN_KEY_FOR_OFFLINE_TEST_ONLY';
    result = await cli(dir, ['configure', '--credential', 'google', '--from-env', 'IMAGEN_TEST_KEY'], { IMAGEN_TEST_KEY: secret });
    assert.equal(result.code, 0); assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    result = await cli(dir, ['doctor']); assert.equal(result.code, 0); assert.ok(!result.stdout.includes(secret));
    const exported = join(dir, 'export.json');
    result = await cli(dir, ['configure', '--export', exported]); assert.equal(result.code, 0);
    assert.ok(!(await readFile(exported, 'utf8')).includes(secret));
    result = await cli(dir, ['configure', '--preset', 'gemini']); assert.equal(result.code, 1); assert.match(result.stderr, /PROFILE_EXISTS/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI never overwrites corrupt configuration while adding presets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagen invalid '));
  try {
    const file = join(dir, 'config.json'); await writeFile(file, '{ corrupt');
    const result = await cli(dir, ['configure', '--preset', 'gemini']);
    assert.equal(result.code, 1); assert.match(result.stderr, /CONFIG_INVALID/);
    assert.equal(await readFile(file, 'utf8'), '{ corrupt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI refuses secret entry without an explicit noninteractive source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagen no-tty '));
  try {
    const result = await cli(dir, ['configure', '--credential', 'google']);
    assert.equal(result.code, 1); assert.match(result.stderr, /CREDENTIAL_INPUT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Official presets use public endpoints and preserve existing profiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagen presets '));
  try {
    const first = await cli(dir, ['configure', '--preset', 'gemini']);
    assert.equal(first.code, 0);
    const configPath = join(dir, 'config.json');
    const original = JSON.parse(await readFile(configPath, 'utf8'));
    original.profiles.custom = { ...original.profiles.gemini, baseUrl: 'https://api.example.com', evidence: 'User-configured service.' };
    original.defaultProfile = 'custom';
    await writeFile(configPath, JSON.stringify(original));
    const second = await cli(dir, ['configure', '--preset', 'openai']);
    assert.equal(second.code, 0);
    const configured = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(configured.profiles.gemini.baseUrl, 'https://generativelanguage.googleapis.com');
    assert.equal(configured.profiles['openai-images'].baseUrl, 'https://api.openai.com/v1');
    assert.deepEqual(configured.profiles.custom, original.profiles.custom);
    assert.equal(configured.defaultProfile, 'custom');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
