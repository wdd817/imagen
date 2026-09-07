import { mkdir, readFile, readdir, writeFile, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { loadConfig, resolveAuth, writeJson } from '../config/store.js';
import { parseRequest, validateCapabilities } from './schema.js';
import { ImagenError, publicError } from './errors.js';
import { readInputImage } from '../artifacts/input.js';
import { materializeImage } from '../artifacts/store.js';
import { openaiAdapter, openaiOptionsSchema } from '../adapters/openai.js';
import { googleAdapter, googleOptionsSchema } from '../adapters/google.js';
import type { AdapterResult, ImageAdapter, ImageRequest, JobRecord, Profile, ResolvedAuth, RuntimePaths, Protocol } from './types.js';

interface StoredJob extends JobRecord { ownerPid: number }
interface Work { record: StoredJob; request: ImageRequest; profile: Profile; auth: ResolvedAuth; controller: AbortController }
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'unknown']);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function publicRecord(record: StoredJob): JobRecord { const { ownerPid: _, ...result } = record; return result; }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }

export class ImagenEngine {
  private queue: Work[] = [];
  private running = new Map<string, Work>();
  private promises = new Set<Promise<void>>();
  private storageFailures = new Map<string, JobRecord>();
  private closed = false;
  private adapters: Record<Protocol, ImageAdapter>;
  private jobsDir: string;
  constructor(public paths: RuntimePaths, private options: { adapters?: Partial<Record<Protocol, ImageAdapter>>; concurrency?: number; allowLocalUrls?: boolean; writeState?: typeof writeJson } = {}) {
    this.jobsDir = join(paths.dataDir, 'jobs');
    this.adapters = { images: openaiAdapter, responses: openaiAdapter, gemini: googleAdapter, imagen: googleAdapter, ...options.adapters };
  }
  async initialize(): Promise<this> {
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    for (const file of await readdir(this.jobsDir)) {
      if (!/^job-[a-f0-9-]+\.json$/.test(file)) continue;
      const record = JSON.parse(await readFile(join(this.jobsDir, file), 'utf8')) as StoredJob;
      if (!terminal.has(record.status) && !alive(record.ownerPid)) {
        record.status = record.status === 'queued' ? 'cancelled' : 'unknown';
        record.error = { code: 'PROCESS_INTERRUPTED', message: 'The previous process stopped. This job was not automatically submitted again.', outcomeUnknown: record.status === 'unknown' };
        await this.save(record);
      }
    }
    return this;
  }
  private async save(record: StoredJob): Promise<void> {
    record.updatedAt = new Date().toISOString();
    await (this.options.writeState ?? writeJson)(join(this.jobsDir, `${record.jobId}.json`), record);
  }
  async capabilities(): Promise<unknown> {
    const config = await loadConfig(this.paths);
    return { defaultProfile: config.defaultProfile, profiles: Object.fromEntries(Object.entries(config.profiles).map(([name, p]) => {
      const optionsSchema = p.protocol === 'images' || p.protocol === 'responses' ? openaiOptionsSchema : googleOptionsSchema;
      return [name, { protocol: p.protocol, platform: p.platform, model: p.model, capabilities: p.capabilities, evidence: p.evidence, maxCount: p.maxCount, maxInputImages: p.maxInputImages,
        providerOptions: { generate: z.toJSONSchema(optionsSchema(p, 'generate')), edit: z.toJSONSchema(optionsSchema(p, 'edit')) } }];
    })) };
  }
  async submit(input: unknown): Promise<JobRecord> {
    if (this.closed) throw new ImagenError('ENGINE_CLOSED', 'The service is closing.');
    const request = parseRequest(input);
    const config = await loadConfig(this.paths);
    const profile = config.profiles[request.profile];
    if (!profile) throw new ImagenError('PROFILE_NOT_FOUND', 'The selected profile does not exist.');
    validateCapabilities(request, profile);
    const auth = await resolveAuth(profile, this.paths);
    const inputHashes: string[] = [];
    for (const file of [request.targetImage, ...request.referenceImages, request.mask].filter((f): f is string => !!f)) inputHashes.push(createHash('sha256').update((await readInputImage(file)).bytes).digest('hex'));
    if (request.mask && request.targetImage) {
      const [mask, target] = await Promise.all([readInputImage(request.mask), readInputImage(request.targetImage)]);
      if (mask.width !== target.width || mask.height !== target.height) throw new ImagenError('INVALID_MASK', 'Mask dimensions must match the target image.');
    }
    const requestHash = hash({ request, profile, inputHashes });
    if (this.queue.length >= 32) throw new ImagenError('QUEUE_FULL', 'The local queue is full. Wait for pending jobs to finish.');
    const indexPath = join(this.jobsDir, `request-${hash(request.requestId)}.json`);
    const jobId = `job-${randomUUID()}`;
    const indexTemp = `${indexPath}.${randomUUID()}.tmp`;
    await writeFile(indexTemp, JSON.stringify({ jobId, requestHash }), { flag: 'wx', mode: 0o600 });
    try { await link(indexTemp, indexPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = JSON.parse(await readFile(indexPath, 'utf8')) as { jobId: string; requestHash: string };
      if (existing.requestHash !== requestHash) throw new ImagenError('REQUEST_CONFLICT', 'This requestId already belongs to a different request, profile or input image.');
      // An interrupted registration must never be silently re-submitted.
      for (let attempt = 0; attempt < 10; attempt++) {
        try { return await this.get(existing.jobId); }
        catch (error) { if (!(error instanceof ImagenError) || error.code !== 'JOB_NOT_FOUND') throw error; await delay(20); }
      }
      throw new ImagenError('REGISTRATION_INTERRUPTED', 'This request was registered but its job record is unavailable. Check local state before creating a new request.', true);
    } finally { await unlink(indexTemp).catch(() => {}); }
    const record: StoredJob = { schemaVersion: 1, jobId, requestId: request.requestId, requestHash, profile: request.profile, model: profile.model, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputDir: request.outputDir, images: [], warnings: [], ownerPid: process.pid };
    await this.save(record);
    this.queue.push({ record, request, profile, auth, controller: new AbortController() });
    const snapshot = publicRecord(structuredClone(record));
    this.pump();
    return snapshot;
  }
  private pump(): void {
    const concurrency = this.options.concurrency ?? 2;
    while (!this.closed && this.running.size < concurrency && this.queue.length) {
      const work = this.queue.shift()!;
      this.running.set(work.record.jobId, work);
      const promise = this.execute(work).catch(async () => {
        // Persisting state itself can fail, including before the adapter is called.
        // Keep an observable terminal state so a live service never polls forever.
        work.record.status = 'unknown';
        work.record.error = { code: 'STATE_WRITE_FAILED', message: 'The local job state could not be saved reliably. Check the data directory before any new generation.', outcomeUnknown: true };
        this.storageFailures.set(work.record.jobId, publicRecord(structuredClone(work.record)));
        await this.save(work.record).catch(() => {});
      }).finally(() => {
        this.running.delete(work.record.jobId); this.promises.delete(promise); this.pump();
      });
      this.promises.add(promise);
    }
  }
  private async execute(work: Work): Promise<void> {
    const { record, request, profile, auth, controller } = work;
    record.status = 'running'; await this.save(record);
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    let providerCompleted = false;
    try {
      const result = await this.adapters[profile.protocol](request, profile, { auth, signal: controller.signal });
      if (!result.images.length) throw new ImagenError('NO_IMAGE', 'The provider returned no image.');
      providerCompleted = true;
      if (result.images.length > 10) { result.warnings = [...(result.warnings ?? []), 'Provider returned more than 10 images; only the first 10 are saved.']; result.images = result.images.slice(0, 10); }
      record.providerRequestId = result.providerRequestId; record.usage = result.usage; record.text = result.text;
      record.warnings = result.warnings ?? [];
      await writeJson(join(this.jobsDir, `${record.jobId}.result.json`), result);
      await this.saveResult(record, result, controller.signal);
    } catch (error) {
      if (providerCompleted) {
        record.status = 'failed';
        record.error = { code: 'SAVE_FAILED', message: 'Generation completed, but saving one or more images failed. Use imagen recover with this job ID; do not generate again.', providerRequestId: record.providerRequestId };
      } else {
        const detail = controller.signal.aborted ? { code: 'OUTCOME_UNKNOWN', message: 'Local waiting stopped. The provider may still complete or charge this request.', outcomeUnknown: true } : publicError(error);
        if (detail.code === 'INTERNAL_ERROR') detail.outcomeUnknown = true;
        record.status = detail.outcomeUnknown ? 'unknown' : 'failed'; record.error = detail;
      }
      await this.save(record);
    } finally { clearTimeout(timer); }
  }
  private async saveResult(record: StoredJob, result: AdapterResult, signal: AbortSignal): Promise<void> {
    record.images = [];
    for (let i = 0; i < result.images.length; i++) {
      record.images.push(await materializeImage(result.images[i]!, `${record.jobId}-${i + 1}`, record.outputDir, signal, this.options.allowLocalUrls));
      await this.save(record);
    }
    record.status = 'succeeded'; delete record.error; await this.save(record);
  }
  private async readJob(jobId: string): Promise<StoredJob> {
    if (!/^job-[a-f0-9-]{36}$/.test(jobId)) throw new ImagenError('INVALID_JOB_ID', 'Invalid job ID.');
    let record: StoredJob;
    try { record = JSON.parse(await readFile(join(this.jobsDir, `${jobId}.json`), 'utf8')) as StoredJob; }
    catch { throw new ImagenError('JOB_NOT_FOUND', 'No job with this ID exists in the selected data directory.'); }
    if (!terminal.has(record.status) && !alive(record.ownerPid)) {
      record.status = record.status === 'queued' ? 'cancelled' : 'unknown';
      record.error = { code: 'PROCESS_INTERRUPTED', message: 'The process that submitted this job has exited. No generation was resubmitted.', outcomeUnknown: record.status === 'unknown' };
      await this.save(record);
    }
    return record;
  }
  async get(jobId: string): Promise<JobRecord> { return this.storageFailures.get(jobId) ?? publicRecord(await this.readJob(jobId)); }
  async wait(jobId: string): Promise<JobRecord> {
    while (true) {
      const job = await this.get(jobId);
      if (terminal.has(job.status)) return job;
      if (this.closed) throw new ImagenError('WAIT_CANCELLED', 'Local waiting was stopped. The job may still be running in its original process.');
      await delay(100);
    }
  }
  async cancel(jobId: string): Promise<JobRecord> {
    const queuedIndex = this.queue.findIndex(w => w.record.jobId === jobId);
    if (queuedIndex >= 0) {
      const [work] = this.queue.splice(queuedIndex, 1);
      work!.record.status = 'cancelled'; work!.record.warnings.push('Cancelled before the provider call.'); await this.save(work!.record);
      return publicRecord(work!.record);
    }
    const running = this.running.get(jobId);
    if (running) { running.controller.abort(); return this.wait(jobId); }
    const job = await this.get(jobId);
    if (!terminal.has(job.status)) throw new ImagenError('JOB_OWNED_BY_ANOTHER_PROCESS', 'Cancel this job through the MCP process that submitted it.');
    return job;
  }
  async recover(jobId: string): Promise<JobRecord> {
    const record = await this.readJob(jobId);
    if (record.status === 'succeeded') return publicRecord(record);
    if (this.running.has(jobId) || (!terminal.has(record.status) && alive(record.ownerPid))) throw new ImagenError('JOB_RUNNING', 'This job is still running.');
    let result: AdapterResult;
    try { result = JSON.parse(await readFile(join(this.jobsDir, `${jobId}.result.json`), 'utf8')); }
    catch { throw new ImagenError('RECOVERY_UNAVAILABLE', 'No saved provider result is available. This command never resubmits generation.'); }
    try { await this.saveResult(record, result, AbortSignal.timeout(120000)); }
    catch { record.status = 'failed'; record.error = { code: 'SAVE_FAILED', message: 'Saved provider result could not be restored. Check the output directory and image URL availability.' }; await this.save(record); }
    return publicRecord(record);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const work of this.queue.splice(0)) { work.record.status = 'cancelled'; await this.save(work.record); }
    for (const work of this.running.values()) work.controller.abort();
    await Promise.all(this.promises);
  }
}
export async function createEngine(paths: RuntimePaths): Promise<ImagenEngine> { return new ImagenEngine(paths).initialize(); }
