import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Fastly's runtime module is not available in Node.
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
try {
    ({ faqHandler } = await import('../src/faq.js'));
} finally {
    hooks.deregister();
}

describe('FAQ rendering', function () {
    const block = '<div class="faq-list-by-sku"><div><div><p>SKU</p></div><div><p>CSM6001</p></div></div></div>';
    const page = `<main>${block}<p>After the FAQs</p></main>`;
    let originalFetch;
    let calls;

    beforeEach(function () {
        originalFetch = globalThis.fetch;
        calls = [];
    });

    afterEach(function () {
        globalThis.fetch = originalFetch;
    });

    function mockFetch(items, status = 200) {
        globalThis.fetch = async (url) => {
            calls.push(url);
            return calls.length === 1
                ? new Response(page, { headers: { 'content-type': 'text/html' } })
                : new Response(JSON.stringify({ data: { faqList: { items } } }), { status });
        };
    }

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
        const rows = items.map((item) =>
            `<div><div>${item.question.replace(/'/g, '&#39;')}</div><div>${item.answer.plaintext}</div></div>`
        ).join('');
        const compact = html.replace(/>\s+</g, '><');
        assert.ok(compact.includes(`data-sku="CSM6001">${rows}<script`));
        assert.ok(compact.endsWith('</div><p>After the FAQs</p></main>'));
        assert.doesNotMatch(html, /<details|<summary|data-category/);
        assert.equal(response.headers.get('x-faq-ssr'), '1');
        assert.equal(calls[1], 'https://publish-p137825-e1511252.adobeaemcloud.com/graphql/execute.json/frescopa/FAQbySKU;sku=CSM6001');
        const structuredData = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
        assert.equal(structuredData.mainEntity.length, items.length);
        assert.equal(structuredData.mainEntity[0].name, items[0].question);
    });

    it('escapes FAQ text and safely renders a missing plaintext answer', async function () {
        mockFetch([
            { question: '<script>"Q" & \'A\'</script>', answer: { plaintext: '<b>Answer & more</b>' } },
            { question: 'Missing answer' },
        ]);
        const response = await faqHandler(new Request('https://example.com/products'));
        const html = (await response.text()).replace(/>\s+</g, '><');

        assert.ok(html.includes('<div><div>&lt;script&gt;&quot;Q&quot; &amp; &#39;A&#39;&lt;/script&gt;</div><div>&lt;b&gt;Answer &amp; more&lt;/b&gt;</div></div>'));
        assert.ok(html.includes('<div><div>Missing answer</div><div></div></div>'));
        assert.ok(html.includes('\\u003cscript>'));
    });

    it('preserves the original block when the query fails', async function () {
        mockFetch([], 503);
        const response = await faqHandler(new Request('https://example.com/products'));

        assert.equal(await response.text(), page);
        assert.equal(response.headers.get('x-faq-ssr'), '0');
    });
});
