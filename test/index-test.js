import assert from 'node:assert/strict';
import { withFastlyModules } from './helpers/fastly-runtime.js';
import { setLocation } from './helpers/geolocation.js';

let onFetch;
const originalListener = globalThis.addEventListener;
globalThis.addEventListener = (type, listener) => {
  assert.equal(type, 'fetch');
  onFetch = listener;
};
try {
  await withFastlyModules(() => import('../src/index.js'));
} finally {
  if (originalListener) globalThis.addEventListener = originalListener;
  else delete globalThis.addEventListener;
}

describe('index request routing', function () {
  let originalFetch;
  let originalLog;
  let records;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    originalLog = console.log;
    records = [];
    console.log = (record) => records.push(record);
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });

  function dispatch(path) {
    let response;
    onFetch({
      request: new Request(`https://example.com${path}`),
      client: { address: '127.0.0.1' },
      respondWith(promise) {
        response = promise;
      },
    });
    return response;
  }

  it('keeps the hello-world example route and logs its response', async function () {
    globalThis.fetch = async () => {
      assert.fail('Hello world requires no upstream fetch');
    };
    const res = await dispatch('/hello-world');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Hello World/);
    assert.deepEqual(JSON.parse(records[0]), { method: 'GET', path: '/hello-world', status: 200 });
  });

  it('routes weather to the standalone service', async function () {
    setLocation({ city: 'Example city', latitude: 0, longitude: 10 });
    globalThis.fetch = async () => new Response(JSON.stringify({ current: { temperature_2m: 0 } }));
    const res = await dispatch('/weather');
    assert.match(await res.text(), /temperature is 0\u00b0C/);
    assert.equal(JSON.parse(records.at(-1)).path, '/weather');
  });

  it('routes block-named endpoints to their JSON handlers with unchanged response shapes', async function () {
    const items = [{ _path: '/content/dam/faq', question: 'Q?', answer: { plaintext: 'A.' } }];
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      assert.ok(url.includes('.adobeaemcloud.com'), 'JSON routes must not fetch an EDS page');
      return new Response(JSON.stringify({ data: { faqList: { items } } }));
    };
    const sku = await dispatch('/blocks/faq-list-by-sku?sku=ABC1');
    assert.equal(sku.status, 200);
    assert.deepEqual(await sku.json(), { sku: 'ABC1', items });
    const fragment = await dispatch('/blocks/content-fragment?path=/content/dam/faq');
    assert.equal(fragment.status, 200);
    assert.deepEqual(await fragment.json(), { paths: ['/content/dam/faq'], items });
    assert.equal(calls.length, 2);
  });

  it('does not retain the old FAQ endpoint aliases', async function () {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response('Origin page not found', { status: 404 });
    };
    for (const path of ['/faq-data?sku=ABC1', '/faq-data-by-path?path=/content/dam/faq']) {
      const res = await dispatch(path);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), 'Origin page not found');
      assert.equal(calls.at(-1), `https://main--frescopa26--markszulc.aem.live${path}`);
    }
  });

  it('returns the common 500 response when the page origin fails', async function () {
    globalThis.fetch = async () => {
      throw new Error('Origin unavailable');
    };
    const res = await dispatch('/page');
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'Internal Server Error');
    assert.equal(JSON.parse(records.at(-1)).status, 500);
  });
});
