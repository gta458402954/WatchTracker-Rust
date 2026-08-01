import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  aggregateRegions,
  compareRegionOptions,
  normalizeCountryCodes,
  regionCodesOf,
  regionsOf,
} from '../classification.ts';
import {
  PREFERRED_COUNTRY_CODES,
  UNKNOWN_REGION_CODE,
  countryCodeOfLabel,
  countryLabelOf,
} from '../countryNames.ts';

describe('country-code normalization (FR-01)', () => {
  test('trims, uppercases, splits both comma forms, deduplicates, and retains valid fallback codes', () => {
    assert.deepEqual(normalizeCountryCodes(' fr, DE，fr, XX '), ['FR', 'DE', 'XX']);
  });

  test('filters placeholders and malformed values before accepting two-letter codes', () => {
    assert.deepEqual(normalizeCountryCodes('N/A, NA, NULL, UNKNOWN, 123, U1, ---'), []);
  });

  test('maps UK to GB before generic two-letter validation', () => {
    assert.deepEqual(normalizeCountryCodes('uk, GB, UK'), ['GB']);
  });

  test('keeps CN, HK, and TW distinct and recognizes legacy Chinese labels', () => {
    assert.deepEqual(normalizeCountryCodes('中国大陆, 香港, TW'), ['CN', 'HK', 'TW']);
    assert.equal(countryCodeOfLabel('英国'), 'GB');
  });
});

describe('region source priority and display (FR-02)', () => {
  test('uses recognizable originCountry values instead of conflicting legacy tags', () => {
    assert.deepEqual(regionCodesOf({ originCountry: 'FR, DE', contentTags: '美国' }), ['FR', 'DE']);
  });

  test('falls back to recognized legacy tags when originCountry has no usable value', () => {
    assert.deepEqual(regionCodesOf({ originCountry: 'N/A', contentTags: '美国, 悬疑, 美国' }), ['US']);
  });

  test('returns one non-ISO unknown sentinel when neither source is recognizable', () => {
    assert.deepEqual(regionCodesOf({ originCountry: '', contentTags: '悬疑, AI' }), [UNKNOWN_REGION_CODE]);
    assert.equal(countryLabelOf(UNKNOWN_REGION_CODE), '未知地区');
  });

  test('displays unmapped valid codes as their uppercase code', () => {
    assert.deepEqual(regionCodesOf({ originCountry: 'xx', contentTags: null }), ['XX']);
    assert.equal(countryLabelOf('XX'), 'XX');
  });

  test('keeps the existing fixed Chinese buttons working through a thin compatibility wrapper', () => {
    assert.deepEqual(regionsOf({ originCountry: 'US', contentTags: null }), ['美国']);
    assert.deepEqual(regionsOf({ originCountry: 'FR', contentTags: '美国' }), []);
  });
});

describe('region aggregation and stable ordering (FR-04)', () => {
  test('counts each record once per region while allowing multi-country contribution', () => {
    const options = aggregateRegions([
      { originCountry: 'FR, DE, FR', contentTags: null },
      { originCountry: 'FR', contentTags: null },
    ]);

    assert.deepEqual(options, [
      { code: 'FR', label: '法国', count: 2 },
      { code: 'DE', label: '德国', count: 1 },
    ]);
  });

  test('uses the exact preferred order, then count, and always places unknown last', () => {
    const records = PREFERRED_COUNTRY_CODES.map(code => ({ originCountry: code, contentTags: null }));
    records.push(
      { originCountry: 'IT', contentTags: null },
      { originCountry: 'IT', contentTags: null },
      { originCountry: 'FR', contentTags: null },
      { originCountry: null, contentTags: '悬疑' },
    );

    assert.deepEqual(
      aggregateRegions(records).map(option => option.code),
      ['CN', 'HK', 'TW', 'US', 'JP', 'KR', 'GB', 'IT', 'FR', UNKNOWN_REGION_CODE],
    );
  });

  test('uses country code as the final deterministic tie-break', () => {
    const first = { code: 'XB', label: '同名', count: 1 };
    const second = { code: 'XA', label: '同名', count: 1 };
    assert.ok(compareRegionOptions(first, second) > 0);
    assert.ok(compareRegionOptions(second, first) < 0);
  });
});
