import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ImagenEngine } from '../src/core/engine.js';
import { ImagenError } from '../src/core/errors.js';
import { materializeImage } from '../src/artifacts/store.js';
import { writeJson } from '../src/config/store.js';
import type { AdapterResult, ImageAdapter, ImageRequest, ImagenConfig, Profile, RuntimePaths } from '../src/core/types.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const imageResult = (): AdapterResult => ({ images: [{ base64: PNG, mimeType: 'image/png' }], providerRequestId: 'provider-fixture-request' });
const verifiedProfile: Profile = {
  protocol: 'images', model: 'test-image-model', auth: { kind: 'apiKey', credential: 'test' },
  capabilities: { generate: 'supported', edit: 'supported', references: 'supported', mask: 'supported' },
  evidence: 'Offline injected adapter', maxCount: 4, maxInputImages: 4,
};
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) { reject(new Error('Local request interrupted')); return; }
    signal.addEventListener('abort', () => reject(new Error('Local request interrupted')), { once: true });
  });
}
async function fixture(t: TestContext, profiles: Record<string, Profile> = { test: verifiedProfile }) {
  const dir = await mkdtemp(join(tmpdir(), 'imagen engine 中文 '));
  const dataDir = join(dir, 'state');
  const paths: RuntimePaths = { dataDir, configPath: join(dataDir, 'config.json'), credentialsPath: join(dataDir, 'credentials.json') };
  const config: ImagenConfig = { schemaVersion: 1, defaultProfile: 'test', profiles };
  await writeJson(paths.configPath, config);
  await writeJson(paths.credentialsPath, { test: 'offline-fixture-key' });
  const input = join(dir, 'input.png');
  await writeFile(input, Buffer.from(PNG, 'base64'));
  const engines: ImagenEngine[] = [];
  t.after(async () => {
    for (const engine of engines) await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir, paths, input,
    request: (overrides: Partial<ImageRequest> = {}): ImageRequest => ({
      requestId: 'test-request', operation: 'generate', prompt: 'Draw a red square', profile: 'test',
      referenceImages: [], outputDir: join(dir, 'output'), count: 1, timeoutMs: 2_000, providerOptions: {}, ...overrides,
    }),
    engine: async (adapter: ImageAdapter, concurrency = 1) => {
      const engine = await new ImagenEngine(paths, { adapters: { images: adapter }, concurrency, allowLocalUrls: true }).initialize();
      engines.push(engine);
      return engine;
    },
  };
}

test('Concurrent submissions with one requestId share one job and make only one provider call', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let calls = 0;
  const engine = await f.engine(async (_, __, context) => {
    calls++;
    assert.deepEqual(context.auth, { kind: 'apiKey', apiKey: 'offline-fixture-key' });
    return imageResult();
  });
  const jobs = await Promise.all(Array.from({ length: 16 }, () => engine.submit(f.request())));
  assert.equal(new Set(jobs.map(job => job.jobId)).size, 1);
  const completed = await engine.wait(jobs[0]!.jobId);
  assert.equal(completed.status, 'succeeded');
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(completed.images[0]!.path), Buffer.from(PNG, 'base64'));
  const repeated = await engine.submit(f.request());
  assert.equal(repeated.jobId, completed.jobId);
  assert.equal(repeated.status, 'succeeded');
  assert.equal(calls, 1);
});

test('Reusing a requestId with a different prompt or changed image contents is rejected without another call', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let calls = 0;
  const engine = await f.engine(async () => { calls++; return imageResult(); });
  const original = f.request({ operation: 'edit', targetImage: f.input });
  const first = await engine.submit(original);
  assert.equal((await engine.wait(first.jobId)).status, 'succeeded');
  await assert.rejects(engine.submit({ ...original, prompt: 'A different picture' }), (error: unknown) => error instanceof ImagenError && error.code === 'REQUEST_CONFLICT');
  await writeFile(f.input, Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from([0]) ]));
  await assert.rejects(engine.submit(original), (error: unknown) => error instanceof ImagenError && error.code === 'REQUEST_CONFLICT');
  assert.equal(calls, 1);
});

test('Unknown or unsupported input capabilities and excessive input counts stop before provider submission', { timeout: 10_000 }, async t => {
  const f = await fixture(t, {
    test: verifiedProfile,
    noGenerate: { ...verifiedProfile, capabilities: { ...verifiedProfile.capabilities, generate: 'unknown' } },
    noEdit: { ...verifiedProfile, capabilities: { ...verifiedProfile.capabilities, edit: 'unsupported' } },
    noReferences: { ...verifiedProfile, capabilities: { ...verifiedProfile.capabilities, references: 'unsupported' } },
    noMask: { ...verifiedProfile, capabilities: { ...verifiedProfile.capabilities, mask: 'unknown' } },
    limited: { ...verifiedProfile, maxInputImages: 1 },
  });
  let calls = 0;
  const engine = await f.engine(async () => { calls++; return imageResult(); });
  for (const overrides of [
    { profile: 'noGenerate' },
    { profile: 'noEdit', operation: 'edit' as const, targetImage: f.input },
    { profile: 'noReferences', referenceImages: [f.input] },
    { profile: 'noMask', operation: 'edit' as const, targetImage: f.input, mask: f.input },
  ]) await assert.rejects(engine.submit(f.request(overrides)), (error: unknown) => error instanceof ImagenError && error.code === 'UNSUPPORTED_CAPABILITY');
  await assert.rejects(engine.submit(f.request({ profile: 'limited', operation: 'edit', targetImage: f.input, referenceImages: [f.input] })), (error: unknown) => error instanceof ImagenError && error.code === 'UNSUPPORTED_INPUT_COUNT');
  assert.equal(calls, 0);
});

test('Cancelling a queued job prevents its provider call while the running job can finish', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const started = deferred<void>();
  const finish = deferred<AdapterResult>();
  let calls = 0;
  const engine = await f.engine(async (_, __, context) => {
    calls++; started.resolve();
    return Promise.race([finish.promise, untilAborted(context.signal)]);
  }, 1);
  const first = await engine.submit(f.request({ requestId: 'running' }));
  await started.promise;
  const second = await engine.submit(f.request({ requestId: 'queued' }));
  assert.equal(second.status, 'queued');
  const cancelled = await engine.cancel(second.jobId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.images.length, 0);
  finish.resolve(imageResult());
  assert.equal((await engine.wait(first.jobId)).status, 'succeeded');
  assert.equal((await engine.get(second.jobId)).status, 'cancelled');
  assert.equal(calls, 1);
});

test('Cancelling a running request aborts local waiting and reports an unknown remote outcome', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const started = deferred<void>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const engine = await f.engine(async (_, __, context) => {
    calls++; signal = context.signal; started.resolve();
    return untilAborted(context.signal);
  });
  const job = await engine.submit(f.request());
  await started.promise;
  const cancelled = await engine.cancel(job.jobId);
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled.status, 'unknown');
  assert.equal(cancelled.error?.outcomeUnknown, true);
  assert.equal(cancelled.images.length, 0);
  assert.equal(calls, 1);
  const duplicate = await engine.submit(f.request());
  assert.equal(duplicate.jobId, job.jobId);
  assert.equal(calls, 1);
});

test('A request deadline produces unknown without automatically retrying generation', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let calls = 0;
  const engine = await f.engine(async (_, __, context) => { calls++; return untilAborted(context.signal); });
  const job = await engine.submit(f.request({ timeoutMs: 1_000 }));
  const timedOut = await engine.wait(job.jobId);
  assert.equal(timedOut.status, 'unknown');
  assert.equal(timedOut.error?.outcomeUnknown, true);
  assert.equal(calls, 1);
  const existing = await engine.submit(f.request({ timeoutMs: 1_000 }));
  assert.equal(existing.jobId, job.jobId);
  assert.equal(existing.status, 'unknown');
  assert.equal(calls, 1);
});

test('Provider failures are sanitized and neither known failures nor uncertain failures are retried', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let calls = 0;
  const engine = await f.engine(async submitted => {
    calls++;
    if (submitted.requestId === 'uncertain') throw new ImagenError('PROVIDER_ERROR', 'The outcome is not known.', true, 'provider-error-id');
    if (submitted.requestId === 'known-failure') throw new ImagenError('PROVIDER_REJECTED', 'The request was rejected before generation.');
    throw new Error('A raw provider error containing a private test credential');
  });
  const failed = await engine.submit(f.request({ requestId: 'known-failure' }));
  const unknown = await engine.submit(f.request({ requestId: 'uncertain' }));
  const unclassified = await engine.submit(f.request({ requestId: 'unclassified-failure' }));
  const [first, second, third] = await Promise.all([engine.wait(failed.jobId), engine.wait(unknown.jobId), engine.wait(unclassified.jobId)]);
  assert.equal(first.status, 'failed');
  assert.doesNotMatch(JSON.stringify(first), /private test credential/);
  assert.equal(second.status, 'unknown');
  assert.equal(second.error?.providerRequestId, 'provider-error-id');
  assert.equal(third.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(third), /private test credential/);
  assert.equal(calls, 3);
});

test('Saving can be recovered after fixing the output directory without another provider call', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const blockedOutput = join(f.dir, 'blocked-output');
  await writeFile(blockedOutput, 'existing user file');
  let calls = 0;
  const engine = await f.engine(async () => { calls++; return { ...imageResult(), images: [imageResult().images[0]!, imageResult().images[0]!] }; });
  const job = await engine.submit(f.request({ outputDir: blockedOutput, count: 2 }));
  const failed = await engine.wait(job.jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'SAVE_FAILED');
  assert.equal(await readFile(blockedOutput, 'utf8'), 'existing user file');
  await rm(blockedOutput);
  await mkdir(blockedOutput);
  const recovered = await engine.recover(job.jobId);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.images.length, 2);
  assert.equal(recovered.providerRequestId, 'provider-fixture-request');
  for (const image of recovered.images) assert.deepEqual(await readFile(image.path), Buffer.from(PNG, 'base64'));
  assert.equal(calls, 1);
  assert.equal((await engine.recover(job.jobId)).status, 'succeeded');
  assert.equal((await readdir(blockedOutput)).length, 2);
  assert.equal(calls, 1);
});

test('Restart marks interrupted running and queued jobs without re-submitting them', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let calls = 0;
  const started = deferred<void>();
  const adapter: ImageAdapter = async (_, __, context) => { calls++; started.resolve(); return untilAborted(context.signal); };
  const previous = await f.engine(adapter, 1);
  const running = await previous.submit(f.request({ requestId: 'interrupted-running' }));
  await started.promise;
  const queued = await previous.submit(f.request({ requestId: 'interrupted-queued' }));
  await previous.close();
  // Simulate the two durable states that an abruptly terminated process can leave.
  for (const [job, status] of [[running, 'running'], [queued, 'queued']] as const) {
    const file = join(f.paths.dataDir, 'jobs', `${job.jobId}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeJson(file, { ...stored, status, ownerPid: 2_147_483_647 });
  }
  const restarted = await f.engine(adapter, 1);
  const interrupted = await restarted.get(running.jobId);
  assert.equal(interrupted.status, 'unknown');
  assert.equal(interrupted.error?.code, 'PROCESS_INTERRUPTED');
  assert.equal(interrupted.error?.outcomeUnknown, true);
  assert.equal((await restarted.get(queued.jobId)).status, 'cancelled');
  const same = await restarted.submit(f.request({ requestId: 'interrupted-running' }));
  assert.equal(same.jobId, running.jobId);
  assert.equal(same.status, 'unknown');
  await assert.rejects(restarted.recover(running.jobId), (error: unknown) => error instanceof ImagenError && error.code === 'RECOVERY_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('Materializing images never overwrites different existing content and does not leave temporary files', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const output = join(f.dir, 'artifact-output');
  await mkdir(output);
  const originalPath = join(output, 'existing.png');
  const original = Buffer.from('This is an existing user file that must remain unchanged.');
  await writeFile(originalPath, original);
  await assert.rejects(materializeImage({ base64: PNG }, 'existing', output, new AbortController().signal), (error: unknown) => error instanceof ImagenError && error.code === 'OUTPUT_EXISTS');
  assert.deepEqual(await readFile(originalPath), original);
  assert.deepEqual(await readdir(output), ['existing.png']);
  const saved = await materializeImage({ base64: PNG }, 'new-image', output, new AbortController().signal);
  const reused = await materializeImage({ base64: PNG }, 'new-image', output, new AbortController().signal);
  assert.equal(reused.path, saved.path);
  assert.equal(reused.sha256, saved.sha256);
  assert.equal((await readdir(output)).length, 2);
});

test('Initialization needs no credentials, but submitting without the selected credential makes no API call', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await rm(f.paths.credentialsPath);
  let calls = 0;
  const engine = await f.engine(async () => { calls++; return imageResult(); });
  assert.ok(await engine.capabilities());
  await assert.rejects(engine.submit(f.request()), (error: unknown) => error instanceof ImagenError && error.code === 'CREDENTIAL_MISSING');
  assert.equal(calls, 0);
});

test('A live engine reports terminal storage errors instead of leaving a job polling forever', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let calls = 0;
  let failedOnce = false;
  const engine = await new ImagenEngine(f.paths, {
    adapters: { images: async () => { calls++; return imageResult(); } },
    writeState: async (file, value) => {
      if (!failedOnce && (value as { status: string }).status === 'running') {
        failedOnce = true;
        throw Object.assign(new Error('Simulated storage unavailable'), { code: 'EACCES' });
      }
      await writeJson(file, value);
    },
  }).initialize();
  t.after(() => engine.close());
  const job = await engine.submit(f.request());
  const result = await engine.wait(job.jobId);
  assert.equal(result.status, 'unknown');
  assert.equal(result.error?.code, 'STATE_WRITE_FAILED');
  assert.equal(calls, 0);
  assert.equal((await engine.cancel(job.jobId)).status, 'unknown');
});

test('Existing observers notice a job owner exiting, and local wait can be stopped', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const engine = await f.engine(async () => imageResult());
  const job = await engine.submit(f.request());
  await engine.wait(job.jobId);
  const path = join(f.paths.dataDir, 'jobs', `${job.jobId}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.status = 'running'; stored.ownerPid = 2147483647;
  await writeJson(path, stored);
  const result = await engine.wait(job.jobId);
  assert.equal(result.status, 'unknown');
  assert.equal(result.error?.code, 'PROCESS_INTERRUPTED');

  stored.ownerPid = process.pid;
  await writeJson(path, stored);
  const waiting = engine.wait(job.jobId);
  await engine.close();
  await assert.rejects(waiting, (error: unknown) => error instanceof ImagenError && error.code === 'WAIT_CANCELLED');
});
