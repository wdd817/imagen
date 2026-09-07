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
    let result = await cli(dir, ['configure', '--preset', 'example']);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).defaultProfile, 'example-gemini');
    result = await cli(dir, ['doctor']); assert.equal(result.code, 1); assert.equal(JSON.parse(result.stdout).networkRequests, 0);
    const secret = 'FAKE_IMAGEN_KEY_FOR_OFFLINE_TEST_ONLY';
    result = await cli(dir, ['configure', '--credential', 'example', '--from-env', 'IMAGEN_TEST_KEY'], { IMAGEN_TEST_KEY: secret });
    assert.equal(result.code, 0); assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    result = await cli(dir, ['doctor']); assert.equal(result.code, 0); assert.ok(!result.stdout.includes(secret));
    const exported = join(dir, 'export.json');
    result = await cli(dir, ['configure', '--export', exported]); assert.equal(result.code, 0);
    assert.ok(!(await readFile(exported, 'utf8')).includes(secret));
    result = await cli(dir, ['configure', '--preset', 'example']); assert.equal(result.code, 1); assert.match(result.stderr, /PROFILE_EXISTS/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI never overwrites corrupt configuration while adding presets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagen invalid '));
  try {
    const file = join(dir, 'config.json'); await writeFile(file, '{ corrupt');
    const result = await cli(dir, ['configure', '--preset', 'example']);
    assert.equal(result.code, 1); assert.match(result.stderr, /CONFIG_INVALID/);
    assert.equal(await readFile(file, 'utf8'), '{ corrupt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('CLI refuses secret entry without an explicit noninteractive source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'imagen no-tty '));
  try {
    const result = await cli(dir, ['configure', '--credential', 'example']);
    assert.equal(result.code, 1); assert.match(result.stderr, /CREDENTIAL_INPUT/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
