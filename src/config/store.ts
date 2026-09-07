import { mkdir, readFile, writeFile, rename, stat, chmod, unlink } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { protectDirectory } from './permissions.js';
import { ImagenError } from '../core/errors.js';
import { parseConfig } from '../core/schema.js';
import type { ImagenConfig, Profile, ResolvedAuth, RuntimePaths } from '../core/types.js';

export function runtimePaths(options: { dataDir?: string; config?: string } = {}): RuntimePaths {
  const dataDir = resolve(options.dataDir ?? (process.env.PLUGIN_DATA ? join(process.env.PLUGIN_DATA, 'imagen') : join(homedir(), '.imagen')));
  return { dataDir, configPath: resolve(options.config ?? join(dataDir, 'config.json')), credentialsPath: join(dataDir, 'credentials.json') };
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) {
        if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(25 * (attempt + 1));
      }
    }
  } finally { await unlink(temp).catch(() => {}); }
}
export async function loadConfig(paths: RuntimePaths): Promise<ImagenConfig> {
  try { return parseConfig(JSON.parse(await readFile(paths.configPath, 'utf8'))); }
  catch (error) {
    if (error instanceof ImagenError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ImagenError('CONFIG_MISSING', `Configure imagen first. Configuration path: ${paths.configPath}`);
    throw new ImagenError('CONFIG_INVALID', 'Unable to read valid configuration JSON. Restore or fix the existing file before configuring profiles.');
  }
}
export async function resolveAuth(profile: Profile, paths: RuntimePaths): Promise<ResolvedAuth> {
  if (profile.auth.kind === 'googleCredentials') {
    try { if (!(await stat(profile.auth.file)).isFile()) throw new Error('file'); }
    catch { throw new ImagenError('CREDENTIAL_MISSING', 'The configured Google credentials file is unavailable.'); }
    return { kind: 'googleCredentials', file: profile.auth.file };
  }
  try {
    const credentials = JSON.parse(await readFile(paths.credentialsPath, 'utf8')) as Record<string, unknown>;
    const key = credentials[profile.auth.credential];
    if (typeof key !== 'string' || !key.trim()) throw new Error('key');
    return { kind: 'apiKey', apiKey: key };
  } catch { throw new ImagenError('CREDENTIAL_MISSING', `Configure credential '${profile.auth.credential}' using imagen configure.`); }
}
export async function saveCredential(paths: RuntimePaths, id: string, secret: string): Promise<void> {
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || !secret.trim()) throw new ImagenError('INVALID_CREDENTIAL', 'A credential name and nonempty secret are required.');
  await mkdir(paths.dataDir, { recursive: true });
  // Restrict the directory before creating credential-bearing temporary files.
  await protectDirectory(paths.dataDir);
  let credentials: Record<string, unknown> = {};
  try { credentials = JSON.parse(await readFile(paths.credentialsPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ImagenError('CREDENTIAL_INVALID', 'Existing credentials file is invalid; restore it before writing.'); }
  credentials[id] = secret.trim();
  await writeJson(paths.credentialsPath, credentials);
  if (process.platform !== 'win32') await chmod(paths.credentialsPath, 0o600);
}
export async function importConfig(paths: RuntimePaths, source: string): Promise<void> {
  let config: ImagenConfig;
  try { config = parseConfig(JSON.parse(await readFile(resolve(source), 'utf8'))); }
  catch (error) { if (error instanceof ImagenError) throw error; throw new ImagenError('CONFIG_INVALID', 'Unable to read the configuration JSON.'); }
  for (const profile of Object.values(config.profiles)) if (profile.auth.kind === 'googleCredentials' && !isAbsolute(profile.auth.file)) throw new ImagenError('CONFIG_INVALID', 'Google credential file paths must be absolute.');
  try { await writeFile(`${paths.configPath}.backup`, await readFile(paths.configPath), { mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeJson(paths.configPath, config);
}
