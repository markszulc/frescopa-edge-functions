import assert from 'node:assert/strict';
import { withFastlyModules } from './helpers/fastly-runtime.js';

const { createBlockHandlers } = await withFastlyModules(() => import('../src/block-handlers.js'));

describe('block-handlers', function () {
  let originalFetch;
  let originalError;
  let errors;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    originalError = console.error;
    errors = [];
    calls = [];
    console.error = (...args) => errors.push(args);
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  });

  it('routes block-owned endpoints and keeps configuration overrides isolated', async function () {
    const handlers = createBlockHandlers({
      faqListBySku: { dataPath: '/sku-json', listKey: 'skuList', cacheTtl: 60 },
    });
    globalThis.fetch = async (url) => {
      calls.push(url);
      const items = [{ _path: '/content/dam/faq', question: 'Q?' }];
      return new Response(
        JSON.stringify({
          data: { [url.includes('FAQbySKU') ? 'skuList' : 'faqList']: { items } },
        }),
      );
    };
    const sku = await handlers.handleRequest(new Request('https://example.com/sku-json?sku=ABC1'));
    const path = await handlers.handleRequest(
      new Request('https://example.com/blocks/content-fragment?path=/content/dam/faq'),
    );
    assert.equal(sku.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(path.headers.get('cache-control'), 'public, max-age=300');
    assert.equal((await sku.json()).items.length, 1);
    assert.equal((await path.json()).items.length, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((url) => url.includes('.adobeaemcloud.com')));

    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response('Origin response');
    };
    const post = await handlers.handleRequest(
      new Request('https://example.com/sku-json', { method: 'POST' }),
    );
    assert.equal(await post.text(), 'Origin response');
    assert.equal(calls[2], 'https://main--frescopa26--markszulc.aem.live/sku-json');
  });

  it('renders mixed blocks with one origin fetch and isolates either upstream failure', async function () {
    const skuBlock =
      '<div class="faq-list-by-sku"><div><div>SKU</div><div>CSM6001</div></div></div>';
    const fragmentBlock =
      '<div class="content-fragment"><div><div>/content/dam/faq</div></div></div>';
    const handlers = createBlockHandlers();
    for (const failure of [null, 'sku', 'path']) {
      calls = [];
      globalThis.fetch = async (url) => {
        calls.push(url);
        if (url.includes('.aem.live')) {
          return new Response(
            `<head></head><main>${skuBlock}<p>Between</p>${fragmentBlock}</main>`,
            {
              headers: { 'content-type': 'text/html', etag: '"origin"' },
            },
          );
        }
        const sku = url.includes('FAQbySKU');
        const failed = failure === (sku ? 'sku' : 'path');
        const items = [
          { _path: '/content/dam/faq', question: sku ? 'SKU question' : 'Fragment question' },
        ];
        return new Response(JSON.stringify({ data: { faqList: { items } } }), {
          status: failed ? 503 : 200,
        });
      };
      const res = await handlers.pageHandler(new Request('https://example.com/mixed'));
      const html = await res.text();
      assert.equal(calls.filter((url) => url.includes('.aem.live')).length, 1);
      assert.equal(calls.length, 3);
      assert.equal(res.headers.get('x-faq-ssr'), failure === 'sku' ? '0' : '1');
      assert.equal(res.headers.get('x-faq-path-ssr'), failure === 'path' ? '0' : '1');
      assert.ok(html.includes('<p>Between</p>'));
      assert.equal(html.includes(skuBlock), failure === 'sku');
      assert.equal(html.includes(fragmentBlock), failure === 'path');
      assert.equal((html.match(/application\/ld\+json/g) || []).length, failure ? 1 : 2);
      assert.equal(res.headers.get('etag'), null);
    }
    assert.equal(errors.length, 2);
  });
});
