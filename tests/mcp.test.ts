import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createImagenMcpServer } from '../src/mcp/server.js';
import type { ImagenEngine } from '../src/core/engine.js';
import type { JobRecord } from '../src/core/types.js';

const toolNames = ['imagen_cancel', 'imagen_capabilities', 'imagen_edit', 'imagen_generate', 'imagen_job', 'imagen_recover'];
const source = new URL('../src/mcp/server.ts', import.meta.url).href;

for (const protocol of ['legacy', '2026-07-28'] as const) {
test(`stdio ${protocol} initializes without configuration and tool errors do not disclose private config content`, { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'imagen-mcp-'));
  const paths = { dataDir: directory, configPath: join(directory, 'config.json'), credentialsPath: join(directory, 'credentials.json') };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', '--input-type=module', '--eval', `import { runMcp } from ${JSON.stringify(source)}; await runMcp(${JSON.stringify(paths)});`],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'imagen-test', version: '1.0.0' }, {
    versionNegotiation: { mode: protocol === 'legacy' ? 'legacy' : { pin: protocol } },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), toolNames);
    const generate = listed.tools.find(tool => tool.name === 'imagen_generate')!;
    const edit = listed.tools.find(tool => tool.name === 'imagen_edit')!;
    assert.ok(generate.inputSchema.properties);
    assert.equal('operation' in generate.inputSchema.properties, false);
    assert.equal('targetImage' in generate.inputSchema.properties, false);
    assert.ok(edit.inputSchema.required?.includes('targetImage'));
    const missing = await client.callTool({ name: 'imagen_generate', arguments: { requestId: randomUUID(), prompt: 'A small blue circle', profile: 'missing', outputDir: directory } });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing), /CONFIG_MISSING/);
    const sentinel = `private-test-key-${randomUUID()}`;
    await writeFile(paths.configPath, JSON.stringify({ schemaVersion: 1, profiles: {}, apiKey: sentinel }));
    const invalid = await client.callTool({ name: 'imagen_capabilities', arguments: {} });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid), /CONFIG_INVALID/);
    assert.equal(JSON.stringify(invalid).includes(sentinel), false);
    assert.equal(stderr.includes(sentinel), false);
    // A failed tool request must not take down the connection.
    assert.equal((await client.listTools()).tools.length, 6);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});
}

test('stdio loads a self-contained build from outside the repository', { timeout: 30000 }, async t => {
  // The release suite runs build before this test. Source-only development may omit it.
  const bundle = new URL('../dist/imagen/runtime/imagen.mjs', import.meta.url);
  const { access } = await import('node:fs/promises');
  try { await access(bundle); } catch { t.skip('Run npm run build to include the isolated bundle check.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'imagen-bundle-'));
  const { cp, mkdir } = await import('node:fs/promises');
  const runtimeDirectory = join(directory, 'runtime');
  await mkdir(runtimeDirectory);
  const entry = join(runtimeDirectory, 'imagen.mjs');
  await cp(bundle, entry);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp', '--data-dir', join(directory, 'state')], cwd: directory, stderr: 'pipe' });
  const client = new Client({ name: 'imagen-bundle-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 6);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP returns structured jobs and only inlines a verified bounded artifact on request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'imagen-preview-'));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZ8AAAAASUVORK5CYII=', 'base64');
  const path = join(directory, 'image.png');
  await writeFile(path, image);
  const job: JobRecord = {
    schemaVersion: 1, jobId: randomUUID(), requestId: randomUUID(), requestHash: 'hash', profile: 'mock', model: 'mock', status: 'succeeded',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputDir: directory, warnings: [],
    images: [{ path, mimeType: 'image/png', width: 1, height: 1, bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') }],
  };
  const engine = { get: async () => job } as unknown as ImagenEngine;
  const server = createImagenMcpServer(engine);
  const client = new Client({ name: 'imagen-preview-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const plain = await client.callTool({ name: 'imagen_job', arguments: { jobId: job.jobId } });
    assert.equal((plain.structuredContent as Record<string, unknown>)?.jobId, job.jobId);
    assert.equal(plain.content?.some(item => item.type === 'image'), false);
    const preview = await client.callTool({ name: 'imagen_job', arguments: { jobId: job.jobId, preview: true } });
    assert.equal(preview.content?.filter(item => item.type === 'image').length, 1);
    const changed = Buffer.alloc(image.length, 0x41);
    await writeFile(path, changed);
    const invalid = await client.callTool({ name: 'imagen_job', arguments: { jobId: job.jobId, preview: true } });
    assert.equal(invalid.content?.some(item => item.type === 'image'), false);
    assert.equal((invalid.structuredContent as Record<string, unknown>)?.jobId, job.jobId);
    job.images[0]!.bytes = 1024 * 1024 + 1;
    const oversized = await client.callTool({ name: 'imagen_job', arguments: { jobId: job.jobId, preview: true } });
    assert.equal(oversized.content?.some(item => item.type === 'image'), false);
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
