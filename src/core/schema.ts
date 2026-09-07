import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ImageRequest, ImagenConfig, Profile } from './types.js';
import { ImagenError } from './errors.js';

const absolutePath = z.string().min(1).refine(isAbsolute, 'Use an absolute path.');
const capability = z.enum(['supported', 'unsupported', 'unknown']);
export const profileSchema = z.object({
  protocol: z.enum(['images', 'responses', 'gemini', 'imagen']),
  platform: z.enum(['developer', 'vertex']).optional(),
  model: z.string().min(1),
  baseUrl: z.url().refine(value => { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))); }, 'Use HTTPS, or loopback HTTP for testing.').optional(),
  apiVersion: z.string().regex(/^v[0-9]+[a-z0-9]*$/).optional(),
  project: z.string().min(1).optional(), location: z.string().min(1).optional(),
  auth: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('apiKey'), credential: z.string().regex(/^[a-zA-Z0-9._-]+$/) }).strict(),
    z.object({ kind: z.literal('googleCredentials'), file: absolutePath }).strict(),
  ]),
  capabilities: z.object({ generate: capability, edit: capability, references: capability, mask: capability }).strict(),
  evidence: z.string().min(1),
  maxCount: z.number().int().min(1).max(10).default(1),
  maxInputImages: z.number().int().min(0).max(16).default(8),
  responsesMode: z.enum(['tool', 'direct']).optional(), imageModel: z.string().min(1).optional(),
}).strict();
export const configSchema = z.object({
  schemaVersion: z.literal(1), defaultProfile: z.string().min(1).optional(),
  profiles: z.record(z.string().regex(/^[a-zA-Z0-9._-]+$/), profileSchema),
}).strict();
export const imageRequestSchema = z.object({
  requestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
  operation: z.enum(['generate', 'edit']), prompt: z.string().min(1).max(64000),
  profile: z.string().min(1), targetImage: absolutePath.optional(),
  referenceImages: z.array(absolutePath).max(16).default([]), mask: absolutePath.optional(),
  outputDir: absolutePath, count: z.number().int().min(1).max(10).default(1),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
  providerOptions: z.record(z.string(), z.unknown()).default({}),
}).strict();
export function parseConfig(value: unknown): ImagenConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new ImagenError('CONFIG_INVALID', 'Invalid configuration. Check schemaVersion, profiles, authentication references and capability declarations.');
  if (parsed.data.defaultProfile && !parsed.data.profiles[parsed.data.defaultProfile]) throw new ImagenError('CONFIG_INVALID', 'defaultProfile does not exist.');
  return parsed.data;
}
export function parseRequest(value: unknown): ImageRequest {
  const parsed = imageRequestSchema.safeParse(value);
  if (!parsed.success) throw new ImagenError('INVALID_REQUEST', parsed.error.issues.map(i => `${i.path.join('.') || 'request'}: ${i.message}`).join('; '));
  const request = parsed.data;
  if (request.operation === 'edit' && !request.targetImage) throw new ImagenError('INVALID_REQUEST', 'edit requires targetImage.');
  if (request.operation === 'generate' && request.targetImage) throw new ImagenError('INVALID_REQUEST', 'Use referenceImages for generation, or operation edit for targetImage.');
  if (request.mask && !request.targetImage) throw new ImagenError('INVALID_REQUEST', 'mask requires targetImage.');
  return request;
}
export function validateCapabilities(request: ImageRequest, profile: Profile): void {
  const requireCapability = (key: keyof Profile['capabilities']) => {
    const state = profile.capabilities[key];
    if (state !== 'supported') throw new ImagenError('UNSUPPORTED_CAPABILITY', `${key} is ${state} for this profile. Select a verified profile or update its capability declaration.`);
  };
  requireCapability(request.operation);
  if (request.referenceImages.length) requireCapability('references');
  if (request.mask) requireCapability('mask');
  if (request.count > profile.maxCount) throw new ImagenError('UNSUPPORTED_COUNT', `This profile allows at most ${profile.maxCount} image(s) per request.`);
  if (request.referenceImages.length + Number(!!request.targetImage) > profile.maxInputImages) throw new ImagenError('UNSUPPORTED_INPUT_COUNT', `This profile allows at most ${profile.maxInputImages} input image(s).`);
}
