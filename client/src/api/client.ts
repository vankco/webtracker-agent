/**
 * Typed API client.
 * All requests go through /api — resolved by the Vite dev proxy to
 * http://localhost:3001 in development and served from the same origin in
 * production (when the Express app serves the built client).
 */

import type {
  GetConfigResponse,
  PutConfigRequest,
  PutConfigResponse,
  GetProvidersResponse,
  PutProvidersRequest,
  PutProvidersResponse,
  GetModelsResponse,
  TestProviderRequest,
  TestProviderResponse,
  MultiSiteMonitorStatus,
  SiteConfig,
  CreateSiteRequest,
  UpdateSiteRequest,
  StartMonitorRequest,
  StartMonitorResponse,
  StopMonitorResponse,
  ValidateScrapeRequest,
  ValidateScrapeResponse,
  GetLogsResponse,
} from './types.js';

const BASE = '/api';

// ---------------------------------------------------------------------------
// Core fetch wrapper
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Parse JSON regardless of status so we can surface API error messages
  const json = (await res.json()) as { success: boolean; data?: T; error?: { code: string; message: string; details?: unknown } };

  if (!json.success || json.error) {
    throw new ApiError(
      json.error?.code ?? 'UNKNOWN_ERROR',
      json.error?.message ?? `HTTP ${res.status}`,
      json.error?.details
    );
  }

  return json.data as T;
}

// ---------------------------------------------------------------------------
// Typed endpoint groups
// ---------------------------------------------------------------------------

export const api = {
  config: {
    get: (): Promise<GetConfigResponse> =>
      request('GET', '/config'),

    update: (body: PutConfigRequest): Promise<PutConfigResponse> =>
      request('PUT', '/config', body),
  },

  providers: {
    list: (): Promise<GetProvidersResponse> =>
      request('GET', '/llm/providers'),

    update: (body: PutProvidersRequest): Promise<PutProvidersResponse> =>
      request('PUT', '/llm/providers', body),

    test: (body: TestProviderRequest): Promise<TestProviderResponse> =>
      request('POST', '/llm/providers/test', body),

    models: (): Promise<GetModelsResponse> =>
      request('GET', '/llm/providers/models'),
  },

  monitor: {
    status: (): Promise<MultiSiteMonitorStatus> =>
      request('GET', '/monitor/status'),

    start: (body?: StartMonitorRequest): Promise<StartMonitorResponse> =>
      request('POST', '/monitor/start', body ?? {}),

    stop: (): Promise<StopMonitorResponse> =>
      request('POST', '/monitor/stop'),
  },

  sites: {
    list: (): Promise<SiteConfig[]> =>
      request('GET', '/sites'),

    add: (body: CreateSiteRequest): Promise<SiteConfig> =>
      request('POST', '/sites', body),

    get: (id: string): Promise<SiteConfig> =>
      request('GET', `/sites/${id}`),

    update: (id: string, body: UpdateSiteRequest): Promise<SiteConfig> =>
      request('PUT', `/sites/${id}`, body),

    remove: (id: string): Promise<{ removed: boolean }> =>
      request('DELETE', `/sites/${id}`),
  },

  validate: {
    scrape: (body: ValidateScrapeRequest): Promise<ValidateScrapeResponse> =>
      request('POST', '/validate/scrape', body),
  },

  logs: {
    get: (): Promise<GetLogsResponse> =>
      request('GET', '/logs'),

    clear: (): Promise<{ cleared: boolean }> =>
      request('DELETE', '/logs'),
  },
} as const;
