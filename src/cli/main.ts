import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEngine } from '../core/engine.js';
import { ImagenError, publicError } from '../core/errors.js';
import { importConfig, loadConfig, resolveAuth, runtimePaths, saveCredential, writeJson } from '../config/store.js';
import { parseConfig } from '../core/schema.js';
import { runMcp } from '../mcp/server.js';
import type { ImagenConfig, Profile } from '../core/types.js';
import packageInfo from '../../package.json' with { type: 'json' };

// Some SDK diagnostics use console.debug, which is stdout in Node. Protocol/JSON
// output is reserved for callers; SDK debug diagnostics are deliberately disabled.
console.debug = () => {};
const VERSION = packageInfo.version;
const usage = `imagen ${VERSION} — image generation and editing for agents

Commands:
  generate --prompt TEXT --out DIR [--profile NAME] [--reference FILE]
  edit --prompt TEXT --target FILE --out DIR [--mask FILE]
  generate|edit --request REQUEST.json
  job|wait|cancel|recover JOB_ID
  capabilities                    List configured profiles and declared capabilities
  doctor                          Offline installation and credential diagnostics
  configure --import CONFIG.json  Import a profile configuration
  configure --export CONFIG.json  Export profiles (never API keys)
  configure --preset gemini        Add an official Gemini Developer API profile
  configure --preset openai        Add an official OpenAI Images API profile
  configure --preset vertex --project ID --location REGION --google-credentials FILE
  configure --credential NAME [--from-env ENV_NAME | --stdin]
  mcp                             Start the stdio MCP server

Common flags: --data-dir DIR --config FILE --json --help --version
Generation: --request-id ID --count N --timeout-ms N --options-file FILE
CLI runs in the foreground. MCP returns a job ID for asynchronous polling.
All API calls use explicit profiles. No implicit provider or protocol fallback.
`;

async function hiddenSecret(): Promise<string> {
  if (!process.stdin.isTTY) throw new ImagenError('CREDENTIAL_INPUT', 'Use --stdin or --from-env when no interactive terminal is available.');
  process.stderr.write('API key (hidden): ');
  return new Promise((resolveSecret, reject) => {
    let value = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stderr.write('\n'); };
    const onData = (chunk: string | Buffer) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') { finish(); reject(new ImagenError('CANCELLED', 'Credential entry cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); resolveSecret(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}
async function stdinSecret(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) { input += String(chunk); if (input.length > 65536) throw new ImagenError('CREDENTIAL_INPUT', 'Credential input is too large.'); }
  return input.trim();
}
function baseCapabilities(mask = false) { return { generate: 'supported', edit: 'supported', references: 'supported', mask: mask ? 'supported' : 'unsupported' } as const; }

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, json: { type: 'boolean' },
      'data-dir': { type: 'string' }, config: { type: 'string' }, profile: { type: 'string' },
      prompt: { type: 'string' }, out: { type: 'string' }, target: { type: 'string' }, mask: { type: 'string' },
      reference: { type: 'string', multiple: true }, request: { type: 'string' }, 'request-id': { type: 'string' },
      count: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'options-file': { type: 'string' },
      import: { type: 'string' }, export: { type: 'string' }, preset: { type: 'string' },
      credential: { type: 'string' }, 'from-env': { type: 'string' }, stdin: { type: 'boolean' },
      project: { type: 'string' }, location: { type: 'string' }, 'google-credentials': { type: 'string' },
    },
  });
  const command = positionals[0];
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help || !command) { process.stdout.write(usage); return; }
  const paths = runtimePaths({ dataDir: values['data-dir'], config: values.config });
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === 'mcp') { await runMcp(paths); return; }
  if (command === 'configure') {
    const operations = [values.import, values.export, values.preset, values.credential].filter(Boolean);
    if (operations.length !== 1) throw new ImagenError('CONFIGURE_USAGE', 'Choose one of --import, --export, --preset or --credential.');
    if (values.import) { await importConfig(paths, values.import); print({ configured: true, configPath: paths.configPath }); return; }
    if (values.export) { const config = await loadConfig(paths); await writeFile(resolve(values.export), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); print({ exported: true, path: resolve(values.export), includesApiKeys: false }); return; }
    if (values.credential) {
      if (values['from-env'] && values.stdin) throw new ImagenError('CONFIGURE_USAGE', 'Use only one credential source.');
      const secret = values['from-env'] ? process.env[values['from-env']] ?? '' : values.stdin ? await stdinSecret() : await hiddenSecret();
      await saveCredential(paths, values.credential, secret);
      print({ credential: values.credential, saved: true }); return;
    }
    let config: ImagenConfig;
    try { config = await loadConfig(paths); }
    catch (error) { if (!(error instanceof ImagenError) || error.code !== 'CONFIG_MISSING') throw error; config = { schemaVersion: 1, profiles: {} }; }
    const add = (name: string, profile: Profile) => {
      if (config.profiles[name]) throw new ImagenError('PROFILE_EXISTS', `Profile '${name}' already exists. Export and edit the configuration to change it.`);
      config.profiles[name] = profile;
    };
    if (values.preset === 'gemini') {
      add('gemini', { protocol: 'gemini', platform: 'developer', model: 'gemini-3.1-flash-image', baseUrl: 'https://generativelanguage.googleapis.com', apiVersion: 'v1beta', auth: { kind: 'apiKey', credential: 'google' }, maxCount: 1, maxInputImages: 8, capabilities: baseCapabilities(), evidence: 'Configured Gemini Developer API image profile; verify model access and capabilities for your account.' });
      config.defaultProfile ??= 'gemini';
    } else if (values.preset === 'openai') {
      add('openai-images', { protocol: 'images', model: 'gpt-image-2', baseUrl: 'https://api.openai.com/v1', auth: { kind: 'apiKey', credential: 'openai' }, maxCount: 1, maxInputImages: 8, capabilities: { ...baseCapabilities(), mask: 'supported' }, evidence: 'Provider-documented image capabilities; verify model access for your account.' });
      config.defaultProfile ??= 'openai-images';
    } else if (values.preset === 'vertex') {
      if (!values.project || !values.location || !values['google-credentials']) throw new ImagenError('CONFIGURE_USAGE', 'Vertex requires --project, --location and --google-credentials.');
      add('vertex-gemini', { protocol: 'gemini', platform: 'vertex', model: 'gemini-3.1-flash-image', project: values.project, location: values.location, auth: { kind: 'googleCredentials', file: resolve(values['google-credentials']) }, capabilities: baseCapabilities(), evidence: 'Configured Vertex Gemini profile; confirm model access for this project/location.', maxCount: 1, maxInputImages: 8 });
      config.defaultProfile ??= 'vertex-gemini';
    } else throw new ImagenError('CONFIGURE_USAGE', 'Supported presets: gemini, openai, vertex.');
    await writeJson(paths.configPath, parseConfig(config));
    print({ configured: true, configPath: paths.configPath, defaultProfile: config.defaultProfile }); return;
  }
  if (command === 'doctor') {
    const checks: { name: string; ok: boolean; message?: string }[] = [{ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 24 }];
    try {
      const config = await loadConfig(paths); checks.push({ name: 'config', ok: true });
      for (const [name, profile] of Object.entries(config.profiles)) {
        try { await resolveAuth(profile, paths); checks.push({ name: `credential:${name}`, ok: true }); }
        catch (error) { checks.push({ name: `credential:${name}`, ok: false, message: publicError(error).message }); }
      }
    } catch (error) { checks.push({ name: 'config', ok: false, message: publicError(error).message }); }
    print({ version: VERSION, dataDir: paths.dataDir, configPath: paths.configPath, checks, networkRequests: 0 });
    if (checks.some(c => !c.ok)) process.exitCode = 1;
    return;
  }
  const engine = await createEngine(paths);
  const stop = () => { void engine.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (command === 'capabilities') { print(await engine.capabilities()); return; }
    if (['job', 'wait', 'cancel', 'recover'].includes(command)) {
      const id = positionals[1]; if (!id) throw new ImagenError('JOB_REQUIRED', 'Provide a job ID.');
      const job = await (command === 'job' ? engine.get(id) : command === 'wait' ? engine.wait(id) : command === 'cancel' ? engine.cancel(id) : engine.recover(id));
      print(job); if (['failed', 'unknown'].includes(job.status)) process.exitCode = 1; return;
    }
    if (command !== 'generate' && command !== 'edit') throw new ImagenError('UNKNOWN_COMMAND', 'Unknown command. Run imagen --help.');
    let request: Record<string, unknown>;
    if (values.request) {
      request = JSON.parse(await readFile(resolve(values.request), 'utf8'));
      if (request.operation && request.operation !== command) throw new ImagenError('INVALID_REQUEST', 'Request operation does not match the command.');
    } else {
      request = { prompt: values.prompt, outputDir: values.out ? resolve(values.out) : undefined, ...(values.target ? { targetImage: resolve(values.target) } : {}), referenceImages: (values.reference ?? []).map(file => resolve(file)), ...(values.mask ? { mask: resolve(values.mask) } : {}), count: values.count ? Number(values.count) : 1, timeoutMs: values['timeout-ms'] ? Number(values['timeout-ms']) : 300000, providerOptions: values['options-file'] ? JSON.parse(await readFile(resolve(values['options-file']), 'utf8')) : {} };
    }
    request.operation = command; request.requestId ??= values['request-id'] ?? randomUUID();
    request.profile ??= values.profile ?? (await loadConfig(paths)).defaultProfile;
    const submitted = await engine.submit(request);
    if (!values.json) process.stderr.write(`Job ${submitted.jobId}\n`);
    const job = await engine.wait(submitted.jobId);
    print(job); if (job.status !== 'succeeded') process.exitCode = 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); await engine.close(); }
}
main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
  process.exitCode = 1;
});
