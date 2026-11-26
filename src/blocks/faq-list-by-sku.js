import { CacheOverride } from 'fastly:cache-override';
import siteConfig from '../site-config.js';
import { createJsonCorsHeaders } from '../lib/json-cors.js';

const defaultConfig = {
  className: 'faq-list-by-sku',
  ssrHeader: 'x-faq-ssr',
  dataPath: '/faq-data',
  queryPath: '/graphql/execute.json/frescopa/FAQbySKU',
  listKey: 'faqList',
  cacheTtl: 300,
  skuPattern: /^[A-Za-z0-9_-]{1,40}$/,
};

export function createFaqListBySku(options = {}) {
  const config = { ...siteConfig, ...defaultConfig, ...options };
  async function fetchFaqs(sku) {
    const res = await fetch(
      `https://${config.publishHost}${config.queryPath};sku=${encodeURIComponent(sku)}`,
      { cacheOverride: new CacheOverride('override', { ttl: config.cacheTtl }) },
    );
    if (!res.ok) throw new Error(`SKU FAQ query returned HTTP ${res.status}`);
    const json = await res.json();
    const items = json?.data?.[config.listKey]?.items;
    if (
      json?.errors?.length ||
      !Array.isArray(items) ||
      items.some(
        (item) =>
          !item ||
          typeof item.question !== 'string' ||
          (item.answer?.plaintext != null && typeof item.answer.plaintext !== 'string'),
      )
    ) {
      throw new Error('SKU FAQ query returned an invalid GraphQL response');
    }
    return items;
  }

  async function render(block) {
    const text = block.inner
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sku = text.match(/SKU\s+(\S+)/i)?.[1];
    if (!sku || !config.skuPattern.test(sku)) {
      console.warn('Invalid SKU FAQ block; preserving authored block');
      return null;
    }
    try {
      const items = await fetchFaqs(sku);
      if (!items.length) {
        console.warn('No published FAQs matched the SKU; preserving authored block');
        return null;
      }
      return renderFaqs(items, `<div class="${config.className}">`);
    } catch (error) {
      console.error('SKU FAQ rendering failed; preserving authored block', error);
      return null;
    }
  }

  async function dataHandler(req) {
    const headers = createJsonCorsHeaders(req, config.allowedOrigins, {
      'cache-control': 'no-store',
    });
    const sku = new URL(req.url).searchParams.get('sku') || '';
    if (!config.skuPattern.test(sku)) {
      console.warn('Invalid FAQ SKU request');
      return new Response(JSON.stringify({ error: 'invalid sku' }), { status: 400, headers });
    }
    try {
      const items = await fetchFaqs(sku);
      headers.set('cache-control', `public, max-age=${config.cacheTtl}`);
      return new Response(JSON.stringify({ sku, items }), { headers });
    } catch (error) {
      console.error('SKU FAQ data request failed', error);
      return new Response(JSON.stringify({ error: 'FAQ content unavailable' }), {
        status: 502,
        headers,
      });
    }
  }

  return {
    className: config.className,
    ssrHeader: config.ssrHeader,
    dataPath: config.dataPath,
    render,
    dataHandler,
  };
}

function renderFaqs(items, opening) {
  const rows = items
    .map(
      (item) => `
            <div>
              <div>${escapeHtml(item.question)}</div>
              <div><p>${escapeHtml(item.answer?.plaintext)}</p></div>
            </div>`,
    )
    .join('');
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer?.plaintext ?? '' },
    })),
  };
  return {
    block: `${opening}${rows}
          </div>`,
    ld: items.length
      ? `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
      : '',
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}
