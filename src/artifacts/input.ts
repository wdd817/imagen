import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { imageDimensionsFromData } from 'image-dimensions';
import { ImagenError } from '../core/errors.js';

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export function inspectImage(bytes: Uint8Array): { mimeType: string; width: number; height: number; extension: string } {
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 12) throw new ImagenError('INVALID_IMAGE', 'Image is empty, invalid, or exceeds 50 MiB.');
  try {
    // Only dispatch the three supported formats to the dimension parser.
    const data = Buffer.from(bytes);
    const supportedMagic = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) ||
      (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP');
    if (!supportedMagic) throw new Error('unsupported');
    const dimensions = imageDimensionsFromData(bytes);
    if (!dimensions) throw new Error('dimensions');
    const formats: Record<string, { mimeType: string; extension: string }> = {
      png: { mimeType: 'image/png', extension: 'png' },
      jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
      webp: { mimeType: 'image/webp', extension: 'webp' },
    };
    const format = dimensions.type ? formats[dimensions.type] : undefined;
    if (!format || !dimensions.width || !dimensions.height || dimensions.width > 32768 || dimensions.height > 32768) throw new Error('unsupported');
    return { ...format, width: dimensions.width, height: dimensions.height };
  } catch {
    throw new ImagenError('INVALID_IMAGE', 'Expected a valid PNG, JPEG or WebP image with supported dimensions.');
  }
}
export async function readInputImage(file: string): Promise<{ bytes: Buffer; mimeType: string; width: number; height: number }> {
  if (!isAbsolute(file)) throw new ImagenError('INVALID_PATH', 'Input image paths must be absolute.');
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new ImagenError('INVALID_IMAGE', 'Input image must be a regular file no larger than 50 MiB.');
    const bytes = await readFile(file);
    return { bytes, ...inspectImage(bytes) };
  } catch (error) {
    if (error instanceof ImagenError) throw error;
    throw new ImagenError('IMAGE_READ_FAILED', 'Unable to read the requested input image.');
  }
}
