import { describe, it, expect } from 'vitest';
import { buildAskPrompt, QA_SYSTEM_PROMPT } from '../bot-qa.js';

describe('buildAskPrompt', () => {
  it('includes the target URL', () => {
    const prompt = buildAskPrompt('https://example.com', 'products', 'history', 'what is in stock?');
    expect(prompt).toContain('https://example.com');
  });

  it('includes current products text', () => {
    const prompt = buildAskPrompt('https://example.com', 'Bag A - $3000', '', 'any bags?');
    expect(prompt).toContain('Bag A - $3000');
  });

  it('includes history text', () => {
    const prompt = buildAskPrompt('https://example.com', '', '2026-01-01: 3 available', 'trends?');
    expect(prompt).toContain('2026-01-01: 3 available');
  });

  it('includes the question', () => {
    const prompt = buildAskPrompt('https://example.com', '', '', 'which bag sells out fastest?');
    expect(prompt).toContain('which bag sells out fastest?');
  });

  it('uses fallback text when products or history are empty', () => {
    const prompt = buildAskPrompt('https://example.com', '', '', 'any stock?');
    expect(prompt).toContain('no current product data');
    expect(prompt).toContain('no history available');
  });
});

describe('QA_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof QA_SYSTEM_PROMPT).toBe('string');
    expect(QA_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
