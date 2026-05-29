/**
 * api-types.ts
 * Frozen API contract for the webtracker-agent backend.
 * All request/response shapes are defined here so the frontend
 * can be built against a stable interface from Week 3 onward.
 */

import type {
  SafeAppConfig,
  SafeLlmProviderConfig,
  LlmProviderId,
  BrowserConfig,
} from './config.js';
import type { AnalysisResult } from './analyzer.js';

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    /** Machine-readable error code (e.g. "VALIDATION_ERROR", "NOT_CONFIGURED"). */
    code: string;
    /** Human-readable description. */
    message: string;
    /** Optional structured detail (e.g. validation errors array). */
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

export type GetConfigResponse = SafeAppConfig;

// ---------------------------------------------------------------------------
// PUT /api/config
// ---------------------------------------------------------------------------

export interface PutConfigRequest {
  target?: {
    url?: string;
    selector?: string;
  };
  schedule?: {
    intervalMs?: number;
    runOnce?: boolean;
  };
  browser?: Partial<BrowserConfig>;
  notifications?: {
    discordWebhookUrl?: string;
  };
}

export type PutConfigResponse = SafeAppConfig;

// ---------------------------------------------------------------------------
// GET /api/llm/providers
// ---------------------------------------------------------------------------

export type GetProvidersResponse = SafeLlmProviderConfig[];

// ---------------------------------------------------------------------------
// PUT /api/llm/providers
// ---------------------------------------------------------------------------

export interface ProviderUpdate {
  id: LlmProviderId;
  enabled?: boolean;
  priority?: number;
  model?: string;
  /** Provide to set/rotate the key. Omit to leave the existing key unchanged. */
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface PutProvidersRequest {
  providers: ProviderUpdate[];
}

export type PutProvidersResponse = SafeLlmProviderConfig[];

// ---------------------------------------------------------------------------
// POST /api/llm/providers/test
// ---------------------------------------------------------------------------

export interface TestProviderRequest {
  providerId: LlmProviderId;
  /** URL context passed to the LLM prompt (can be a dummy value for testing). */
  url?: string;
  /** Previous content snippet for the diff analysis (optional). */
  sampleOld?: string;
  /** Current content snippet for the diff analysis (optional). */
  sampleNew?: string;
}

export interface TestProviderResponse {
  providerId: LlmProviderId;
  model: string;
  success: boolean;
  /** Wall-clock time for the provider call in milliseconds. */
  latencyMs: number;
  result?: AnalysisResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// GET /api/llm/providers/models
// ---------------------------------------------------------------------------

export interface ProviderModels {
  providerId: LlmProviderId;
  models: string[];
  defaultModel: string;
}

export type GetModelsResponse = ProviderModels[];

// ---------------------------------------------------------------------------
// POST /api/monitor/start
// ---------------------------------------------------------------------------

export interface StartMonitorRequest {
  /** Override runOnce for this session only. */
  runOnce?: boolean;
}

export interface StartMonitorResponse {
  started: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// POST /api/monitor/stop
// ---------------------------------------------------------------------------

export interface StopMonitorResponse {
  stopped: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// GET /api/monitor/status
// ---------------------------------------------------------------------------

export interface LastCheckResult {
  changed: boolean;
  summary: string;
  /** Which LLM provider produced the result, or "local" for fallback. */
  provider: string;
  model?: string;
  latencyMs?: number;
  fallback: boolean;
}

export interface MonitorError {
  timestamp: string;
  message: string;
}

export interface MonitorStatus {
  running: boolean;
  /** ISO-8601 timestamp of the last completed check. */
  lastCheck?: string;
  lastResult?: LastCheckResult;
  /** ISO-8601 timestamp when the next check is scheduled. */
  nextCheck?: string;
  targetUrl?: string;
  /** Up to 20 most-recent errors. */
  errors: MonitorError[];
}

// ---------------------------------------------------------------------------
// POST /api/validate/scrape
// ---------------------------------------------------------------------------

export interface ValidateScrapeRequest {
  url: string;
  selector?: string;
}

export interface ValidateScrapeResponse {
  success: boolean;
  /** Byte length of the extracted text. */
  contentLength?: number;
  /** First 500 chars of extracted text for preview. */
  snippet?: string;
  error?: string;
  /** Wall-clock time for the scrape in milliseconds. */
  latencyMs: number;
}
