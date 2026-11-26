import siteConfig from '../site-config.js';
import { createJsonCorsHeaders } from '../lib/json-cors.js';

const defaultConfig = {
  className: 'content-fragment',
  ssrHeader: 'x-faq-path-ssr',
  dataPath: '/blocks/content-fragment',
  queryPath: '/content/_cq_graphql/frescopa/endpoint.json',
  query: `query getFaqsByPaths($filter: FaqModelFilter) {
  faqList(filter: $filter) {
    items {
      _path
      question
      answer { plaintext }
      category
      sku
    }
  }
}`,
  listKey: 'faqList',
  cacheTtl: 300,
  pathPattern: /^\/content\/dam\/[A-Za-z0-9._/-]+$/,
};

export function createContentFragment(options = {}) {
  const config = { ...siteConfig, ...defaultConfig, ...options };
  function uniquePaths(paths) {
    if (
      !paths.length ||
      !paths.every(
        (path) =>
          config.pathPattern.test(path) &&
          path
            .split('/')
            .slice(3)
            .every((part) => part && part !== '.' && part !== '..'),
      )
    ) {
      throw new Error('Expected one or more /content/dam/ fragment paths');
    }
    return [...new Set(paths)];
  }

  function extractPaths(inner) {
    const links = [...inner.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)];
    if (links.length) return uniquePaths(links.map((match) => match[1]));
    return uniquePaths(
      inner
        .replace(/<[^>]+>/g, '\n')
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  // Persisted endpoints do not apply object filters; send typed variables via POST.
  async function fetchFaqs(paths) {
    const filter = {
      _path: {
        _logOp: 'OR',
        _expressions: paths.map((value) => ({ value, _operator: 'EQUALS' })),
      },
    };
    const res = await fetch(`https://${config.publishHost}${config.queryPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: config.query, variables: { filter } }),
    });
    if (!res.ok) throw new Error(`Path FAQ GraphQL query returned HTTP ${res.status}`);
    const json = await res.json();
    const items = json?.data?.[config.listKey]?.items;
    if (
      json?.errors?.length ||
      !Array.isArray(items) ||
      items.some(
        (item) =>
          !item ||
          typeof item._path !== 'string' ||
          typeof item.question !== 'string' ||
          (item.answer?.plaintext != null && typeof item.answer.plaintext !== 'string'),
      )
    ) {
      throw new Error('Path FAQ query returned an invalid GraphQL response');
    }
    const byPath = new Map(items.map((item) => [item._path, item]));
    return paths.filter((path) => byPath.has(path)).map((path) => byPath.get(path));
  }

  async function render(block) {
    try {
      const items = await fetchFaqs(extractPaths(block.inner));
      if (!items.length) {
        console.warn('No published FAQs matched the authored paths; preserving authored block');
        return null;
      }
      return renderFaqs(items, `${block.opening.slice(0, -1)} data-faq-ssr="true">`);
    } catch (error) {
      console.error('FAQ path rendering failed; preserving authored block', error);
      return null;
    }
  }

  async function dataHandler(req) {
    const headers = createJsonCorsHeaders(req, config.allowedOrigins, {
      'cache-control': 'no-store',
    });
    let paths;
    try {
      paths = uniquePaths(new URL(req.url).searchParams.getAll('path'));
    } catch (error) {
      console.warn('Invalid FAQ path request', error);
      return new Response(JSON.stringify({ error: 'invalid paths' }), { status: 400, headers });
    }
    try {
      const items = await fetchFaqs(paths);
      headers.set('cache-control', `public, max-age=${config.cacheTtl}`);
      return new Response(JSON.stringify({ paths, items }), { headers });
    } catch (error) {
      console.error('FAQ path data request failed', error);
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
