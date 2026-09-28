import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGIONS,
  appliesToRegion,
  guessRegion,
  hasObjectionRight,
  isRegionCode,
  regionLabel,
} from '../../extension/lib/region.js';
import { REGISTRY_REGIONS } from '../../extension/lib/registry-validate.js';

describe('region codes', () => {
  test('REGIONS match the registry schema regions (minus ALL)', () => {
    assert.deepEqual(REGIONS.map((r) => r.code).sort(), REGISTRY_REGIONS.filter((r) => r !== 'ALL').sort());
    assert.ok(Object.isFrozen(REGIONS));
  });

  test('isRegionCode / regionLabel', () => {
    assert.equal(isRegionCode('EU'), true);
    assert.equal(isRegionCode('US-CA'), true);
    assert.equal(isRegionCode('ALL'), false);
    assert.equal(isRegionCode('eu'), false);
    assert.equal(isRegionCode(undefined), false);
    assert.equal(regionLabel('UK'), 'United Kingdom');
    assert.equal(regionLabel('XX'), 'Somewhere else');
  });
});

describe('appliesToRegion', () => {
  test('ALL applies everywhere; exact matches apply', () => {
    assert.equal(appliesToRegion(['ALL'], 'JP'), true);
    assert.equal(appliesToRegion(['EU', 'UK'], 'UK'), true);
    assert.equal(appliesToRegion(['EU'], 'UK'), false);
  });

  test('California residents also get US-wide opt-outs, not vice versa', () => {
    assert.equal(appliesToRegion(['US'], 'US-CA'), true);
    assert.equal(appliesToRegion(['US-CA'], 'US'), false);
  });

  test('empty or invalid lists apply nowhere', () => {
    assert.equal(appliesToRegion([], 'EU'), false);
    assert.equal(appliesToRegion(undefined, 'EU'), false);
    assert.equal(appliesToRegion('ALL', 'EU'), false);
  });
});

describe('hasObjectionRight', () => {
  test('GDPR-style regions only', () => {
    for (const r of ['EU', 'UK', 'CH']) assert.equal(hasObjectionRight(r), true, r);
    for (const r of ['US', 'US-CA', 'CA', 'AU', 'BR', 'IN', 'JP', 'OTHER'])
      assert.equal(hasObjectionRight(r), false, r);
  });
});

describe('guessRegion', () => {
  const cases = {
    'Europe/Berlin': 'EU',
    'Europe/Paris': 'EU',
    'Atlantic/Canary': 'EU',
    'Europe/London': 'UK',
    'Europe/Belfast': 'UK',
    'Europe/Zurich': 'CH',
    'Europe/Moscow': 'OTHER',
    'Europe/Istanbul': 'OTHER',
    'Europe/Kyiv': 'OTHER',
    'America/Los_Angeles': 'US-CA',
    'America/New_York': 'US',
    'America/Indiana/Indianapolis': 'US',
    'Pacific/Honolulu': 'US',
    'America/Toronto': 'CA',
    'America/Vancouver': 'CA',
    'Australia/Sydney': 'AU',
    'America/Sao_Paulo': 'BR',
    'Asia/Kolkata': 'IN',
    'Asia/Calcutta': 'IN',
    'Asia/Tokyo': 'JP',
    'Asia/Singapore': 'OTHER',
    'America/Mexico_City': 'OTHER',
    '': 'OTHER',
  };
  for (const [tz, expected] of Object.entries(cases)) {
    test(`${tz || '(empty)'} → ${expected}`, () => {
      assert.equal(guessRegion(tz), expected);
    });
  }

  test('without an argument it uses the runtime time zone and returns a valid code', () => {
    assert.ok(isRegionCode(guessRegion()));
  });
});
