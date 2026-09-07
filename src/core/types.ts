export type Capability = 'supported' | 'unsupported' | 'unknown';
export type Protocol = 'images' | 'responses' | 'gemini' | 'imagen';
export interface Profile {
  protocol: Protocol;
  platform?: 'developer' | 'vertex';
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  project?: string;
  location?: string;
  auth: { kind: 'apiKey'; credential: string } | { kind: 'googleCredentials'; file: string };
  capabilities: { generate: Capability; edit: Capability; references: Capability; mask: Capability };
  evidence: string;
  maxCount: number;
  maxInputImages: number;
  responsesMode?: 'tool' | 'direct';
  imageModel?: string;
}
export interface ImagenConfig {
  schemaVersion: 1;
  defaultProfile?: string;
  profiles: Record<string, Profile>;
}
export interface ImageRequest {
  requestId: string;
  operation: 'generate' | 'edit';
  prompt: string;
  profile: string;
  targetImage?: string;
  referenceImages: string[];
  mask?: string;
  outputDir: string;
  count: number;
  timeoutMs: number;
  providerOptions: Record<string, unknown>;
}
export type ResolvedAuth = { kind: 'apiKey'; apiKey: string } | { kind: 'googleCredentials'; file: string };
export interface AdapterContext {
  auth: ResolvedAuth;
  signal: AbortSignal;
}
export interface AdapterImage {
  base64?: string;
  url?: string;
  mimeType?: string;
}
export interface AdapterResult {
  images: AdapterImage[];
  text?: string;
  providerRequestId?: string;
  usage?: Record<string, unknown>;
  warnings?: string[];
}
export type ImageAdapter = (request: ImageRequest, profile: Profile, context: AdapterContext) => Promise<AdapterResult>;
export interface Artifact {
  path: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export interface PublicError {
  code: string;
  message: string;
  outcomeUnknown?: boolean;
  providerRequestId?: string;
}
export interface JobRecord {
  schemaVersion: 1;
  jobId: string;
  requestId: string;
  requestHash: string;
  profile: string;
  model: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  outputDir: string;
  images: Artifact[];
  text?: string;
  providerRequestId?: string;
  usage?: Record<string, unknown>;
  warnings: string[];
  error?: PublicError;
}
export interface RuntimePaths { dataDir: string; configPath: string; credentialsPath: string }
