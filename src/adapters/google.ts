import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import {
  ApiError,
  EditMode,
  GoogleGenAI,
  MaskReferenceImage,
  MaskReferenceMode,
  RawReferenceImage,
  type GeneratedImage,
  type GoogleGenAIOptions,
  type HttpOptions,
  type Part,
  type ReferenceImage,
} from '@google/genai';
import { z } from 'zod';
import { readInputImage } from '../artifacts/input.js';
import { ImagenError } from '../core/errors.js';
import type { AdapterImage, AdapterResult, ImageAdapter, ImageRequest, Profile, ResolvedAuth } from '../core/types.js';

// No arbitrary request templates, headers, extraBody, tools, or retry overrides.
const outputOptions = {
  outputMimeType: z.enum(['image/png', 'image/jpeg']).optional(),
  outputCompressionQuality: z.number().int().min(1).max(100).optional(),
};
const geminiOptions = z.object({
  aspectRatio: z.string().regex(/^[1-9]\d?:[1-9]\d?$/).optional(),
  imageSize: z.enum(['1K', '2K', '4K']).optional(),
  ...outputOptions,
}).strict();
const geminiDeveloperOptions = geminiOptions.omit({ outputMimeType: true, outputCompressionQuality: true });
const imagenCommonOptions = {
  aspectRatio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional(),
  ...outputOptions,
  negativePrompt: z.string().min(1).max(10000).optional(),
  guidanceScale: z.number().positive().finite().optional(),
  seed: z.number().int().nonnegative().max(2147483647).optional(),
  addWatermark: z.boolean().optional(),
};
const imagenGenerateOptions = z.object({
  ...imagenCommonOptions,
  imageSize: z.enum(['1K', '2K']).optional(),
  enhancePrompt: z.boolean().optional(),
}).strict();
const imagenEditOptions = z.object({
  ...imagenCommonOptions,
  editMode: z.enum([
    EditMode.EDIT_MODE_DEFAULT,
    EditMode.EDIT_MODE_INPAINT_INSERTION,
    EditMode.EDIT_MODE_INPAINT_REMOVAL,
    EditMode.EDIT_MODE_OUTPAINT,
  ]).optional(),
  baseSteps: z.number().int().positive().max(1000).optional(),
}).strict();

/** Machine-readable options exposed by capabilities; transport controls remain private. */
export function googleOptionsSchema(profile: Profile, operation: 'generate' | 'edit'): z.ZodType {
  if (profile.protocol === 'gemini') return profile.platform === 'vertex' ? geminiOptions : geminiDeveloperOptions;
  if (profile.protocol === 'imagen' && profile.platform === 'vertex') return operation === 'edit' ? imagenEditOptions : imagenGenerateOptions;
  // A schema accepting nothing accurately represents an unsupported protocol/platform.
  return z.never();
}

function parseOptions<T>(schema: z.ZodType<T>, request: ImageRequest): T {
  const parsed = schema.safeParse(request.providerOptions);
  if (!parsed.success) throw new ImagenError('UNSUPPORTED_OPTIONS', 'Google provider options contain unsupported fields or invalid values. Consult the options for this protocol and operation.');
  return parsed.data;
}

function validateOutputOptions(options: { outputMimeType?: string; outputCompressionQuality?: number }): void {
  if (options.outputCompressionQuality !== undefined && options.outputMimeType !== 'image/jpeg') {
    throw new ImagenError('UNSUPPORTED_OPTIONS', 'outputCompressionQuality requires outputMimeType=image/jpeg.');
  }
}

function validId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9._~:/+=-]{1,256}$/.test(value) ? value : undefined;
}

function responseId(response: { responseId?: string; sdkHttpResponse?: { headers?: Record<string, string> } }): string | undefined {
  const direct = validId(response.responseId);
  if (direct) return direct;
  for (const [key, value] of Object.entries(response.sdkHttpResponse?.headers ?? {})) {
    if (['x-request-id', 'x-goog-request-id', 'request-id'].includes(key.toLowerCase())) {
      const id = validId(value);
      if (id) return id;
    }
  }
  return undefined;
}

async function clientOptions(profile: Profile, auth: ResolvedAuth, timeoutMs: number): Promise<GoogleGenAIOptions> {
  if (profile.protocol !== 'gemini' && profile.protocol !== 'imagen') {
    throw new ImagenError('INVALID_PROFILE', 'The Google adapter requires a Gemini or Imagen protocol profile.');
  }
  const vertex = profile.platform === 'vertex';
  if (!vertex && (profile.project || profile.location)) throw new ImagenError('INVALID_PROFILE', 'project and location require the Vertex platform.');
  if (vertex && Boolean(profile.project) !== Boolean(profile.location)) throw new ImagenError('INVALID_PROFILE', 'Vertex project and location must be configured together.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new ImagenError('INVALID_REQUEST', 'timeoutMs must be a positive integer.');
  // Explicit defaults prevent SDK endpoint environment variables from rerouting a profile.
  const baseUrl = profile.baseUrl ?? (vertex
    ? profile.location && profile.location !== 'global'
      ? `https://${profile.location}-aiplatform.googleapis.com`
      : 'https://aiplatform.googleapis.com'
    : 'https://generativelanguage.googleapis.com');
  const httpOptions: HttpOptions = { baseUrl, timeout: timeoutMs, retryOptions: { attempts: 1 } };
  const options: GoogleGenAIOptions = {
    enterprise: vertex,
    apiVersion: profile.apiVersion ?? (vertex ? 'v1' : 'v1beta'),
    httpOptions,
    ...(vertex && profile.project ? { project: profile.project, location: profile.location } : {}),
  };
  if (auth.kind === 'apiKey') {
    if (!auth.apiKey) throw new ImagenError('AUTH_CONFIG_ERROR', 'The configured Google API key is empty.');
    options.apiKey = auth.apiKey;
  } else {
    if (!vertex || !profile.project || !profile.location || !isAbsolute(auth.file)) {
      throw new ImagenError('AUTH_CONFIG_ERROR', 'Google credential files require Vertex project, location, and an absolute credential path.');
    }
    try {
      if (!(await stat(auth.file)).isFile()) throw new Error('not a file');
    } catch {
      throw new ImagenError('AUTH_CONFIG_ERROR', 'The configured Google credential file is unavailable.');
    }
    // keyFile is explicit: the SDK must not search for ambient ADC credentials.
    options.googleAuthOptions = {
      keyFile: auth.file,
      projectId: profile.project,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    };
  }
  return options;
}

function throwGoogleError(error: unknown, signal: AbortSignal): never {
  if (error instanceof ImagenError) throw error;
  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 401 || status === 403) throw new ImagenError('PROVIDER_AUTH_ERROR', 'Google rejected the configured credentials or access permissions.');
    if (status === 429) throw new ImagenError('PROVIDER_RATE_LIMIT', 'Google rejected the request because of a quota or rate limit.');
    if (status === 408 || status >= 500) throw new ImagenError('PROVIDER_OUTCOME_UNKNOWN', 'Google returned an error after submission; generation may have occurred. Do not automatically resubmit.', true);
    throw new ImagenError('PROVIDER_REQUEST_REJECTED', 'Google rejected the image request. Check the selected model, operation, and supported parameters.');
  }
  throw new ImagenError(signal.aborted ? 'PROVIDER_CANCELLED' : 'PROVIDER_OUTCOME_UNKNOWN', signal.aborted
    ? 'Waiting for Google was cancelled after submission; the service may still generate and charge for an image.'
    : 'The Google request did not produce a verifiable result. Generation may have occurred; do not automatically resubmit.', true);
}

function assertImages(result: AdapterResult, expectedCount: number): AdapterResult {
  if (result.images.length === 0) throw new ImagenError('NO_IMAGE_RETURNED', 'Google completed the request without a usable image. The selected model or content restrictions may prevent this operation.', false, result.providerRequestId);
  if (result.images.length !== expectedCount) {
    result.warnings = [...(result.warnings ?? []), `Google returned ${result.images.length} image(s) for a request for ${expectedCount}; no additional generation was submitted.`];
  }
  return result;
}

function generatedImagesResult(response: { generatedImages?: GeneratedImage[]; sdkHttpResponse?: { headers?: Record<string, string> } }, count: number): AdapterResult {
  return assertImages({
    images: (response.generatedImages ?? []).flatMap<AdapterImage>(({ image }) => image?.imageBytes
      ? [{ base64: image.imageBytes, mimeType: image.mimeType }]
      : image?.gcsUri ? [{ url: image.gcsUri, mimeType: image.mimeType }] : []),
    providerRequestId: responseId(response),
  }, count);
}

export const googleAdapter: ImageAdapter = async (request, profile, { auth, signal }) => {
  if (signal.aborted) throw new ImagenError('CANCELLED', 'The Google request was cancelled before submission.');
  if (profile.protocol === 'gemini') {
    if (request.count !== 1) throw new ImagenError('UNSUPPORTED_COUNT', 'Gemini requests support count=1. Multiple paid requests are never submitted implicitly.');
    if (request.mask) throw new ImagenError('UNSUPPORTED_MASK', 'The Gemini adapter does not support a native mask parameter.');
    const options = parseOptions(geminiOptions, request);
    validateOutputOptions(options);
    if (profile.platform !== 'vertex' && (options.outputMimeType !== undefined || options.outputCompressionQuality !== undefined)) {
      throw new ImagenError('UNSUPPORTED_OPTIONS', 'Gemini Developer API does not support outputMimeType or outputCompressionQuality in imageConfig.');
    }
    if (request.operation === 'edit' && !request.targetImage) throw new ImagenError('INVALID_REQUEST', 'Editing requires a target image.');
    if (request.operation === 'generate' && request.targetImage) throw new ImagenError('INVALID_REQUEST', 'A target image requires the edit operation.');
    const parts: Part[] = [];
    if (request.targetImage) {
      const image = await readInputImage(request.targetImage);
      parts.push({ inlineData: { data: image.bytes.toString('base64'), mimeType: image.mimeType } });
    }
    for (const file of request.referenceImages) {
      const image = await readInputImage(file);
      parts.push({ inlineData: { data: image.bytes.toString('base64'), mimeType: image.mimeType } });
    }
    parts.push({ text: request.prompt });
    const init = await clientOptions(profile, auth, request.timeoutMs);
    if (signal.aborted) throw new ImagenError('CANCELLED', 'The Google request was cancelled before submission.');
    try {
      const client = new GoogleGenAI(init);
      const response = await client.models.generateContent({
        model: profile.model,
        contents: [{ role: 'user', parts }],
        config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: options, abortSignal: signal, automaticFunctionCalling: { disable: true } },
      });
      const images: AdapterResult['images'] = [];
      const text: string[] = [];
      for (const candidate of response.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.thought) continue;
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('image/')) {
            images.push({ base64: part.inlineData.data, mimeType: part.inlineData.mimeType });
          } else if (part.fileData?.fileUri && part.fileData.mimeType?.startsWith('image/')) {
            images.push({ url: part.fileData.fileUri, mimeType: part.fileData.mimeType });
          } else if (part.text) text.push(part.text);
        }
      }
      const usage: Record<string, number> = {};
      for (const name of ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'cachedContentTokenCount', 'thoughtsTokenCount', 'toolUsePromptTokenCount'] as const) {
        const value = response.usageMetadata?.[name];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[name] = value;
      }
      return assertImages({ images, ...(text.length ? { text: text.join('\n') } : {}), providerRequestId: responseId(response), ...(Object.keys(usage).length ? { usage } : {}) }, request.count);
    } catch (error) {
      throwGoogleError(error, signal);
    }
  }

  if (profile.protocol !== 'imagen' || profile.platform !== 'vertex') {
    throw new ImagenError('UNSUPPORTED_PROTOCOL', 'The installed Google SDK supports Imagen generateImages and editImage only on Vertex. Use the Gemini protocol for Developer API image models.');
  }
  if (request.referenceImages.length) throw new ImagenError('UNSUPPORTED_REFERENCES', 'Imagen subject and style references require explicit reference semantics, which this adapter does not yet expose. Use Gemini for general reference images.');
  const options = request.operation === 'edit' ? parseOptions(imagenEditOptions, request) : parseOptions(imagenGenerateOptions, request);
  validateOutputOptions(options);
  if (options.seed !== undefined && options.addWatermark !== false) throw new ImagenError('UNSUPPORTED_OPTIONS', 'Imagen seed requires addWatermark=false.');
  if (request.operation === 'generate' && (request.targetImage || request.mask)) throw new ImagenError('INVALID_REQUEST', 'Imagen generation does not accept a target image or mask; use edit.');
  const references: ReferenceImage[] = [];
  if (request.operation === 'edit') {
    if (!request.targetImage) throw new ImagenError('INVALID_REQUEST', 'Imagen editing requires a target image.');
    const target = await readInputImage(request.targetImage);
    const raw = new RawReferenceImage();
    raw.referenceId = 1;
    raw.referenceImage = { imageBytes: target.bytes.toString('base64'), mimeType: target.mimeType };
    references.push(raw);
    if (request.mask) {
      const mask = await readInputImage(request.mask);
      if (mask.width !== target.width || mask.height !== target.height) throw new ImagenError('INVALID_MASK', 'The Imagen mask must have the same dimensions as the target image.');
      const maskReference = new MaskReferenceImage();
      maskReference.referenceId = 2;
      maskReference.referenceImage = { imageBytes: mask.bytes.toString('base64'), mimeType: mask.mimeType };
      maskReference.config = { maskMode: MaskReferenceMode.MASK_MODE_USER_PROVIDED };
      references.push(maskReference);
    }
  }
  const init = await clientOptions(profile, auth, request.timeoutMs);
  if (signal.aborted) throw new ImagenError('CANCELLED', 'The Google request was cancelled before submission.');
  try {
    const client = new GoogleGenAI(init);
    const config = { ...options, numberOfImages: request.count, abortSignal: signal };
    const response = request.operation === 'generate'
      ? await client.models.generateImages({ model: profile.model, prompt: request.prompt, config })
      : await client.models.editImage({ model: profile.model, prompt: request.prompt, referenceImages: references, config });
    const result = generatedImagesResult(response, request.count);
    if (request.mask) result.warnings = [...(result.warnings ?? []), 'Imagen interprets non-zero mask pixels as the area to edit.'];
    return result;
  } catch (error) {
    throwGoogleError(error, signal);
  }
};
