import type { Page } from 'playwright';

export interface PluginDiff {
  hasChanges: boolean;
  summary: string;
  alertBody: string;
  /** If true, the monitor will also run LLM analysis and append its summary. */
  requestLlmFallback?: boolean;
}

export interface SitePlugin {
  name: string;
  matches(url: string): boolean;
  extractProducts(page: Page): Promise<unknown[]>;
  productsToText(products: unknown[]): string;
  parseProductLine(line: string): unknown;
  filterAvailable(products: unknown[]): unknown[];
  diff(oldProducts: unknown[], newProducts: unknown[]): PluginDiff;
  formatBaselineMessage(available: unknown[]): string;
}
