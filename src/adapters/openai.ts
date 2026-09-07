import { basename } from 'node:path';
import OpenAI, { toFile } from 'openai';
import type { ImageEditParamsNonStreaming, ImageGenerateParamsNonStreaming } from 'openai/resources/images';
import type { ResponseCreateParamsNonStreaming, ResponseInputContent, Tool } from 'openai/resources/responses/responses';
import { z } from 'zod';
import { readInputImage } from '../artifacts/input.js';
import { ImagenError } from '../core/errors.js';
import type { AdapterImage, AdapterResult, ImageAdapter, ImageRequest, Profile } from '../core/types.js';

const optionsSchema = z.object({
  size: z.string().regex(/^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/).optional(),
  quality: z.enum(['auto', 'low', 'medium', 'high', 'standard', 'hd']).optional(),
  background: z.enum(['auto', 'opaque', 'transparent']).optional(),
  output_format: z.enum(['png', 'jpeg', 'webp']).optional(),
  output_compression: z.number().int().min(0).max(100).optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
  style: z.enum(['vivid', 'natural']).optional(),
  input_fidelity: z.enum(['low', 'high']).optional(),
  moderation: z.enum(['auto', 'low']).optional(),
}).strict();
type ProviderOptions = z.infer<typeof optionsSchema>;
type JsonRecord = Record<string, unknown>;

/** Public option discovery; cross-field and reference-dependent checks run before submission. */
export function openaiOptionsSchema(profile: Profile, operation: 'generate' | 'edit'): z.ZodType {
  const shape: Record<string, z.ZodType> = { ...optionsSchema.shape };
  if (profile.protocol === 'images' && operation === 'edit') {
    delete shape.style;
    delete shape.moderation;
    shape.quality = z.enum(['auto', 'low', 'medium', 'high', 'standard']).optional();
  }
  if (profile.protocol === 'responses' && (profile.responsesMode ?? 'tool') === 'tool') {
    delete shape.response_format;
    delete shape.style;
    shape.quality = z.enum(['auto', 'low', 'medium', 'high']).optional();
  }
  const selectedImageModel = profile.protocol === 'responses' && (profile.responsesMode ?? 'tool') === 'tool' ? profile.imageModel : profile.model;
  if (/^gpt-image-2(?:-|$)/.test(selectedImageModel ?? '')) delete shape.input_fidelity;
  return z.object(shape).strict();
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function invalid(message: string): never { throw new ImagenError('INVALID_OPTIONS', message); }

function validateOptions(request: ImageRequest, profile: Profile): ProviderOptions {
  const parsed = optionsSchema.safeParse(request.providerOptions);
  if (!parsed.success) invalid('Unsupported or invalid OpenAI providerOptions. Use the documented image options; request fields cannot be overridden.');
  const options = parsed.data;
  const hasInputs = Boolean(request.targetImage || request.referenceImages.length);
  if (request.operation === 'edit' && !request.targetImage) invalid('Editing requires a target image.');
  if (request.operation === 'generate' && request.targetImage) invalid('A target image is only valid for editing; use referenceImages for guided generation.');
  if (request.mask && (!request.targetImage || request.operation !== 'edit')) invalid('A mask requires an edit target.');
  if (options.input_fidelity && !hasInputs) invalid('input_fidelity requires an input image.');
  const selectedImageModel = profile.protocol === 'responses' && (profile.responsesMode ?? 'tool') === 'tool' ? profile.imageModel : profile.model;
  if (options.input_fidelity && /^gpt-image-2(?:-|$)/.test(selectedImageModel ?? '')) invalid('gpt-image-2 handles input images at high fidelity automatically and does not accept input_fidelity.');
  if (options.background === 'transparent' && options.output_format === 'jpeg') invalid('Transparent backgrounds require PNG or WebP output.');
  if (options.output_compression !== undefined && !['jpeg', 'webp'].includes(options.output_format ?? 'png')) invalid('output_compression requires an explicit JPEG or WebP output format.');
  if (profile.protocol === 'images' && hasInputs && (options.style || options.moderation || options.quality === 'hd')) {
    invalid('The selected options are not supported by the Images editing endpoint.');
  }
  if (profile.protocol === 'responses' && (profile.responsesMode ?? 'tool') === 'tool') {
    if (request.count !== 1) invalid('Responses tool mode supports count=1. Additional returned images are preserved, but an exact larger count is not supported.');
    if (options.response_format || options.style || options.quality === 'standard' || options.quality === 'hd') invalid('The selected options are not supported by the Responses image-generation tool.');
  }
  if (profile.protocol === 'responses' && profile.responsesMode === 'direct') {
    if (request.mask) invalid('Responses direct mode does not define a mask mapping. Use a profile with a verified mask-capable protocol.');
    if (profile.imageModel) invalid('imageModel is only supported in Responses tool mode.');
  }
  return options;
}

interface InputImage { bytes: Buffer; name: string; mimeType: string; width: number; height: number }
async function readImage(path: string, signal: AbortSignal, maskMaxBytes?: number): Promise<InputImage> {
  if (signal.aborted) throw new ImagenError('CANCELLED', 'The operation was cancelled before submission.');
  const image = await readInputImage(path);
  if (maskMaxBytes !== undefined && (image.mimeType !== 'image/png' || image.bytes.length >= maskMaxBytes)) throw new ImagenError('INVALID_IMAGE', `Masks must be PNG files smaller than ${maskMaxBytes / (1024 * 1024)} MiB for the selected image model.`);
  return { ...image, name: basename(path) };
}

function imageValue(value: unknown, format?: unknown): AdapterImage | undefined {
  const item = record(value);
  if (!item) return undefined;
  const base64 = nonempty(item.b64_json) ?? nonempty(item.base64);
  const url = nonempty(item.url) ?? nonempty(item.image_url) ?? nonempty(record(item.image_url)?.url);
  const encoded = base64 ?? (url?.startsWith('data:') ? url : undefined);
  if (encoded) {
    const dataUrl = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(encoded);
    if (encoded.startsWith('data:') && !dataUrl) return undefined;
    const payload = dataUrl?.[2] ?? encoded;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload.replace(/[\r\n]/g, ''))) return undefined;
    const mimeType = dataUrl?.[1] ?? ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[String(format)];
    return { base64: payload, ...(mimeType ? { mimeType } : {}) };
  }
  if (url) {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return { url };
    } catch { /* Invalid image URL: never interpret plain output text as a path. */ }
  }
  return undefined;
}

function normalizeResult(raw: unknown, protocol: Profile['protocol'], direct: boolean, format?: string): AdapterResult {
  const response = record(raw);
  if (!response) throw new ImagenError('INVALID_RESPONSE', 'The provider returned an invalid image response.');
  const providerRequestId = nonempty(response._request_id);
  const status = nonempty(response.status);
  if (protocol === 'responses' && status && status !== 'completed') {
    const pending = !['failed', 'cancelled'].includes(status);
    throw new ImagenError('PROVIDER_INCOMPLETE', 'The provider did not return a completed response. Do not resubmit without checking the remote outcome.', pending, providerRequestId);
  }
  const images: AdapterImage[] = [];
  const text: string[] = [];
  const warnings: string[] = [];
  const add = (value: unknown, imageFormat?: unknown) => {
    const image = imageValue(value, imageFormat ?? format);
    if (image) images.push(image);
  };
  if (protocol === 'images' || direct) {
    for (const entry of Array.isArray(response.data) ? response.data : []) add(entry, response.output_format);
    if (direct) for (const entry of Array.isArray(response.images) ? response.images : []) add(entry, response.output_format);
  }
  if (protocol === 'responses') {
    for (const value of Array.isArray(response.output) ? response.output : []) {
      const item = record(value);
      if (!item) continue;
      if (item.type === 'image_generation_call') {
        if (item.status !== undefined && item.status !== 'completed') {
          warnings.push('An unfinished image result was omitted.');
          continue;
        }
        add({ b64_json: item.result }, item.output_format);
      }
      if (direct && item.type === 'output_image') add(item, item.output_format);
      if (item.type === 'message') {
        for (const partValue of Array.isArray(item.content) ? item.content : []) {
          const part = record(partValue);
          if (part?.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
          if (direct && part?.type === 'output_image') add(part, part.output_format);
        }
      }
    }
  }
  if (!images.length) throw new ImagenError('NO_IMAGE', 'The provider returned no completed image. Text-only responses are not image-generation success.', false, providerRequestId);
  return {
    images,
    ...(text.length ? { text: text.join('\n') } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(record(response.usage) ? { usage: record(response.usage) } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function mapError(error: unknown, submitted: boolean): ImagenError {
  if (error instanceof ImagenError) return error;
  if (error instanceof OpenAI.APIUserAbortError) return new ImagenError('CANCELLED', 'The local request was cancelled. Remote execution may still continue.', submitted);
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new ImagenError('PROVIDER_TIMEOUT', 'The provider request timed out. Its remote outcome could not be confirmed.', submitted);
  if (error instanceof OpenAI.APIConnectionError) return new ImagenError('PROVIDER_CONNECTION', 'The provider connection failed. Its remote outcome could not be confirmed.', submitted);
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const requestId = error.requestID ?? undefined;
    if (status === 401 || status === 403) return new ImagenError('PROVIDER_AUTH', 'The provider rejected authentication or access. Check the selected profile.', false, requestId);
    if (status === 429) return new ImagenError('PROVIDER_RATE_LIMIT', 'The provider rate-limited the request. No automatic retry was attempted.', submitted, requestId);
    const uncertain = submitted && (status === undefined || status === 408 || status === 409 || status >= 500);
    return new ImagenError('PROVIDER_ERROR', 'The provider rejected or failed the image request. Check the profile and request parameters.', uncertain, requestId);
  }
  return new ImagenError('PROVIDER_REQUEST_ERROR', 'The provider request could not be completed.', submitted);
}

export const openaiAdapter: ImageAdapter = async (request, profile, context) => {
  if (profile.protocol !== 'images' && profile.protocol !== 'responses') throw new ImagenError('INVALID_PROFILE', 'The OpenAI adapter requires an Images or Responses profile.');
  if (context.auth.kind !== 'apiKey' || !context.auth.apiKey.trim()) throw new ImagenError('AUTH_REQUIRED', 'This profile requires an explicitly configured API key.');
  const options = validateOptions(request, profile);
  if (context.signal.aborted) throw new ImagenError('CANCELLED', 'The operation was cancelled before submission.');
  const paths = [...(request.targetImage ? [request.targetImage] : []), ...request.referenceImages];
  const inputs: InputImage[] = [];
  for (const path of paths) inputs.push(await readImage(path, context.signal));
  const imageModel = profile.protocol === 'responses' && (profile.responsesMode ?? 'tool') === 'tool' ? profile.imageModel : profile.model;
  const maskLimit = (imageModel === 'dall-e-2' ? 4 : 50) * 1024 * 1024;
  const mask = request.mask ? await readImage(request.mask, context.signal, maskLimit) : undefined;
  if (mask && (mask.width !== inputs[0]?.width || mask.height !== inputs[0]?.height)) throw new ImagenError('INVALID_IMAGE', 'The mask dimensions must match the target image.');
  let submitted = false;
  try {
    const client = new OpenAI({
      apiKey: context.auth.apiKey,
      baseURL: profile.baseUrl ?? 'https://api.openai.com/v1',
      organization: null,
      project: null,
      adminAPIKey: null,
      webhookSecret: null,
      maxRetries: 0,
      timeout: request.timeoutMs,
      logLevel: 'off',
      fetchOptions: { redirect: 'error' },
      fetch: async (url, init) => { submitted = true; return globalThis.fetch(url, init); },
    });
    const requestOptions = { signal: context.signal, timeout: request.timeoutMs, maxRetries: 0 };
    let raw: unknown;
    if (profile.protocol === 'images') {
      if (inputs.length) {
        const files = await Promise.all(inputs.map(input => toFile(input.bytes, input.name, { type: input.mimeType })));
        const body: ImageEditParamsNonStreaming = {
          ...options,
          model: profile.model,
          prompt: request.prompt,
          n: request.count,
          image: files.length === 1 ? files[0]! : files,
          ...(mask ? { mask: await toFile(mask.bytes, mask.name, { type: mask.mimeType }) } : {}),
          stream: false,
        } as ImageEditParamsNonStreaming;
        raw = await client.images.edit(body, requestOptions);
      } else {
        const body: ImageGenerateParamsNonStreaming = { ...options, model: profile.model, prompt: request.prompt, n: request.count, stream: false };
        raw = await client.images.generate(body, requestOptions);
      }
    } else {
      const content: ResponseInputContent[] = [
        { type: 'input_text', text: request.prompt },
        ...inputs.map(input => ({ type: 'input_image' as const, image_url: `data:${input.mimeType};base64,${input.bytes.toString('base64')}`, detail: 'auto' as const })),
      ];
      const body: ResponseCreateParamsNonStreaming = {
        model: profile.model,
        input: [{ role: 'user', content }],
        stream: false,
      };
      if (profile.responsesMode === 'direct') {
        // Deliberate gateway dialect: never entered as an automatic fallback.
        Object.assign(body, options, { n: request.count });
      } else {
        const tool: Tool.ImageGeneration = {
          ...options,
          type: 'image_generation',
          action: request.operation,
          ...(profile.imageModel ? { model: profile.imageModel } : {}),
          ...(mask ? { input_image_mask: { image_url: `data:image/png;base64,${mask.bytes.toString('base64')}` } } : {}),
        } as Tool.ImageGeneration;
        body.tools = [tool];
        body.tool_choice = { type: 'image_generation' };
      }
      raw = await client.responses.create(body, requestOptions);
    }
    return normalizeResult(raw, profile.protocol, profile.responsesMode === 'direct', options.output_format);
  } catch (error) { throw mapError(error, submitted); }
};
