/**
 * API contract types — kept in sync with src/api-types.ts on the backend.
 * Copied here so the client workspace is self-contained.
 */

export type LlmProviderId = 'gemini' | 'groq';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SafeLlmProviderConfig {
  id: LlmProviderId;
  enabled: boolean;
  priority: number;
  model: string;
  apiKeyConfigured: boolean;
  timeoutMs: number;
  maxRetries: number;
}

export interface SafeAppConfig {
  target: { url: string; selector: string };
  schedule: { intervalMs: number; runOnce: boolean };
  browser: {
    manualAssisted: boolean;
    manualAssistedInitialWaitMs: number;
    persistSession: boolean;
    headless: boolean;
    slowMoMs: number;
    keepOpenMs: number;
    gotoTimeoutMs: number;
    userDataDir: string;
  };
  notifications: { discordWebhookUrl: string; discordSystemWebhookUrl: string };
  llmProviders: SafeLlmProviderConfig[];
}

export type GetConfigResponse = SafeAppConfig;
export type PutConfigResponse = SafeAppConfig;

export interface PutConfigRequest {
  target?: { url?: string; selector?: string };
  schedule?: { intervalMs?: number; runOnce?: boolean };
  browser?: Partial<SafeAppConfig['browser']>;
  notifications?: { discordWebhookUrl?: string; discordSystemWebhookUrl?: string };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export type GetProvidersResponse = SafeLlmProviderConfig[];
export type PutProvidersResponse = SafeLlmProviderConfig[];

export interface ProviderUpdate {
  id: LlmProviderId;
  enabled?: boolean;
  priority?: number;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface PutProvidersRequest {
  providers: ProviderUpdate[];
}

export interface ModelEntry {
  id: string;
  tier: 'free' | 'paid';
}

export interface ProviderModels {
  providerId: LlmProviderId;
  models: ModelEntry[];
  defaultModel: string;
}

export type GetModelsResponse = ProviderModels[];

export interface TestProviderRequest {
  providerId: LlmProviderId;
  url?: string;
  sampleOld?: string;
  sampleNew?: string;
}

export interface AnalysisResult {
  changed: boolean;
  summary: string;
}

export interface TestProviderResponse {
  providerId: LlmProviderId;
  model: string;
  success: boolean;
  latencyMs: number;
  result?: AnalysisResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export interface LastCheckResult {
  changed: boolean;
  summary: string;
  provider: string;
  model?: string;
  latencyMs?: number;
  fallback: boolean;
}

export interface MonitorError {
  timestamp: string;
  message: string;
}

// ---------------------------------------------------------------------------
// GET /api/logs
// ---------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'error';
export type LogCategory = 'scrape' | 'llm' | 'monitor' | 'config' | 'system';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  details?: Record<string, unknown>;
}

export type GetLogsResponse = LogEntry[];

export interface ContentSnapshot {
  fetchedAt: string;
  preview: string;
  contentLength: number;
}

export interface MonitorStatus {
  running: boolean;
  lastCheck?: string;
  lastResult?: LastCheckResult;
  nextCheck?: string;
  targetUrl?: string;
  errors: MonitorError[];
  recentSnapshots: ContentSnapshot[];
}

export interface StartMonitorRequest {
  runOnce?: boolean;
}

export interface StartMonitorResponse {
  started: boolean;
  message: string;
}

export interface StopMonitorResponse {
  stopped: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export interface ValidateScrapeRequest {
  url: string;
  selector?: string;
}

export interface ValidateScrapeResponse {
  success: boolean;
  contentLength?: number;
  snippet?: string;
  error?: string;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Predict
// ---------------------------------------------------------------------------

export interface PredictionResult {
  generatedAt: string;
  provider: string;
  model?: string;
  summary: string;
  insights: string[];
  historyEntryCount: number;
}
