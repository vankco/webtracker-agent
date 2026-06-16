import type { Page } from 'playwright';
import type { HistoryEntry } from './state.js';

export interface PluginDiff {
  hasChanges: boolean;
  summary: string;
  alertBody: string;
  /** If true, the monitor will also run LLM analysis and append its summary. */
  requestLlmFallback?: boolean;
}

export interface ExtractOptions {
  /**
   * Product detail URLs to treat as the source of truth for availability.
   * The plugin re-checks each and overrides listing-page availability.
   */
  productWatchUrls?: string[];
}

export interface SitePlugin {
  name: string;
  matches(url: string): boolean;
  extractProducts(page: Page, options?: ExtractOptions): Promise<unknown[]>;
  productsToText(products: unknown[]): string;
  parseProductLine(line: string): unknown;
  filterAvailable(products: unknown[]): unknown[];
  diff(oldProducts: unknown[], newProducts: unknown[]): PluginDiff;
  formatBaselineMessage(available: unknown[]): string;
  /** Render history entries as text for LLM prediction. Optional. */
  formatHistoryForPrediction?(history: HistoryEntry[]): string;
}
