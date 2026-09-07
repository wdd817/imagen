import { execFile } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { ImagenError } from '../core/errors.js';

const execFileAsync = promisify(execFile);

// This program is fixed. The directory is supplied in an environment variable,
// never interpolated into PowerShell syntax or a shell command string.
const WINDOWS_ACL_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($env:IMAGEN_PERMISSION_TARGET)
if (-not [System.IO.Directory]::Exists($target)) { throw 'Expected a directory.' }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$expected = [System.Collections.Generic.HashSet[string]]::new()
[void]$expected.Add($user.Value)
[void]$expected.Add($system.Value)
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$allow = [System.Security.AccessControl.AccessControlType]::Allow

# Start with an empty DACL. Editing an existing ACL would retain unrelated
# explicit grants, even after inheritance has been disabled.
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in $expected) {
  $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $rights, $inherit, $propagation, $allow)
  [void]$acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($target, $acl)

$actual = [System.IO.Directory]::GetAccessControl($target, [System.Security.AccessControl.AccessControlSections]::Access)
if (-not $actual.AreAccessRulesProtected) { throw 'Directory ACL inheritance is still enabled.' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $expected.Count) { throw 'Directory ACL has unexpected entries.' }
$seen = [System.Collections.Generic.HashSet[string]]::new()
foreach ($rule in $rules) {
  if (-not $expected.Contains($rule.IdentityReference.Value) -or $rule.IsInherited -or
      $rule.AccessControlType -ne $allow -or $rule.FileSystemRights -ne $rights -or
      $rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne $propagation) {
    throw 'Directory ACL does not match the required private permissions.'
  }
  [void]$seen.Add($rule.IdentityReference.Value)
}
if (-not $seen.SetEquals($expected)) { throw 'Directory ACL is missing a required identity.' }
`;

/** Protect an existing state directory before writing any credential-bearing file. */
export async function protectDirectory(path: string): Promise<void> {
  try {
    const directory = resolve(path);
    if (!(await stat(directory)).isDirectory()) throw new Error('Expected a directory');
    if (process.platform === 'win32') {
      await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-EncodedCommand', Buffer.from(WINDOWS_ACL_PROGRAM, 'utf16le').toString('base64'),
      ], {
        env: { ...process.env, IMAGEN_PERMISSION_TARGET: directory },
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 128 * 1024,
      });
    } else {
      await chmod(directory, 0o700);
      if (((await stat(directory)).mode & 0o777) !== 0o700) throw new Error('Directory permissions were not applied');
    }
  } catch {
    // Child-process diagnostics can include local paths. Keep the public error
    // fixed and ensure callers cannot continue writing credentials on failure.
    throw new ImagenError('CREDENTIAL_PERMISSIONS', 'Unable to apply and verify private credential directory permissions.');
  }
}
