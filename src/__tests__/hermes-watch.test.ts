import { describe, it, expect } from 'vitest';
import {
  skuFromUrl,
  mergeWatchAvailability,
  filterHermesAvailable,
  type HermesProduct,
  type ProductVerification,
} from '@webtracker/plugin-hermes';

function product(sku: string, available: boolean, url = `/us/en/product/bag-${sku}/`): HermesProduct {
  return { name: `Bag ${sku}`, color: 'Gold', price: '$1,000', sku, available, url };
}

describe('skuFromUrl', () => {
  it('extracts the trailing SKU token from a product URL', () => {
    expect(skuFromUrl('https://www.hermes.com/us/en/product/picotin-lock-18-bag-H056289CKAA/'))
      .toBe('H056289CKAA');
  });

  it('ignores query string and hash', () => {
    expect(skuFromUrl('https://www.hermes.com/us/en/product/kelly-bag-H012345AB?x=1#frag'))
      .toBe('H012345AB');
  });

  it('returns uppercase regardless of input casing', () => {
    expect(skuFromUrl('https://www.hermes.com/us/en/product/bag-h999/')).toBe('H999');
  });

  it('returns empty string when no token is derivable', () => {
    expect(skuFromUrl('')).toBe('');
  });
});

describe('mergeWatchAvailability', () => {
  it('passes through listing products that have no matching watch URL', () => {
    const listing = [product('A', true), product('B', true)];
    const merged = mergeWatchAvailability(listing, []);
    expect(merged).toEqual(listing);
  });

  it('overrides availability when a watch page matches a listing product (ok)', () => {
    const listing = [product('E', true)]; // listing says available
    const verifications: ProductVerification[] = [
      { url: '/us/en/product/bag-E/', sku: 'E', available: false, ok: true }, // page says NO
    ];
    const merged = mergeWatchAvailability(listing, verifications);
    expect(merged.find((p) => p.sku === 'E')?.available).toBe(false);
  });

  it('keeps the listing value when the watch-page check fails (!ok)', () => {
    const listing = [product('E', true)];
    const verifications: ProductVerification[] = [
      { url: '/us/en/product/bag-E/', sku: 'E', available: false, ok: false },
    ];
    const merged = mergeWatchAvailability(listing, verifications);
    expect(merged.find((p) => p.sku === 'E')?.available).toBe(true);
  });

  it('appends a watch-only product not on the listing (ok + available)', () => {
    const listing = [product('A', true)];
    const verifications: ProductVerification[] = [
      { url: '/us/en/product/bag-F/', sku: 'F', available: true, ok: true, product: product('F', true) },
    ];
    const merged = mergeWatchAvailability(listing, verifications);
    expect(merged.map((p) => p.sku)).toEqual(['A', 'F']);
  });

  it('skips a watch-only product when its check fails (!ok)', () => {
    const listing = [product('A', true)];
    const verifications: ProductVerification[] = [
      { url: '/us/en/product/bag-F/', sku: 'F', available: false, ok: false },
    ];
    const merged = mergeWatchAvailability(listing, verifications);
    expect(merged.map((p) => p.sku)).toEqual(['A']);
  });

  it('matches by URL-derived SKU when the listing sku field is blank', () => {
    const listing: HermesProduct[] = [
      { name: 'Bag', color: '', price: '', sku: '', available: true, url: '/us/en/product/bag-Z123/' },
    ];
    const verifications: ProductVerification[] = [
      { url: 'https://www.hermes.com/us/en/product/bag-Z123/', sku: 'Z123', available: false, ok: true },
    ];
    const merged = mergeWatchAvailability(listing, verifications);
    expect(merged[0].available).toBe(false);
  });

  it('canonical example: watch [E,F] over listing A,B,C,D,E -> available A,B,C,D,F', () => {
    const listing = [
      product('A', true),
      product('B', true),
      product('C', true),
      product('D', true),
      product('E', true), // listing over-reports E as available
    ];
    const verifications: ProductVerification[] = [
      { url: '/us/en/product/bag-E/', sku: 'E', available: false, ok: true }, // page: not available
      { url: '/us/en/product/bag-F/', sku: 'F', available: true, ok: true, product: product('F', true) }, // not on listing, page: available
    ];
    const merged = mergeWatchAvailability(listing, verifications);
    const availableSkus = filterHermesAvailable(merged).map((p) => p.sku).sort();
    expect(availableSkus).toEqual(['A', 'B', 'C', 'D', 'F']);
  });
});
