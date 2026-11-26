import assert from 'node:assert/strict';
import { createPageHandler } from '../src/lib/page-handler.js';
import siteConfig from '../src/site-config.js';
import { withFastlyModules } from './helpers/fastly-runtime.js';

const { createFaqListBySku } = await withFastlyModules(
  () => import('../src/blocks/faq-list-by-sku.js'),
);
const faqHandler = createPageHandler(siteConfig.edsHost, [createFaqListBySku()]);

describe('faq-list-by-sku', function () {
  const block =
    '<div class="faq-list-by-sku"><div><div><p>SKU</p></div><div><p>CSM6001</p></div></div></div>';
  const page = `<head></head><main>${block}<p>After the FAQs</p></main>`;
  let originalFetch;
  let calls;
  let originalError;
  let originalWarn;
  let errors;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
    originalError = console.error;
    originalWarn = console.warn;
    errors = [];
    console.error = (...args) => errors.push(args);
    console.warn = (...args) => errors.push(args);
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.warn = originalWarn;
  });

  function mockFetch(items, status = 200) {
    globalThis.fetch = async (url) => {
      calls.push(url);
      return calls.length === 1
        ? new Response(page, { headers: { 'content-type': 'text/html' } })
        : new Response(JSON.stringify({ data: { faqList: { items } } }), { status });
    };
  }

  it('runs the SKU module independently using its own default query and validation', async function () {
    const renderer = createFaqListBySku();
    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: { faqList: { items: [{ question: 'Q?' }] } } }));
    };
    const res = await renderer.dataHandler(
      new Request('https://example.com/blocks/faq-list-by-sku?sku=CSM6001', {
        headers: { origin: 'http://localhost:3000' },
      }),
    );
    assert.deepEqual(await res.json(), { sku: 'CSM6001', items: [{ question: 'Q?' }] });
    assert.deepEqual(calls, [
      'https://publish-p137825-e1511252.adobeaemcloud.com/graphql/execute.json/frescopa/FAQbySKU;sku=CSM6001',
    ]);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
  });

  it('renders every FAQ as nested divs in endpoint order', async function () {
    const items = [
      'Do I have to buy pods?',
      'How long until it learns my taste?',
      'Is it a chore to clean?',
      'Is it a hassle to set up?',
      "What if it isn't for me?",
      'Will it wake the whole house?',
    ].map((question, index) => ({
      question,
      answer: { plaintext: `Answer ${index + 1}` },
      category: 'product',
    }));
    mockFetch(items);

    const response = await faqHandler(new Request('https://example.com/products'));
    const html = await response.text();
    const rows = items
      .map(
        (item) =>
          `<div><div>${item.question.replace(/'/g, '&#39;')}</div><div><p>${item.answer.plaintext}</p></div></div>`,
      )
      .join('');
    const compact = html.replace(/>\s+</g, '><');
    assert.ok(compact.includes(`<main><div class="faq-list-by-sku">${rows}</div><p>After`));
    assert.ok(compact.endsWith('</div><p>After the FAQs</p></main>'));
    assert.doesNotMatch(html, /<details|<summary|data-category/);
    assert.equal(response.headers.get('x-faq-ssr'), '1');
    assert.equal(
      calls[1],
      'https://publish-p137825-e1511252.adobeaemcloud.com/graphql/execute.json/frescopa/FAQbySKU;sku=CSM6001',
    );
    const structuredData = JSON.parse(
      html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
    );
    assert.equal(structuredData.mainEntity.length, items.length);
    assert.equal(structuredData.mainEntity[0].name, items[0].question);
  });

  it('uses site configuration for hosts, queries, block names and cache TTL', async function () {
    const renderer = createFaqListBySku({
      publishHost: 'publish-other.adobeaemcloud.com',
      queryPath: '/graphql/execute.json/other/HelpBySKU',
      listKey: 'helpList',
      className: 'help-by-sku',
      cacheTtl: 60,
    });
    const pageHandler = createPageHandler('main--other--org.aem.live', [renderer]);
    const otherPage =
      '<head></head><main><div class="help-by-sku"><div><div><p>SKU</p></div><div><p>ABC1</p></div></div></div></main>';
    globalThis.fetch = async (url) => {
      calls.push(url);
      return calls.length === 1
        ? new Response(otherPage, { headers: { 'content-type': 'text/html' } })
        : new Response(
            JSON.stringify({
              data: { helpList: { items: [{ question: 'Q?', answer: { plaintext: 'A.' } }] } },
            }),
          );
    };
    const response = await pageHandler(new Request('https://example.com/p'));
    const html = (await response.text()).replace(/>\s+</g, '><');
    assert.equal(calls[0], 'https://main--other--org.aem.live/p');
    assert.equal(
      calls[1],
      'https://publish-other.adobeaemcloud.com/graphql/execute.json/other/HelpBySKU;sku=ABC1',
    );
    assert.ok(
      html.includes('<div class="help-by-sku"><div><div>Q?</div><div><p>A.</p></div></div></div>'),
    );
    assert.equal(response.headers.get('x-faq-ssr'), '1');

    calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: { helpList: { items: [] } } }));
    };
    const data = await renderer.dataHandler(
      new Request('https://example.com/blocks/faq-list-by-sku?sku=ABC1'),
    );
    assert.equal(data.headers.get('cache-control'), 'public, max-age=60');
  });

  it('escapes FAQ text and safely renders a missing plaintext answer', async function () {
    mockFetch([
      { question: '<script>"Q" & \'A\'</script>', answer: { plaintext: '<b>Answer & more</b>' } },
      { question: 'Missing answer' },
    ]);
    const response = await faqHandler(new Request('https://example.com/products'));
    const html = (await response.text()).replace(/>\s+</g, '><');

    assert.ok(
      html.includes(
        '<div><div>&lt;script&gt;&quot;Q&quot; &amp; &#39;A&#39;&lt;/script&gt;</div><div><p>&lt;b&gt;Answer &amp; more&lt;/b&gt;</p></div></div>',
      ),
    );
    assert.ok(html.includes('<div><div>Missing answer</div><div><p></p></div></div>'));
    assert.ok(html.includes('\\u003cscript>'));
  });

  it('preserves the original block when the query fails', async function () {
    mockFetch([], 503);
    const response = await faqHandler(new Request('https://example.com/products'));

    assert.equal(await response.text(), page);
    assert.equal(response.headers.get('x-faq-ssr'), '0');
  });

  it('returns uncached 502 responses for upstream failures instead of caching empty success', async function () {
    const renderer = createFaqListBySku();
    const failures = [
      () => new Response('{}', { status: 503 }),
      () =>
        new Response(
          JSON.stringify({
            errors: [{ message: 'Query failed' }],
            data: { faqList: { items: [] } },
          }),
        ),
      () => new Response(JSON.stringify({ data: { faqList: { items: [null] } } })),
      () => new Response('not JSON'),
      () => {
        throw new Error('Network failure');
      },
    ];
    for (const fail of failures) {
      globalThis.fetch = async () => fail();
      const res = await renderer.dataHandler(
        new Request('https://example.com/blocks/faq-list-by-sku?sku=ABC1'),
      );
      assert.equal(res.status, 502);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), { error: 'FAQ content unavailable' });
    }
    assert.equal(errors.length, failures.length);
  });

  it('distinguishes no matching FAQs from invalid input', async function () {
    const renderer = createFaqListBySku();
    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: { faqList: { items: [] } } }));
    };
    const empty = await renderer.dataHandler(
      new Request('https://example.com/blocks/faq-list-by-sku?sku=ABC1'),
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { sku: 'ABC1', items: [] });
    const invalid = await renderer.dataHandler(
      new Request('https://example.com/blocks/faq-list-by-sku?sku=invalid!'),
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get('cache-control'), 'no-store');
    assert.equal(calls.length, 1);
    assert.equal(errors.length, 1);
  });
});
