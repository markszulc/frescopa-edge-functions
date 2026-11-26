import assert from 'node:assert/strict';
import { withFastlyModules } from './helpers/fastly-runtime.js';
import { setLocation, lookups } from './helpers/geolocation.js';

const { weatherHandler } = await withFastlyModules(() => import('../src/services/weather.js'));

describe('weather', function () {
  let originalFetch;
  let originalError;
  let originalWarn;
  let errors;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    originalError = console.error;
    originalWarn = console.warn;
    errors = [];
    calls = [];
    console.error = (...args) => errors.push(args);
    console.warn = (...args) => errors.push(args);
    setLocation({ city: 'Example city', latitude: 0, longitude: 10 });
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.warn = originalWarn;
  });

  it('uses the CDN IP cache key and renders zero degrees without an API token', async function () {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ current: { temperature_2m: 0 } }));
    };
    const res = await weatherHandler(new Request('https://example.com/weather?ip=203.0.113.10'), {
      address: '203.0.113.20',
    });
    assert.deepEqual(lookups, ['203.0.113.10']);
    const url = new URL(calls[0].url);
    assert.equal(url.hostname, 'api.open-meteo.com');
    assert.equal(url.searchParams.get('latitude'), '0');
    assert.equal(url.searchParams.get('longitude'), '10');
    assert.equal(new Headers(calls[0].options?.headers).get('authorization'), null);
    assert.match(await res.text(), /temperature is 0\u00b0C/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
  });

  it('uses the client address locally and preserves the friendly unavailable-location response', async function () {
    setLocation(null);
    globalThis.fetch = async () => {
      assert.fail('No weather fetch without a location');
    };
    const res = await weatherHandler(new Request('https://example.com/weather'), {
      address: '127.0.0.1',
    });
    assert.deepEqual(lookups, ['127.0.0.1']);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'Could not determine your location');
    assert.equal(errors.length, 1);
  });

  it('rejects requests without a client IP before geolocation or fetching', async function () {
    globalThis.fetch = async () => {
      assert.fail('No fetch without a client IP');
    };
    const res = await weatherHandler(new Request('https://example.com/weather'));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(lookups, []);
    assert.equal(errors.length, 1);
  });

  it('reports upstream HTTP, JSON, data and transport failures as uncached 502 responses', async function () {
    const failures = [
      () => new Response('{}', { status: 503 }),
      () => new Response('not JSON'),
      () => new Response(JSON.stringify({ current: {} })),
      () => {
        throw new Error('Network failure');
      },
    ];
    for (const fail of failures) {
      globalThis.fetch = async () => fail();
      const res = await weatherHandler(new Request('https://example.com/weather?ip=203.0.113.10'));
      assert.equal(res.status, 502);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(await res.text(), 'Weather data unavailable');
    }
    assert.equal(errors.length, failures.length);
  });
});
