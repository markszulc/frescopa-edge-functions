/// <reference types="@fastly/js-compute" />

// faq.js
import { CacheOverride } from "fastly:cache-override";

// ---- config -------------------------------------------------------------
// Swap these for ConfigStore reads once it works (see cpilsworth/ssreds src/fastly.ts)
const EDS_HOST = "main--frescopa26--markszulc.aem.live";        // your EDS origin
const PUBLISH_HOST = "publish-p137825-e1511252.adobeaemcloud.com";
const QUERY_PATH = "/graphql/execute.json/frescopa/FAQbySKU";
const BLOCK_NAME = "faq-list-by-sku";   // <-- set to the actual block class on the page
const CF_TTL = 300;              // seconds to cache the persisted query at the edge

// Allowlist for SKUs: authors control this value, so validate before it goes in a URL
const SKU_RE = /^[A-Za-z0-9_-]{1,40}$/;

// EDS origin markup for a key/value block:
// <div class="faq-list"><div><div><p>SKU</p></div><div><p>CSM6001</p></div></div></div>
const BLOCK_RE = new RegExp(
  `<div class="${BLOCK_NAME}">([\\s\\S]*?)</div>\\s*</div>\\s*</div>`,
  "g",
);

/**
 * Proxies an EDS page and inlines FAQ content fragments for any BLOCK_NAME blocks.
 * Call from the router in index.js for the page paths you want rendered at the edge.
 */
export async function faqHandler(req) {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set("host", EDS_HOST);

  const res = await fetch(`https://${EDS_HOST}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    backend: "eds_origin",
  });

  console.log("faq: eds", res.status, type, url.pathname);
  
  const type = res.headers.get("content-type") || "";
  if (req.method !== "GET" || !res.ok || !type.includes("text/html")) return res;

  let html = await res.text();
  const blocks = [...html.matchAll(BLOCK_RE)];
  if (!blocks.length) return new Response(html, { status: res.status, headers: res.headers });

  const rendered = await Promise.all(blocks.map(async ([, inner]) => {
    const sku = extractSku(inner);
    if (!sku) return null;
    const items = await fetchFaqs(sku);
    return items ? renderFaqs(sku, items) : null;
  }));

  // Replace from the end so earlier match indexes stay valid
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!rendered[i]) continue; // fetch failed: leave original block, client JS can fall back
    const m = blocks[i];
    html = html.slice(0, m.index) + rendered[i] + html.slice(m.index + m[0].length);
  }

  const out = new Headers(res.headers);
  out.delete("content-length");
  out.set("x-faq-ssr", rendered.filter(Boolean).length.toString());
  return new Response(html, { status: res.status, headers: out });
}

function extractSku(inner) {
  const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const sku = text.match(/SKU\s+(\S+)/i)?.[1];
  return sku && SKU_RE.test(sku) ? sku : null;
}

async function fetchFaqs(sku) {
  try {
    const r = await fetch(
      `https://${PUBLISH_HOST}${QUERY_PATH};sku=${encodeURIComponent(sku)}`,
      {
        backend: "aem_publish",
        cacheOverride: new CacheOverride("override", { ttl: CF_TTL }),
      },
    );
    if (!r.ok) return null;
    const json = await r.json();
    const items = json?.data?.faqList?.items;
    return Array.isArray(items) && items.length ? items : null;
  } catch {
    return null; // fail open to the unmodified block, no internals leaked to the page
  }
}

function renderFaqs(sku, items) {
  const rows = items.map((it) => `
      <details class="faq-item" data-category="${esc(it.category)}">
        <summary>${esc(it.question)}</summary>
        <p>${esc(it.answer?.plaintext)}</p>
      </details>`).join("");

  // FAQPage structured data so crawlers and LLMs get the Q&A explicitly
  const ld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.question,
      acceptedAnswer: { "@type": "Answer", text: it.answer?.plaintext ?? "" },
    })),
  };

  return `<div class="${BLOCK_NAME}" data-ssr="inlined" data-sku="${esc(sku)}">${rows}
      <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
    </div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}