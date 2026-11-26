import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === 'fastly:cache-override') {
            return {
                url: 'data:text/javascript,export class CacheOverride {}',
                shortCircuit: true,
            };
        }
        return nextResolve(specifier, context);
    },
});
let faqHandler;
let faqByPathDataHandler;
try {
    ({ faqHandler, faqByPathDataHandler } = await import('../src/faq.js'));
} finally {
    hooks.deregister();
}

describe('FAQ rendering by path', function () {
    const first = '/content/dam/frescopa/en/faqs/first';
    const second = '/content/dam/frescopa/en/faqs/second';
    const block = `<div class="content-fragment"><div><div><p>${first}</p></div></div><div><div><p>${second}</p></div></div></div>`;
    const page = `<html><head></head><body><main>${block}<p>After FAQs</p></main></body></html>`;
    const items = [
        { _path: second, question: 'Second', answer: { plaintext: 'Answer two' } },
        { _path: '/content/dam/frescopa/en/faqs/unrequested', question: 'Unrequested' },
        { _path: first, question: '<script>"Q" & \'A\'</script>' },
    ];
    let originalFetch;
    let calls;
    let originalError;
    let originalWarn;
    let errors;

    beforeEach(function () {
        originalFetch = globalThis.fetch;
        originalError = console.error;
        originalWarn = console.warn;
        errors = [];
        console.error = (...args) => errors.push(args);
        console.warn = (...args) => errors.push(args);
        calls = [];
    });

    afterEach(function () {
        globalThis.fetch = originalFetch;
        console.error = originalError;
        console.warn = originalWarn;
    });

    function mockFetch(content = page, query = { data: { faqList: { items } } }, status = 200) {
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            if (url.includes('.aem.live')) {
                return new Response(content, {
                    headers: { 'content-type': 'text/html', etag: '"origin"' },
                });
            }
            return new Response(JSON.stringify(query), { status });
        };
    }

    it('sends an exact OR filter and renders all rows in authored order with safe JSON-LD', async function () {
        mockFetch();
        const res = await faqHandler(new Request('https://example.com/products'));
        const html = (await res.text()).replace(/>\s+</g, '><');
        const { query, variables: { filter } } = JSON.parse(calls[1].options.body);
        assert.deepEqual(filter, {
            _path: {
                _logOp: 'OR',
                _expressions: [first, second].map((value) => ({ value, _operator: 'EQUALS' })),
            },
        });
        assert.equal(calls[1].url, 'https://publish-p137825-e1511252.adobeaemcloud.com/content/_cq_graphql/frescopa/endpoint.json');
        assert.equal(calls[1].options.method, 'POST');
        assert.equal(calls[1].options.headers['content-type'], 'application/json');
        assert.match(query, /\$filter: FaqModelFilter/);
        assert.ok(html.includes('<div class="content-fragment" data-faq-ssr="true"><div><div>&lt;script&gt;&quot;Q&quot; &amp; &#39;A&#39;&lt;/script&gt;</div><div><p></p></div></div><div><div>Second</div><div><p>Answer two</p></div></div></div><p>After FAQs</p>'));
        assert.doesNotMatch(html, /Unrequested/);
        assert.ok(html.includes('\\u003cscript>'));
        const data = JSON.parse(html.match(/<head><script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        assert.deepEqual(data.mainEntity.map((item) => item.name), [items[2].question, 'Second']);
        assert.equal(res.headers.get('x-faq-path-ssr'), '1');
        assert.equal(res.headers.get('etag'), null);
    });

    it('handles links, deduplicates paths, and replaces multiple blocks without consuming adjacent content', async function () {
        const linked = `<div class="content-fragment"><div><div><a href="${first}">First FAQ</a></div></div><div><div><a href="${first}">Repeated</a></div></div></div>`;
        mockFetch(`<head></head><main>${linked}<p>Between</p>${block}<p>After</p></main>`);
        const res = await faqHandler(new Request('https://example.com/page'));
        const html = (await res.text()).replace(/>\s+</g, '><');
        assert.equal(res.headers.get('x-faq-path-ssr'), '2');
        assert.ok(html.includes('</div><p>Between</p><div class="content-fragment"'));
        assert.ok(html.endsWith('</div><p>After</p></main>'));
        assert.equal(JSON.parse(calls[1].options.body).variables.filter._path._expressions.length, 1);
    });

    it('scans every page URL and forwards its path and query to EDS', async function () {
        for (const path of ['/', '/products/coffee', '/support/faqs.html?lang=en']) {
            calls = [];
            mockFetch();
            const res = await faqHandler(new Request(`https://example.com${path}`));
            assert.equal(res.headers.get('x-faq-path-ssr'), '1');
            assert.equal(calls[0].url, `https://main--frescopa26--markszulc.aem.live${path}`);
        }
    });

    it('renders independent results for each content-fragment block and preserves wrapper attributes', async function () {
        const firstBlock = `<div id="first" class="content-fragment featured"><div><div><p>${first}</p></div></div></div>`;
        const secondBlock = `<div class='content-fragment'><div><div><p>${second}</p></div></div></div>`;
        mockFetch(`<head></head><main>${firstBlock}<p>Between</p>${secondBlock}</main>`);
        const res = await faqHandler(new Request('https://example.com/any/page'));
        const html = await res.text();
        const [firstResult, secondResult] = html.split('<main>')[1].split('<p>Between</p>');
        assert.ok(firstResult.startsWith('<div id="first" class="content-fragment featured" data-faq-ssr="true">'));
        assert.ok(firstResult.includes('&lt;script&gt;'));
        assert.ok(!firstResult.includes('Answer two'));
        assert.ok(secondResult.includes('Answer two'));
        assert.ok(!secondResult.includes('&lt;script&gt;'));
        assert.deepEqual(calls.slice(1).map((call) =>
            JSON.parse(call.options.body).variables.filter._path._expressions.map(({ value }) => value)
        ), [[first], [second]]);
        assert.equal(res.headers.get('x-faq-path-ssr'), '2');
    });

    it('leaves pages without content-fragment blocks unchanged without path queries', async function () {
        const content = '<head></head><main><div class="other-content-fragment"><div>Leave alone</div></div></main>';
        mockFetch(content);
        const res = await faqHandler(new Request('https://example.com/anywhere'));
        assert.equal(await res.text(), content);
        assert.equal(calls.length, 1);
    });

    it('preserves SKU-only pages and continues to use the original query', async function () {
        const skuBlock = '<div class="faq-list-by-sku"><div><div><p>SKU</p></div><div><p>CSM6001</p></div></div></div>';
        mockFetch(`<head></head><main>${skuBlock}</main>`);
        const res = await faqHandler(new Request('https://example.com/page'));
        assert.ok((await res.text()).includes('class="faq-list-by-sku"'));
        assert.ok(calls[1].url.endsWith('/FAQbySKU;sku=CSM6001'));
        assert.equal(calls.length, 2);
        assert.equal(res.headers.get('x-faq-ssr'), '1');
        assert.equal(res.headers.get('x-faq-path-ssr'), null);
    });

    it('renders SKU and content-fragment blocks on the same page in one pass', async function () {
        const skuBlock = '<div class="faq-list-by-sku"><div><div><p>SKU</p></div><div><p>CSM6001</p></div></div></div>';
        globalThis.fetch = async (url, options) => {
            calls.push({ url, options });
            if (url.includes('.aem.live')) {
                return new Response(`<head></head><main>${skuBlock}<p>Between</p>${block}</main>`, {
                    headers: { 'content-type': 'text/html' },
                });
            }
            const skuItems = [{ question: 'SKU question', answer: { plaintext: 'SKU answer' } }];
            return new Response(JSON.stringify({ data: { faqList: { items: url.includes('FAQbySKU') ? skuItems : items } } }));
        };
        const res = await faqHandler(new Request('https://example.com/page'));
        const html = (await res.text()).replace(/>\s+</g, '><');
        assert.equal(calls.length, 3);
        assert.equal(res.headers.get('x-faq-ssr'), '1');
        assert.equal(res.headers.get('x-faq-path-ssr'), '1');
        assert.ok(html.includes('<div class="faq-list-by-sku"><div><div>SKU question</div><div><p>SKU answer</p></div></div></div><p>Between</p><div class="content-fragment" data-faq-ssr="true"><div><div>&lt;script&gt;'));
        assert.equal(html.match(/application\/ld\+json/g).length, 2);
    });

    it('logs upstream and invalid-block failures and preserves authored content', async function () {
        mockFetch(page, {}, 503);
        const res = await faqHandler(new Request('https://example.com/page'));
        assert.equal(await res.text(), page);
        assert.equal(res.headers.get('x-faq-path-ssr'), '0');
        mockFetch(page.replace(first, '/content/dam/../private'));
        assert.equal(await (await faqHandler(new Request('https://example.com/page'))).text(), page.replace(first, '/content/dam/../private'));
        assert.equal(calls.length, 3);
        assert.equal(errors.length, 2);
    });

    it('provides ordered JSON data and allowlisted CORS for hydration', async function () {
        mockFetch();
        const params = new URLSearchParams([['path', first], ['path', second], ['path', first]]);
        const res = await faqByPathDataHandler(new Request(`https://example.com/faq-data-by-path?${params}`, {
            headers: { origin: 'http://localhost:3000' },
        }));
        assert.deepEqual(await res.json(), { paths: [first, second], items: [items[2], items[0]] });
        assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
        assert.equal(res.headers.get('vary'), 'Origin');
        assert.equal(res.headers.get('cache-control'), 'public, max-age=300');
    });

    it('rejects missing or unsafe paths without fetching or granting untrusted CORS', async function () {
        mockFetch();
        for (const path of ['', '/content/dam/../private', '/content/dam//faq', 'https://example.com/faq', '/content/dam/faq;filter=bad']) {
            const params = new URLSearchParams({ path });
            const res = await faqByPathDataHandler(new Request(`https://example.com/faq-data-by-path?${params}`, {
                headers: { origin: 'https://untrusted.example' },
            }));
            assert.equal(res.status, 400);
            assert.deepEqual(await res.json(), { error: 'invalid paths' });
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.equal(res.headers.get('access-control-allow-origin'), null);
        }
        assert.equal(calls.length, 0);
    });

    it('returns uncached 502 errors for HTTP, GraphQL, malformed JSON, and transport failures', async function () {
        const req = new Request(`https://example.com/faq-data-by-path?${new URLSearchParams({ path: first })}`);
        const failures = [
            () => mockFetch(page, {}, 503),
            () => mockFetch(page, { errors: [{ message: 'Invalid filter' }], data: { faqList: { items: [] } } }),
            () => mockFetch(page, { data: {} }),
            () => { globalThis.fetch = async () => new Response('not JSON'); },
            () => { globalThis.fetch = async () => { throw new Error('Network failure'); }; },
        ];
        for (const fail of failures) {
            fail();
            const res = await faqByPathDataHandler(req);
            assert.equal(res.status, 502);
            assert.equal(res.headers.get('cache-control'), 'no-store');
            assert.deepEqual(await res.json(), { error: 'FAQ content unavailable' });
        }
        assert.equal(errors.length, failures.length);
    });

    it('preserves authored paths when no published fragments match', async function () {
        mockFetch(page, { data: { faqList: { items: [] } } });
        const res = await faqHandler(new Request('https://example.com/page'));
        assert.equal(await res.text(), page);
        assert.equal(res.headers.get('x-faq-path-ssr'), '0');
        assert.equal(res.headers.get('etag'), '"origin"');
        assert.equal(errors.length, 1);
        assert.match(errors[0][0], /No published FAQs matched/);
    });

    it('returns an empty successful result when no requested fragments exist', async function () {
        mockFetch(page, { data: { faqList: { items: [] } } });
        const res = await faqByPathDataHandler(new Request(`https://example.com/faq-data-by-path?${new URLSearchParams({ path: first })}`));
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { paths: [first], items: [] });
    });
});
