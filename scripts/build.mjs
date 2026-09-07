import { build } from 'esbuild';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from './validate-plugin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const destination = join(dist, 'imagen');
const stage = join(dist, `.imagen-build-${process.pid}`);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

function assertBuildDirectory(path) {
  const suffix = relative(dist, resolve(path));
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) throw new Error('Build cleanup must remain inside dist.');
}

async function collectNotices(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = resolve(root, input);
    if (!absolute.includes(`${sep}node_modules${sep}`)) continue;
    let directory = dirname(absolute);
    while (directory !== root && dirname(directory) !== directory) {
      try {
        const data = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (data.name && data.version) {
          packages.set(`${data.name}@${data.version}`, { directory, data });
          break;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      directory = dirname(directory);
    }
  }
  const notices = ['# Third-party notices', '', 'These dependencies are included in runtime/imagen.mjs. Their original license and notice texts follow.', ''];
  for (const [name, { directory, data }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const licenseFiles = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(licen[sc]e|notice|copying)([.-]|$)/i.test(entry.name))
      .map(entry => entry.name).sort();
    notices.push(`## ${name}`, '', `License: ${typeof data.license === 'string' ? data.license : JSON.stringify(data.license)}`, '');
    if (!licenseFiles.length) {
      // Some npm packages include the complete license only in their README.
      const readme = await readFile(join(directory, 'README.md'), 'utf8').catch(() => '');
      const license = readme.match(/(?:^|\n)(?:#{1,3}\s+Licen[sc]e[^\n]*\n|Licen[sc]e\s*\n[-=]+\s*\n)([\s\S]+)/i)?.[1];
      if (!license || !/copyright/i.test(license)) throw new Error(`No distributable license text found for ${name}.`);
      notices.push('### License from README.md', '', license.trim(), '');
    }
    for (const file of licenseFiles) notices.push(`### ${file}`, '', await readFile(join(directory, file), 'utf8'), '');
  }
  return notices.join('\n');
}

await mkdir(dist, { recursive: true });
assertBuildDirectory(stage);
await rm(stage, { recursive: true, force: true });
try {
  await cp(join(root, 'plugin'), stage, { recursive: true, dereference: false });
  await mkdir(join(stage, 'runtime'), { recursive: true });
  const bundled = await build({
    absWorkingDir: root,
    entryPoints: ['src/cli/main.ts'],
    outfile: join(stage, 'runtime', 'imagen.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    metafile: true,
    sourcemap: false,
    legalComments: 'inline',
    plugins: [{
      name: 'portable-optional-dependencies',
      setup(builder) {
        // ws and debug have optional native/color helpers. Keep their documented
        // JavaScript/no-color fallbacks, independent of packages on the host.
        builder.onResolve({ filter: /^(bufferutil|utf-8-validate|supports-color)$/ }, args => ({ path: args.path, namespace: 'imagen-optional' }));
        builder.onLoad({ filter: /.*/, namespace: 'imagen-optional' }, () => ({ contents: 'throw new Error("Optional helper is omitted from the portable runtime.");', loader: 'js' }));
      },
    }],
    banner: { js: '#!/usr/bin/env node\nimport { createRequire as __imagenCreateRequire } from "node:module";\nconst require = __imagenCreateRequire(import.meta.url);' },
    logLevel: 'warning',
  });
  const output = Object.values(bundled.metafile.outputs);
  const external = output.flatMap(item => item.imports).filter(item => item.external && !item.path.startsWith('node:'));
  // Node builtins without the node: prefix are also valid. Reject unresolved npm runtime imports.
  const { builtinModules } = await import('node:module');
  const unresolved = external.filter(item => !builtinModules.includes(item.path));
  if (unresolved.length) throw new Error(`Bundle has unresolved runtime imports: ${unresolved.map(item => item.path).join(', ')}`);
  await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  await cp(join(root, 'docs'), join(stage, 'docs'), { recursive: true });
  await cp(join(root, 'README.md'), join(stage, 'README.md'));
  await writeFile(join(stage, 'THIRD_PARTY_NOTICES.md'), await collectNotices(bundled.metafile));
  const manifest = JSON.parse(await readFile(join(stage, 'plugin.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(join(stage, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await chmod(join(stage, 'runtime', 'imagen.mjs'), 0o755);
  await validatePlugin(stage);
  assertBuildDirectory(destination);
  await rm(destination, { recursive: true, force: true });
  await rename(stage, destination);
  process.stdout.write(`Built Agent Plugins 1.0 package: ${relative(root, destination)}\n`);
} catch (error) {
  assertBuildDirectory(stage);
  await rm(stage, { recursive: true, force: true });
  throw error;
}
