import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { McpServer, type CallToolResult, type ContentBlock } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import packageInfo from '../../package.json' with { type: 'json' };
import { createEngine, type ImagenEngine } from '../core/engine.js';
import { publicError } from '../core/errors.js';
import { imageRequestSchema } from '../core/schema.js';
import type { JobRecord, RuntimePaths } from '../core/types.js';

const MAX_PREVIEW_BYTES = 1024 * 1024;
const jobIdSchema = z.string().min(1).max(160).describe('The jobId returned by imagen_generate or imagen_edit.');
const jobInputSchema = z.object({ jobId: jobIdSchema }).strict();
const submissionSchema = z.object(imageRequestSchema.shape).strict().omit({ operation: true });

function result(value: unknown, extraContent: ContentBlock[] = []): CallToolResult {
  // The engine returns serializable, credential-free public records.
  const output = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(output) }, ...extraContent], structuredContent: output };
}

async function safely(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return { ...result({ error: publicError(error) }), isError: true };
  }
}

async function previewContent(job: JobRecord): Promise<ContentBlock[]> {
  const artifact = job.images[0];
  if (!artifact || artifact.bytes > MAX_PREVIEW_BYTES || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(artifact.mimeType)) return [];
  let file;
  try {
    file = await open(artifact.path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES || stat.size !== artifact.bytes) return [];
    // Use a bounded read and verify the artifact hash, even if the saved file was replaced.
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) return [];
      offset += read.bytesRead;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) return [];
    return [{ type: 'image', mimeType: artifact.mimeType, data: bytes.toString('base64') }];
  } catch {
    // Optional previews must not hide the job status or usable artifact paths.
    return [];
  } finally {
    await file?.close();
  }
}

/** Exported for protocol-level testing and hosts that supply their own transport. */
export function createImagenMcpServer(engine: ImagenEngine): McpServer {
  const server = new McpServer({ name: 'imagen', version: packageInfo.version }, {
    instructions: 'Image tools submit asynchronous local jobs. Keep this service running, then query imagen_job until completion. All image file and output directory paths must be absolute. Reuse requestId only for the same request. An unknown outcome must be recovered before resubmitting.',
  });
  server.registerTool('imagen_generate', {
    title: 'Generate images',
    description: 'Submit an image generation job using a configured API profile. Returns jobId promptly; query imagen_job for output files. Uses provider credentials from local configuration.',
    inputSchema: submissionSchema.omit({ targetImage: true, mask: true }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, input => safely(async () => result(await engine.submit({ ...input, operation: 'generate' }))));
  server.registerTool('imagen_edit', {
    title: 'Edit an image',
    description: 'Submit an edit to targetImage, with optional references and mask when supported by the selected profile. Returns jobId promptly; query imagen_job for output files.',
    inputSchema: submissionSchema.extend({ targetImage: imageRequestSchema.shape.targetImage.unwrap() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, input => safely(async () => result(await engine.submit({ ...input, operation: 'edit' }))));
  server.registerTool('imagen_job', {
    title: 'Query image job',
    description: 'Read an image job and its absolute output paths. Optional preview returns only the first verified artifact when it is at most 1 MiB; it does not resize large images.',
    inputSchema: jobInputSchema.extend({ preview: z.boolean().default(false) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ jobId, preview }) => safely(async () => {
    const job = await engine.get(jobId);
    return result(job, preview ? await previewContent(job) : []);
  }));
  server.registerTool('imagen_cancel', {
    title: 'Cancel image job',
    description: 'Cancel local work on a submitted job. The provider may already have processed the request; cancellation cannot undo completed generation.',
    inputSchema: jobInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ jobId }) => safely(async () => result(await engine.cancel(jobId))));
  server.registerTool('imagen_capabilities', {
    title: 'List image profiles and capabilities',
    description: 'List configured profiles and their image capabilities without exposing credentials or calling providers. Works before provider authentication is configured.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safely(async () => result(await engine.capabilities())));
  server.registerTool('imagen_recover', {
    title: 'Recover image job',
    description: 'Recover a stored result or recheck the status of an interrupted job. Never resubmits image generation. Use before considering another request after an unknown outcome.',
    inputSchema: jobInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, ({ jobId }) => safely(async () => result(await engine.recover(jobId))));
  return server;
}

/** Serve both current and legacy MCP stdio clients without writing logs to stdout. */
export async function runMcp(paths: RuntimePaths): Promise<void> {
  const engine = await createEngine(paths);
  const transport = new StdioServerTransport();
  const handle = serveStdio(() => createImagenMcpServer(engine), {
    transport,
    onerror: () => process.stderr.write('imagen: MCP transport error.\n'),
  });
  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      process.off('SIGINT', close);
      process.off('SIGTERM', close);
      process.stdin.off('end', close);
      process.stdin.off('close', close);
      Promise.allSettled([handle.close(), engine.close()]).then(results => {
        if (results.some(entry => entry.status === 'rejected')) reject(new Error('MCP shutdown failed.'));
        else resolve();
      });
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    process.stdin.once('end', close);
    process.stdin.once('close', close);
    const transportClose = transport.onclose;
    transport.onclose = () => { transportClose?.(); close(); };
  });
}
