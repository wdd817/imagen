import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ImagenError } from '../core/errors.js';
import { inspectImage, MAX_IMAGE_BYTES } from './input.js';
import type { AdapterImage, Artifact } from '../core/types.js';

async function download(url: string, signal: AbortSignal, allowLocalUrls: boolean): Promise<Buffer> {
  let current = new URL(url);
  for (let hop = 0; hop <= 3; hop++) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(current.hostname);
    if (current.username || current.password || (current.protocol !== 'https:' && !(allowLocalUrls && local && current.protocol === 'http:'))) throw new ImagenError('INVALID_IMAGE_URL', 'Image downloads require HTTPS.');
    const response = await fetch(current, { redirect: 'manual', signal, headers: { Accept: 'image/png,image/jpeg,image/webp' } });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) throw new ImagenError('IMAGE_DOWNLOAD_FAILED', `Image download failed (HTTP ${response.status}).`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) { await response.body.cancel(); throw new ImagenError('INVALID_IMAGE', 'Downloaded image exceeds 50 MiB.'); }
    const chunks: Uint8Array[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > MAX_IMAGE_BYTES) throw new ImagenError('INVALID_IMAGE', 'Downloaded image exceeds 50 MiB.');
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  }
  throw new ImagenError('IMAGE_DOWNLOAD_FAILED', 'Image redirect limit exceeded.');
}
export async function materializeImage(image: AdapterImage, fileBase: string, outputDir: string, signal: AbortSignal, allowLocalUrls = false): Promise<Artifact> {
  let bytes: Buffer;
  if (image.base64 !== undefined) {
    const base64 = image.base64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s/g, '');
    if (base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new ImagenError('INVALID_IMAGE', 'Invalid or oversized base64 image.');
    bytes = Buffer.from(base64, 'base64');
  } else if (image.url) bytes = await download(image.url, signal, allowLocalUrls);
  else throw new ImagenError('NO_IMAGE', 'Provider returned an empty image.');
  const details = inspectImage(bytes);
  if (image.mimeType && image.mimeType !== details.mimeType && !(image.mimeType === 'image/jpg' && details.mimeType === 'image/jpeg')) throw new ImagenError('INVALID_IMAGE', 'Provider image MIME type does not match its bytes.');
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, `${fileBase}.${details.extension}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const temp = join(outputDir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    try { await link(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existingHash = createHash('sha256').update(await readFile(path)).digest('hex');
      if (existingHash !== sha256) throw new ImagenError('OUTPUT_EXISTS', 'Output file already exists with different content. It was not overwritten.');
    }
  } finally { await unlink(temp).catch(() => {}); }
  return { path, mimeType: details.mimeType, width: details.width, height: details.height, bytes: bytes.length, sha256 };
}
