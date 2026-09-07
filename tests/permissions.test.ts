import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, type TestContext } from 'node:test';
import { protectDirectory } from '../src/config/permissions.js';
import { ImagenError } from '../src/core/errors.js';

const execFileAsync = promisify(execFile);
const SETUP_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:IMAGEN_PERMISSION_TEST_DIRECTORY
$acl = [System.IO.Directory]::GetAccessControl($target)
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($target, $acl)
`;
const READ_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:IMAGEN_PERMISSION_TEST_DIRECTORY
function Describe-Access($acl) {
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  return @{
    protected = $acl.AreAccessRulesProtected
    rules = @($rules | ForEach-Object { @{
      sid = $_.IdentityReference.Value
      inherited = $_.IsInherited
      type = $_.AccessControlType.ToString()
      rights = [int]$_.FileSystemRights
      inheritance = [int]$_.InheritanceFlags
      propagation = [int]$_.PropagationFlags
    } })
  }
}
$result = @{
  currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  directory = Describe-Access ([System.IO.Directory]::GetAccessControl($target))
}
$file = [System.IO.Path]::Combine($target, 'fake-credentials.json')
if ([System.IO.File]::Exists($file)) { $result.file = Describe-Access ([System.IO.File]::GetAccessControl($file)) }
$result | ConvertTo-Json -Depth 5 -Compress
`;
interface AccessRule { sid: string; inherited: boolean; type: string; rights: number; inheritance: number; propagation: number }
interface AccessSummary { protected: boolean; rules: AccessRule[] }
interface AclSummary { currentUserSid: string; directory: AccessSummary; file?: AccessSummary }

async function windowsProgram(program: string, directory: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(program, 'utf16le').toString('base64'),
  ], { env: { ...process.env, IMAGEN_PERMISSION_TEST_DIRECTORY: directory }, windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024 });
  return stdout;
}
async function temporaryDirectory(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'imagen-permissions-'));
  t.after(async () => {
    // Recursive cleanup is confined to the exact temporary root created here.
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  // These characters are valid in Windows filenames but dangerous in interpolated
  // shell expressions. Both implementation and tests pass this path separately.
  const directory = join(root, "private 中文 [scope] ' $(Write-Output injected); folder");
  await mkdir(directory);
  return directory;
}

test('Windows replaces explicit Everyone access and new credential files inherit only user and SYSTEM access', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const directory = await temporaryDirectory(t);
  await windowsProgram(SETUP_ACL, directory);
  const before: AclSummary = JSON.parse(await windowsProgram(READ_ACL, directory));
  assert.ok(before.directory.rules.some(rule => rule.sid === 'S-1-1-0' && !rule.inherited && rule.type === 'Allow'));
  await protectDirectory(directory);
  await protectDirectory(directory); // Repeated configuration must remain safe.
  await writeFile(join(directory, 'fake-credentials.json'), JSON.stringify({ fake: 'offline-test-value' }));
  const after: AclSummary = JSON.parse(await windowsProgram(READ_ACL, directory));
  const expected = new Set([after.currentUserSid, 'S-1-5-18']);
  assert.equal(after.directory.protected, true);
  assert.equal(after.directory.rules.length, expected.size);
  assert.deepEqual(new Set(after.directory.rules.map(rule => rule.sid)), expected);
  for (const rule of after.directory.rules) {
    assert.equal(rule.inherited, false);
    assert.equal(rule.type, 'Allow');
    assert.equal(rule.rights, 2_032_127); // FileSystemRights.FullControl
    assert.equal(rule.inheritance, 3); // ContainerInherit | ObjectInherit
    assert.equal(rule.propagation, 0);
  }
  assert.ok(after.file);
  assert.equal(after.file.rules.length, expected.size);
  assert.deepEqual(new Set(after.file.rules.map(rule => rule.sid)), expected);
  assert.ok(after.file.rules.every(rule => rule.inherited && rule.type === 'Allow' && rule.rights === 2_032_127));
  assert.equal(await readFile(join(directory, 'fake-credentials.json'), 'utf8'), '{"fake":"offline-test-value"}');
});

test('POSIX state directories become owner-only and remain usable', { skip: process.platform === 'win32' }, async t => {
  const directory = await temporaryDirectory(t);
  await chmod(directory, 0o755);
  await protectDirectory(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  await writeFile(join(directory, 'fake-credentials.json'), '{"fake":"offline-test-value"}', { mode: 0o600 });
  assert.equal((await stat(join(directory, 'fake-credentials.json'))).mode & 0o777, 0o600);
});

test('Invalid credential directories fail closed with a fixed public error', async t => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'not secret');
  for (const target of [file, join(directory, 'missing-directory')]) {
    await assert.rejects(protectDirectory(target), (error: unknown) => error instanceof ImagenError && error.code === 'CREDENTIAL_PERMISSIONS' && !error.message.includes(target));
  }
});
