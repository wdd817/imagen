import Ajv2020 from 'ajv/dist/2020.js';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDirectory = join(root, 'schemas', 'agent-plugins');

async function containedFile(pluginRoot, path) {
  const absolute = await realpath(path);
  const rel = relative(pluginRoot, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Plugin file escapes its root: ${path}`);
  if (!(await stat(absolute)).isFile()) throw new Error(`Plugin file is not a regular file: ${path}`);
  return absolute;
}

export async function validatePlugin(inputRoot = join(root, 'dist', 'imagen')) {
  const pluginRoot = await realpath(resolve(inputRoot));
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const documents = {};
  for (const name of ['plugin', 'mcp']) {
    const schema = JSON.parse(await readFile(join(schemaDirectory, `${name}.schema.json`), 'utf8'));
    const document = JSON.parse(await readFile(await containedFile(pluginRoot, join(pluginRoot, `${name}.json`)), 'utf8'));
    const validate = ajv.compile(schema);
    if (!validate(document)) throw new Error(`${name}.json violates Agent Plugins 1.0.0: ${ajv.errorsText(validate.errors)}`);
    documents[name] = document;
  }
  for (const [name, server] of Object.entries(documents.mcp.mcpServers)) {
    if (server.type !== 'stdio') throw new Error(`Unexpected remote MCP server in imagen package: ${name}`);
    if (server.command.startsWith('./')) await containedFile(pluginRoot, join(pluginRoot, server.command));
    else if (!/^[a-zA-Z0-9_.-]+$/.test(server.command)) throw new Error(`Invalid executable token: ${server.command}`);
    for (const value of [...(server.args ?? []), ...Object.values(server.env ?? {}), server.cwd ?? '${PLUGIN_ROOT}']) {
      if (/\$\{(?!PLUGIN_ROOT\}|PLUGIN_DATA\})/.test(value)) throw new Error('Only standard plugin placeholders are supported.');
    }
    for (const value of server.args ?? []) {
      if (value.startsWith('${PLUGIN_ROOT}/')) await containedFile(pluginRoot, resolve(pluginRoot, value.slice('${PLUGIN_ROOT}/'.length)));
    }
    if (server.cwd !== undefined && server.cwd !== '${PLUGIN_ROOT}') throw new Error('imagen MCP must run from the plugin root.');
  }
  const skillsRoot = join(pluginRoot, 'skills');
  const skillEntries = await readdir(skillsRoot, { withFileTypes: true });
  if (!skillEntries.some(entry => entry.name === 'imagen' && entry.isDirectory())) throw new Error('imagen Skill is missing.');
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) throw new Error(`Unexpected item in skills directory: ${entry.name}`);
    const skill = await readFile(await containedFile(pluginRoot, join(skillsRoot, entry.name, 'SKILL.md')), 'utf8');
    if (!/^---\r?\nname: [a-z0-9-]+\r?\ndescription: .+\r?\n---\r?\n/.test(skill)) throw new Error(`Invalid Skill frontmatter: ${entry.name}`);
  }
  await containedFile(pluginRoot, join(pluginRoot, 'LICENSE'));
  await containedFile(pluginRoot, join(pluginRoot, 'README.md'));
  await containedFile(pluginRoot, join(pluginRoot, 'THIRD_PARTY_NOTICES.md'));
  await containedFile(pluginRoot, join(pluginRoot, 'runtime', 'imagen.mjs'));
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Distribution must not contain symlinks: ${path}`);
      if (/^(\.env(?:\..+)?|credentials(?:\.json)?|config\.json|.*\.(?:pem|key))$/i.test(entry.name)) throw new Error(`Distribution contains a private configuration filename: ${path}`);
      if (entry.isDirectory()) await inspect(path);
    }
  }
  await inspect(pluginRoot);
  return { name: documents.plugin.name, version: documents.plugin.version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await validatePlugin(process.argv[2]);
  process.stdout.write(`Validated ${result.name}@${result.version}: schemas, components, and contained runtime paths.\n`);
}
