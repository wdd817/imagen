import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openaiAdapter, openaiOptionsSchema } from '../src/adapters/openai.js';
import { ImagenError } from '../src/core/errors.js';
import type { ImageRequest, Profile } from '../src/core/types.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const AUTH = { kind: 'apiKey' as const, apiKey: 'test-explicit-key' };
const request: ImageRequest = {
  requestId: 'adapter-test-request', operation: 'generate', prompt: 'A blue square', profile: 'test',
  referenceImages: [], outputDir: tmpdir(), count: 1, timeoutMs: 3_000, providerOptions: {},
};
const profile: Profile = {
  protocol: 'images', model: 'test-image-model', auth: { kind: 'apiKey', credential: 'test' },
  capabilities: { generate: 'supported', edit: 'supported', references: 'supported', mask: 'supported' },
  evidence: 'Local fake server', maxCount: 10, maxInputImages: 16,
};
interface Received { request: IncomingMessage; bytes: Buffer; body: Record<string, unknown> | undefined }
async function serverFor(handler: (received: Received, response: ServerResponse) => void | Promise<void>) {
  const calls: Received[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const received = { request: req, bytes, body: req.headers['content-type']?.includes('application/json') ? JSON.parse(bytes.toString()) as Record<string, unknown> : undefined };
    calls.push(received);
    try { await handler(received, res); }
    catch { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Fake handler failed"}}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    calls,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
function reply(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_local' });
  response.end(JSON.stringify(body));
}
async function inputs() {
  const dir = await mkdtemp(join(tmpdir(), 'imagen openai 中文 '));
  const target = join(dir, 'target.png');
  const reference = join(dir, 'reference.png');
  const mask = join(dir, 'mask.png');
  await Promise.all([
    writeFile(target, Buffer.from(PNG, 'base64')),
    writeFile(reference, Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([0])])),
    writeFile(mask, Buffer.from(PNG, 'base64')),
  ]);
  return { target, reference, mask, close: () => rm(dir, { recursive: true, force: true }) };
}
function context(signal = new AbortController().signal) { return { auth: AUTH, signal }; }

function pngWithTextChunk(byteCount: number): Buffer {
  const png = Buffer.from(PNG, 'base64');
  const data = Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(byteCount, 120)]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('tEXt', 4, 'ascii');
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

test('Images generation uses the real SDK, explicit auth/baseURL, and preserves multiple output forms', async () => {
  const server = await serverFor((_, response) => reply(response, { data: [{ b64_json: PNG }, { url: 'https://images.example/result.webp' }], output_format: 'png', usage: { total_tokens: 7 } }));
  try {
    const result = await openaiAdapter({ ...request, count: 2, providerOptions: { size: '1024x1024', quality: 'high' } }, { ...profile, baseUrl: server.baseUrl }, context());
    assert.equal(server.calls.length, 1);
    const sent = server.calls[0]!;
    assert.equal(sent.request.url, '/api/v1/images/generations');
    assert.equal(sent.request.headers.authorization, 'Bearer test-explicit-key');
    assert.equal(sent.request.headers['openai-organization'], undefined);
    assert.equal(sent.request.headers['openai-project'], undefined);
    assert.deepEqual(sent.body, { model: profile.model, prompt: request.prompt, n: 2, stream: false, size: '1024x1024', quality: 'high' });
    assert.deepEqual(result.images, [{ base64: PNG, mimeType: 'image/png' }, { url: 'https://images.example/result.webp' }]);
    assert.equal(result.providerRequestId, 'req_local');
    assert.deepEqual(result.usage, { total_tokens: 7 });
  } finally { await server.close(); }
});

test('Images edits send multipart target first, references next, and a separate mask', async () => {
  const files = await inputs();
  const server = await serverFor((_, response) => reply(response, { data: [{ b64_json: PNG }] }));
  try {
    await openaiAdapter({ ...request, operation: 'edit', targetImage: files.target, referenceImages: [files.reference], mask: files.mask, providerOptions: { input_fidelity: 'high' } }, { ...profile, baseUrl: server.baseUrl }, context());
    const sent = server.calls[0]!;
    assert.equal(sent.request.url, '/api/v1/images/edits');
    assert.match(sent.request.headers['content-type']!, /^multipart\/form-data; boundary=/);
    const form = await new Request('http://test.invalid', { method: 'POST', headers: { 'content-type': sent.request.headers['content-type']! }, body: new Uint8Array(sent.bytes) }).formData();
    const images = form.getAll('image[]') as File[];
    assert.equal(images.length, 2);
    assert.deepEqual(Buffer.from(await images[0]!.arrayBuffer()), Buffer.from(PNG, 'base64'));
    assert.deepEqual(Buffer.from(await images[1]!.arrayBuffer()), Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([0])]));
    assert.equal((form.get('mask') as File).type, 'image/png');
    assert.equal(form.get('input_fidelity'), 'high');
  } finally { await server.close(); await files.close(); }
});

test('Guided Images generation uses the image editing transport without discarding references', async () => {
  const files = await inputs();
  const server = await serverFor((_, response) => reply(response, { data: [{ b64_json: PNG }] }));
  try {
    await openaiAdapter({ ...request, referenceImages: [files.reference] }, { ...profile, baseUrl: server.baseUrl }, context());
    assert.equal(server.calls[0]!.request.url, '/api/v1/images/edits');
    assert.match(server.calls[0]!.bytes.toString(), /name="image"; filename="reference.png"/);
  } finally { await server.close(); await files.close(); }
});

test('Responses tool mode maps model, target, references and mask, and reads every completed image tool result', async () => {
  const files = await inputs();
  const server = await serverFor((_, response) => reply(response, {
    id: 'resp_local', object: 'response', status: 'completed', usage: { output_tokens: 22 },
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Edited.' }] },
      { type: 'image_generation_call', id: 'image_1', status: 'completed', result: PNG },
      { type: 'image_generation_call', id: 'image_2', status: 'completed', result: PNG },
    ],
  }));
  try {
    const result = await openaiAdapter({ ...request, operation: 'edit', targetImage: files.target, referenceImages: [files.reference], mask: files.mask, providerOptions: { size: '1024x1024' } }, { ...profile, protocol: 'responses', model: 'reasoning-model', imageModel: 'image-model', baseUrl: server.baseUrl }, context());
    const sent = server.calls[0]!;
    assert.equal(sent.request.url, '/api/v1/responses');
    assert.equal(sent.body!.model, 'reasoning-model');
    assert.deepEqual(sent.body!.tools, [{ type: 'image_generation', model: 'image-model', action: 'edit', size: '1024x1024', input_image_mask: { image_url: `data:image/png;base64,${PNG}` } }]);
    assert.deepEqual(sent.body!.tool_choice, { type: 'image_generation' });
    const content = (sent.body!.input as { content: { type: string; image_url?: string }[] }[])[0]!.content;
    assert.equal(content[1]!.image_url, `data:image/png;base64,${PNG}`);
    assert.notEqual(content[1]!.image_url, content[2]!.image_url);
    assert.equal(result.images.length, 2);
    assert.equal(result.text, 'Edited.');
    assert.equal(result.providerRequestId, 'req_local');
  } finally { await server.close(); await files.close(); }
});

test('Responses direct mode is explicit, has no image tool and accepts structured image output', async () => {
  const server = await serverFor((_, response) => reply(response, {
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_image', image_url: `data:image/png;base64,${PNG}` }] }],
  }));
  try {
    const result = await openaiAdapter(request, { ...profile, protocol: 'responses', responsesMode: 'direct', baseUrl: server.baseUrl }, context());
    assert.equal(server.calls[0]!.body!.tools, undefined);
    assert.equal(server.calls[0]!.body!.n, 1);
    assert.deepEqual(result.images, [{ base64: PNG, mimeType: 'image/png' }]);
  } finally { await server.close(); }
});

test('Text-only Responses output and empty Images data are failures; no paid fallback is attempted', async () => {
  for (const protocol of ['responses', 'images'] as const) {
    const server = await serverFor((_, response) => reply(response, { status: 'completed', data: [], output: [{ type: 'message', content: [{ type: 'output_text', text: 'https://example.com/image.png' }] }] }));
    try {
      await assert.rejects(openaiAdapter(request, { ...profile, protocol, baseUrl: server.baseUrl }, context()), (error: unknown) => error instanceof ImagenError && error.code === 'NO_IMAGE');
      assert.equal(server.calls.length, 1);
    } finally { await server.close(); }
  }
});

test('Incomplete Responses are not marked successful and unfinished image blocks are not returned', async () => {
  const pending = await serverFor((_, response) => reply(response, { status: 'in_progress', output: [{ type: 'image_generation_call', status: 'generating', result: PNG }] }));
  try {
    await assert.rejects(openaiAdapter(request, { ...profile, protocol: 'responses', baseUrl: pending.baseUrl }, context()), (error: unknown) => error instanceof ImagenError && error.code === 'PROVIDER_INCOMPLETE' && error.outcomeUnknown && error.providerRequestId === 'req_local');
  } finally { await pending.close(); }
  const partial = await serverFor((_, response) => reply(response, { status: 'completed', output: [
    { type: 'image_generation_call', status: 'completed', result: PNG },
    { type: 'image_generation_call', status: 'failed', result: PNG },
  ] }));
  try {
    const result = await openaiAdapter(request, { ...profile, protocol: 'responses', baseUrl: partial.baseUrl }, context());
    assert.equal(result.images.length, 1);
    assert.equal(result.warnings?.length, 1);
  } finally { await partial.close(); }
});

test('Unknown options, request overrides, incompatible options and unsupported counts fail before submission', async () => {
  const server = await serverFor((_, response) => reply(response, { data: [{ b64_json: PNG }] }));
  try {
    for (const providerOptions of [{ model: 'override' }, { n: 2 }, { stream: true }, { unknown: 1 }, { background: 'transparent', output_format: 'jpeg' }, { output_compression: 50 }, { input_fidelity: 'high' }]) {
      await assert.rejects(openaiAdapter({ ...request, providerOptions }, { ...profile, baseUrl: server.baseUrl }, context()), (error: unknown) => error instanceof ImagenError && error.code === 'INVALID_OPTIONS');
    }
    await assert.rejects(openaiAdapter({ ...request, count: 2 }, { ...profile, protocol: 'responses', baseUrl: server.baseUrl }, context()), (error: unknown) => error instanceof ImagenError && error.code === 'INVALID_OPTIONS');
    assert.equal(server.calls.length, 0);
  } finally { await server.close(); }
});

test('SDK errors are sanitized, carry request IDs and do not retry 401, 429 or 5xx', async () => {
  for (const protocol of ['images', 'responses'] as const) {
    for (const status of [401, 429, 500, 503]) {
      const server = await serverFor((_, response) => reply(response, { error: { message: 'secret-test-api-key and private prompt', type: 'provider_error' } }, status));
      try {
        await assert.rejects(openaiAdapter(request, { ...profile, protocol, baseUrl: server.baseUrl }, context()), (error: unknown) => {
          assert.ok(error instanceof ImagenError);
          assert.equal(error.providerRequestId, 'req_local');
          assert.equal(error.outcomeUnknown, status !== 401);
          assert.doesNotMatch(error.message, /secret-test-api-key|private prompt/);
          return true;
        });
        assert.equal(server.calls.length, 1, `${protocol} ${status} must not retry`);
      } finally { await server.close(); }
    }
  }
});

test('Timeout and AbortSignal cancel local waiting without declaring the remote outcome known', async () => {
  const server = await serverFor(() => { /* Intentionally withhold the response. */ });
  try {
    await assert.rejects(openaiAdapter({ ...request, timeoutMs: 250 }, { ...profile, baseUrl: server.baseUrl }, context()), (error: unknown) => error instanceof ImagenError && error.code === 'PROVIDER_TIMEOUT' && error.outcomeUnknown);
    assert.equal(server.calls.length, 1);
  } finally { await server.close(); }

  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const cancelling = await serverFor(() => { started(); });
  try {
    const controller = new AbortController();
    const pending = openaiAdapter(request, { ...profile, baseUrl: cancelling.baseUrl }, context(controller.signal));
    await received;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof ImagenError && error.code === 'CANCELLED' && error.outcomeUnknown);
    assert.equal(cancelling.calls.length, 1);
  } finally { await cancelling.close(); }
});

test('Already-aborted signals and missing input files never submit a generation', async () => {
  const server = await serverFor((_, response) => reply(response, { data: [{ b64_json: PNG }] }));
  try {
    await assert.rejects(openaiAdapter(request, { ...profile, baseUrl: server.baseUrl }, context(AbortSignal.abort())), (error: unknown) => error instanceof ImagenError && error.code === 'CANCELLED' && !error.outcomeUnknown);
    await assert.rejects(openaiAdapter({ ...request, operation: 'edit', targetImage: join(tmpdir(), 'imagen-file-does-not-exist.png') }, { ...profile, baseUrl: server.baseUrl }, context()), ImagenError);
    assert.equal(server.calls.length, 0);
  } finally { await server.close(); }
});

test('GPT Image masks above the legacy 4 MiB limit are accepted; DALL-E 2 retains its smaller limit', async () => {
  const files = await inputs();
  const server = await serverFor((_, response) => reply(response, { data: [{ b64_json: PNG }] }));
  try {
    await writeFile(files.mask, pngWithTextChunk(4 * 1024 * 1024));
    const edit = { ...request, operation: 'edit' as const, targetImage: files.target, mask: files.mask };
    const result = await openaiAdapter(edit, { ...profile, model: 'gpt-image-2', baseUrl: server.baseUrl }, context());
    assert.equal(result.images.length, 1);
    assert.equal(server.calls.length, 1);
    await assert.rejects(openaiAdapter(edit, { ...profile, model: 'dall-e-2', baseUrl: server.baseUrl }, context()), (error: unknown) => error instanceof ImagenError && error.code === 'INVALID_IMAGE');
    assert.equal(server.calls.length, 1);
  } finally { await server.close(); await files.close(); }
});

test('Option discovery excludes unsupported protocol fields and GPT Image 2 rejects configurable input fidelity', async () => {
  const toolSchema = openaiOptionsSchema({ ...profile, protocol: 'responses' }, 'generate');
  assert.equal(toolSchema.safeParse({ size: '1024x1024', quality: 'high' }).success, true);
  assert.equal(toolSchema.safeParse({ style: 'vivid' }).success, false);
  assert.equal(toolSchema.safeParse({ response_format: 'b64_json' }).success, false);
  assert.equal(openaiOptionsSchema(profile, 'edit').safeParse({ moderation: 'low' }).success, false);
  assert.equal(openaiOptionsSchema({ ...profile, model: 'gpt-image-2' }, 'edit').safeParse({ input_fidelity: 'high' }).success, false);
  const files = await inputs();
  try {
    await assert.rejects(openaiAdapter({ ...request, operation: 'edit', targetImage: files.target, providerOptions: { input_fidelity: 'high' } }, { ...profile, model: 'gpt-image-2' }, context()), (error: unknown) => error instanceof ImagenError && error.code === 'INVALID_OPTIONS');
  } finally { await files.close(); }
});
