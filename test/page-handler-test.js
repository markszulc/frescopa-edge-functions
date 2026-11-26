import assert from 'node:assert/strict';
import { createPageHandler } from '../src/lib/page-handler.js';

describe('page-handler', function () {
  let originalFetch;
  let calls;

  beforeEach(function () {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
  });

  it('supports arbitrary block renderers and leaves unsupported content unchanged', async function () {
    const input = '<div class="example-block variant"><div><div>Authored</div></div></div>';
    const untouched = '<div class="unsupported"><div>Keep this</div></div>';
    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response(`<head></head><main>${input}${untouched}</main>`, {
        headers: { 'content-type': 'text/html' },
      });
    };
    const handler = createPageHandler('main--other--org.aem.live', [
      {
        className: 'example-block',
        ssrHeader: 'x-example-ssr',
        async render(block) {
          assert.equal(block.opening, '<div class="example-block variant">');
          assert.equal(block.inner, '<div><div>Authored</div></div>');
          return { block: '<div class="example-block">Rendered</div>' };
        },
      },
    ]);
    const res = await handler(new Request('https://example.com/example?lang=en'));
    assert.equal(
      await res.text(),
      `<head></head><main><div class="example-block">Rendered</div>${untouched}</main>`,
    );
    assert.deepEqual(calls, ['https://main--other--org.aem.live/example?lang=en']);
    assert.equal(res.headers.get('x-example-ssr'), '1');
  });

  it('forwards every page path and query without fetching block data when there is no match', async function () {
    const content =
      '<head></head><main><div class="other-example"><div>Leave alone</div></div></main>';
    const handler = createPageHandler('main--other--org.aem.live', [
      {
        className: 'example',
        ssrHeader: 'x-example-ssr',
        render() {
          assert.fail('Unsupported blocks must not be rendered');
        },
      },
    ]);
    globalThis.fetch = async (url) => {
      calls.push(url);
      return new Response(content, { headers: { 'content-type': 'text/html', etag: '"origin"' } });
    };
    for (const path of ['/', '/products/coffee', '/support/faqs.html?lang=en']) {
      const res = await handler(new Request(`https://example.com${path}`));
      assert.equal(await res.text(), content);
      assert.equal(res.headers.get('x-example-ssr'), null);
      assert.equal(res.headers.get('etag'), '"origin"');
      assert.equal(calls.at(-1), `https://main--other--org.aem.live${path}`);
    }
    assert.equal(calls.length, 3);
  });

  it('does not rewrite errors, non-HTML responses, non-GET requests or unsupported encodings', async function () {
    const handler = createPageHandler('main--other--org.aem.live', [
      {
        className: 'example',
        ssrHeader: 'x-example-ssr',
        render() {
          assert.fail('Pass-through responses must not be rendered');
        },
      },
    ]);
    for (const [method, status, type, encoding] of [
      ['GET', 404, 'text/html', 'identity'],
      ['GET', 200, 'application/json', 'identity'],
      ['HEAD', 200, 'text/html', 'identity'],
      ['GET', 200, 'text/html', 'br'],
    ]) {
      const origin = new Response('<div class="example">Original</div>', {
        status,
        headers: { 'content-type': type, 'content-encoding': encoding },
      });
      globalThis.fetch = async () => origin;
      assert.equal(await handler(new Request('https://example.com/path', { method })), origin);
    }
  });
});
