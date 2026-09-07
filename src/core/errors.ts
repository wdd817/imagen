import type { PublicError } from './types.js';

export class ImagenError extends Error {
  constructor(public code: string, message: string, public outcomeUnknown = false, public providerRequestId?: string) {
    super(message);
    this.name = 'ImagenError';
  }
}
export function publicError(error: unknown): PublicError {
  if (error instanceof ImagenError) return { code: error.code, message: error.message, outcomeUnknown: error.outcomeUnknown, ...(error.providerRequestId ? { providerRequestId: error.providerRequestId } : {}) };
  // Never return provider response bodies, authentication errors or credentials verbatim.
  return { code: 'INTERNAL_ERROR', message: 'The operation failed. Check the local configuration and try the documented recovery steps.' };
}
