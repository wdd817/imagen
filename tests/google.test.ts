import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { googleAdapter, googleOptionsSchema } from '../src/adapters/google.js';
import { ImagenError } from '../src/core/errors.js';
import type { ImageRequest, Profile } from '../src/core/types.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const fakeKey = 'local-google-test-key';
type Captured = { path: string; method?: string; headers: IncomingHttpHeaders; body: any };

async function fakeGoogle(t: TestContext, handler?: (res: ServerResponse, request: Captured) => void) {
  const captured: Captured[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = { path: req.url ?? '', method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    captured.push(request);
    if (handler) handler(res, request);
    else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('x-request-id', 'local-request-123');
      res.end(JSON.stringify({
        responseId: 'google-response-123',
        candidates: [{ content: { parts: [{ text: 'Completed.' }, { inlineData: { data: PNG, mimeType: 'image/png' } }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 12, totalTokenCount: 22 },
      }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local HTTP address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, captured };
}

function profile(baseUrl: string, overrides: Partial<Profile> = {}): Profile {
  return {
    protocol: 'gemini', platform: 'developer', model: 'test-image-model', baseUrl, apiVersion: 'v1beta',
    auth: { kind: 'apiKey', credential: 'test' },
    capabilities: { generate: 'supported', edit: 'supported', references: 'supported', mask: 'unsupported' },
    evidence: 'local SDK fixture', maxCount: 1, maxInputImages: 10, ...overrides,
  };
}

function request(overrides: Partial<ImageRequest> = {}): ImageRequest {
  return {
    requestId: 'google-test-request', operation: 'generate', prompt: 'Create a red square.', profile: 'test',
    referenceImages: [], outputDir: tmpdir(), count: 1, timeoutMs: 2000, providerOptions: {}, ...overrides,
  };
}

const context = () => ({ auth: { kind: 'apiKey' as const, apiKey: fakeKey }, signal: new AbortController().signal });

test('Google capability schemas describe only the options available for that platform and operation', () => {
  const developer = z.toJSONSchema(googleOptionsSchema(profile('http://127.0.0.1'), 'generate'));
  assert.equal(developer.additionalProperties, false);
  assert.ok(developer.properties?.aspectRatio);
  assert.equal(developer.properties?.outputMimeType, undefined);
  assert.equal(developer.properties?.outputCompressionQuality, undefined);
  const vertex = z.toJSONSchema(googleOptionsSchema(profile('http://127.0.0.1', { platform: 'vertex' }), 'edit'));
  assert.ok(vertex.properties?.outputMimeType);
  const imagenGenerate = googleOptionsSchema(profile('http://127.0.0.1', { protocol: 'imagen', platform: 'vertex' }), 'generate');
  const imagenEdit = googleOptionsSchema(profile('http://127.0.0.1', { protocol: 'imagen', platform: 'vertex' }), 'edit');
  assert.ok(imagenGenerate.safeParse({ imageSize: '2K' }).success);
  assert.equal(imagenEdit.safeParse({ imageSize: '2K' }).success, false);
  assert.ok(imagenEdit.safeParse({ editMode: 'EDIT_MODE_INPAINT_INSERTION' }).success);
  assert.equal(googleOptionsSchema(profile('http://127.0.0.1', { protocol: 'imagen' }), 'generate').safeParse({}).success, false);
});

async function inputFiles(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'imagen-google-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, 'target.png');
  const reference = join(dir, 'reference.webp'); // MIME must come from content, not extension.
  const mask = join(dir, 'mask.png');
  await Promise.all([image, reference, mask].map((file) => writeFile(file, Buffer.from(PNG, 'base64'))));
  return { dir, image, reference, mask };
}

test('Gemini SDK sends the expected Developer API request and normalizes images, text and usage', async (t) => {
  const fake = await fakeGoogle(t);
  const result = await googleAdapter(request({ providerOptions: { aspectRatio: '16:9', imageSize: '2K' } }), profile(fake.baseUrl), context());
  assert.deepEqual(result.images, [{ base64: PNG, mimeType: 'image/png' }]);
  assert.equal(result.providerRequestId, 'google-response-123');
  assert.equal(result.text, 'Completed.');
  assert.deepEqual(result.usage, { promptTokenCount: 10, candidatesTokenCount: 12, totalTokenCount: 22 });
  assert.equal(fake.captured.length, 1);
  const sent = fake.captured[0]!;
  assert.equal(sent.path, '/v1beta/models/test-image-model:generateContent');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['x-goog-api-key'], fakeKey);
  assert.deepEqual(sent.body.generationConfig, { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } });
  assert.deepEqual(sent.body.contents, [{ role: 'user', parts: [{ text: 'Create a red square.' }] }]);
});

test('Gemini SDK includes edit target then reference images with their detected MIME types', async (t) => {
  const fake = await fakeGoogle(t);
  const files = await inputFiles(t);
  await googleAdapter(request({ operation: 'edit', targetImage: files.image, referenceImages: [files.reference] }), profile(fake.baseUrl), context());
  const parts = fake.captured[0]!.body.contents[0].parts;
  assert.deepEqual(parts, [
    { inlineData: { data: PNG, mimeType: 'image/png' } },
    { inlineData: { data: PNG, mimeType: 'image/png' } },
    { text: 'Create a red square.' },
  ]);
});

test('Vertex Gemini SDK uses explicit project/location and API version with Vertex image options', async (t) => {
  const fake = await fakeGoogle(t);
  await googleAdapter(request({ providerOptions: { outputMimeType: 'image/jpeg', outputCompressionQuality: 85 } }), profile(fake.baseUrl, {
    platform: 'vertex', project: 'fake-project', location: 'us-central1', apiVersion: 'v1',
  }), context());
  assert.equal(fake.captured[0]!.path, '/v1/projects/fake-project/locations/us-central1/publishers/google/models/test-image-model:generateContent');
  assert.deepEqual(fake.captured[0]!.body.generationConfig.imageConfig, { imageOutputOptions: { mimeType: 'image/jpeg', compressionQuality: 85 } });
});

test('Vertex API key without a project uses the express-mode path', async (t) => {
  const fake = await fakeGoogle(t);
  await googleAdapter(request(), profile(fake.baseUrl, { platform: 'vertex', apiVersion: 'v1' }), context());
  assert.equal(fake.captured[0]!.path, '/v1/publishers/google/models/test-image-model:generateContent');
});

test('unsupported options and operations fail before any paid submission', async (t) => {
  const fake = await fakeGoogle(t);
  const files = await inputFiles(t);
  const failures: [Partial<ImageRequest>, Partial<Profile>, string][] = [
    [{ count: 2 }, {}, 'UNSUPPORTED_COUNT'],
    [{ mask: files.mask }, {}, 'UNSUPPORTED_MASK'],
    [{ providerOptions: { outputMimeType: 'image/png' } }, {}, 'UNSUPPORTED_OPTIONS'],
    [{ providerOptions: { httpOptions: { retryOptions: { attempts: 5 } } } }, {}, 'UNSUPPORTED_OPTIONS'],
    [{ providerOptions: { outputCompressionQuality: 70 } }, { platform: 'vertex' }, 'UNSUPPORTED_OPTIONS'],
    [{ operation: 'edit' }, {}, 'INVALID_REQUEST'],
    [{ targetImage: files.image }, {}, 'INVALID_REQUEST'],
    [{}, { protocol: 'imagen' }, 'UNSUPPORTED_PROTOCOL'],
    [{ referenceImages: [files.reference] }, { protocol: 'imagen', platform: 'vertex' }, 'UNSUPPORTED_REFERENCES'],
    [{ providerOptions: { seed: 10 } }, { protocol: 'imagen', platform: 'vertex' }, 'UNSUPPORTED_OPTIONS'],
    [{ providerOptions: { imageSize: '4K' } }, { protocol: 'imagen', platform: 'vertex' }, 'UNSUPPORTED_OPTIONS'],
    [{ operation: 'edit', targetImage: files.image, providerOptions: { imageSize: '2K' } }, { protocol: 'imagen', platform: 'vertex' }, 'UNSUPPORTED_OPTIONS'],
  ];
  for (const [req, prof, code] of failures) {
    await assert.rejects(googleAdapter(request(req), profile(fake.baseUrl, prof), context()), (e: unknown) => e instanceof ImagenError && e.code === code && !e.outcomeUnknown);
  }
  assert.equal(fake.captured.length, 0);
});

test('Vertex Imagen generation uses the SDK predict body and preserves all returned images', async (t) => {
  const fake = await fakeGoogle(t, (res) => {
    res.setHeader('x-request-id', 'imagen-generation-123');
    res.end(JSON.stringify({ predictions: [1, 2].map(() => ({ bytesBase64Encoded: PNG, mimeType: 'image/png' })) }));
  });
  const result = await googleAdapter(request({ count: 2, providerOptions: { aspectRatio: '16:9', outputMimeType: 'image/png', imageSize: '2K' } }), profile(fake.baseUrl, {
    protocol: 'imagen', platform: 'vertex', project: 'fake-project', location: 'global', apiVersion: 'v1', maxCount: 4,
  }), context());
  assert.equal(fake.captured[0]!.path, '/v1/projects/fake-project/locations/global/publishers/google/models/test-image-model:predict');
  assert.deepEqual(fake.captured[0]!.body, {
    instances: [{ prompt: 'Create a red square.' }],
    parameters: { sampleCount: 2, aspectRatio: '16:9', sampleImageSize: '2K', outputOptions: { mimeType: 'image/png' } },
  });
  assert.equal(result.images.length, 2);
  assert.equal(result.providerRequestId, 'imagen-generation-123');
});

test('Vertex Imagen edit uses SDK raw and user-provided mask reference objects', async (t) => {
  const files = await inputFiles(t);
  const fake = await fakeGoogle(t, (res) => res.end(JSON.stringify({ predictions: [{ bytesBase64Encoded: PNG, mimeType: 'image/png' }] })));
  await googleAdapter(request({ operation: 'edit', targetImage: files.image, mask: files.mask, providerOptions: { editMode: 'EDIT_MODE_INPAINT_INSERTION' } }), profile(fake.baseUrl, {
    protocol: 'imagen', platform: 'vertex', apiVersion: 'v1',
  }), context());
  assert.equal(fake.captured[0]!.path, '/v1/publishers/google/models/test-image-model:predict');
  const sent = fake.captured[0]!.body;
  assert.equal(sent.parameters.editMode, 'EDIT_MODE_INPAINT_INSERTION');
  assert.equal(sent.parameters.sampleCount, 1);
  const refs = sent.instances[0].referenceImages;
  assert.deepEqual(refs.map((ref: any) => [ref.referenceId, ref.referenceType]), [[1, 'REFERENCE_TYPE_RAW'], [2, 'REFERENCE_TYPE_MASK']]);
  assert.equal(refs[0].referenceImage.bytesBase64Encoded, PNG);
  assert.equal(refs[1].maskImageConfig.maskMode, 'MASK_MODE_USER_PROVIDED');
});

test('Google SDK never retries rejected image generation and error bodies are sanitized', async (t) => {
  for (const status of [400, 401, 403, 408, 429, 500, 503]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const fake = await fakeGoogle(t, (res) => { res.statusCode = status; res.end(JSON.stringify({ error: { code: status, message: 'SENSITIVE-RESPONSE-BODY' } })); });
      await assert.rejects(googleAdapter(request(), profile(fake.baseUrl), context()), (error: unknown) => {
        assert.ok(error instanceof ImagenError);
        assert.ok(!error.message.includes('SENSITIVE'));
        assert.equal(error.outcomeUnknown, status === 408 || status >= 500);
        return true;
      });
      assert.equal(fake.captured.length, 1);
    });
  }
});

test('accepted request with a disconnected response is unknown and is never submitted again', async (t) => {
  const fake = await fakeGoogle(t, (res) => res.destroy());
  await assert.rejects(googleAdapter(request(), profile(fake.baseUrl), context()), (e: unknown) => e instanceof ImagenError && e.outcomeUnknown);
  assert.equal(fake.captured.length, 1);
});

test('Google request timeout is unknown and does not create a second generation', async (t) => {
  const fake = await fakeGoogle(t, () => {});
  await assert.rejects(googleAdapter(request({ timeoutMs: 50 }), profile(fake.baseUrl), context()), (e: unknown) => e instanceof ImagenError && e.outcomeUnknown);
  assert.equal(fake.captured.length, 1);
});

test('AbortSignal distinguishes cancellation before and after submission', async (t) => {
  const controller = new AbortController();
  const fake = await fakeGoogle(t, () => controller.abort());
  await assert.rejects(googleAdapter(request(), profile(fake.baseUrl), { ...context(), signal: controller.signal }), (e: unknown) => e instanceof ImagenError && e.code === 'PROVIDER_CANCELLED' && e.outcomeUnknown);
  assert.equal(fake.captured.length, 1);
  await assert.rejects(googleAdapter(request(), profile(fake.baseUrl), { ...context(), signal: controller.signal }), (e: unknown) => e instanceof ImagenError && e.code === 'CANCELLED' && !e.outcomeUnknown);
  assert.equal(fake.captured.length, 1);
});

test('known successful response without an image does not return thought images or claim success', async (t) => {
  const fake = await fakeGoogle(t, (res) => {
    res.setHeader('x-goog-request-id', 'filtered-123');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: PNG } }] } }] }));
  });
  await assert.rejects(googleAdapter(request(), profile(fake.baseUrl), context()), (e: unknown) => e instanceof ImagenError && e.code === 'NO_IMAGE_RETURNED' && !e.outcomeUnknown && e.providerRequestId === 'filtered-123');
  assert.equal(fake.captured.length, 1);
});

test('invalid local images and explicit unavailable credential files fail without network or ambient ADC fallback', async (t) => {
  const fake = await fakeGoogle(t);
  const files = await inputFiles(t);
  await writeFile(files.image, 'not a valid image');
  await assert.rejects(googleAdapter(request({ operation: 'edit', targetImage: files.image }), profile(fake.baseUrl), context()), (e: unknown) => e instanceof ImagenError && e.code === 'INVALID_IMAGE');
  await assert.rejects(googleAdapter(request(), profile(fake.baseUrl, { platform: 'vertex', project: 'fake-project', location: 'global' }), {
    auth: { kind: 'googleCredentials', file: join(files.dir, 'not-present.json') }, signal: new AbortController().signal,
  }), (e: unknown) => e instanceof ImagenError && e.code === 'AUTH_CONFIG_ERROR' && !e.outcomeUnknown);
  assert.equal(fake.captured.length, 0);
});
