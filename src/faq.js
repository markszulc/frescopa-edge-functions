/// <reference types="@fastly/js-compute" />

// faq.js
import { CacheOverride } from "fastly:cache-override";

// ---- config -------------------------------------------------------------
// Swap these for ConfigStore reads once it works (see cpilsworth/ssreds src/fastly.ts)
const EDS_HOST = "main--frescopa26--markszulc.aem.live";
const PUBLISH_HOST = "publish-p137825-e1511252.adobeaemcloud.com";
const QUERY_PATH = "/graphql/execute.json/frescopa/FAQbySKU";
const BLOCK_NAME = "faq-list-by-sku";
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
  headers.delete("accept-encoding");

  const res = await fetch(`https://${EDS_HOST}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    // Ask Fastly to gunzip the origin body for us (removes content-encoding when it does)
    fastly: { decompressGzip: true },
  });

  const type = res.headers.get("content-type") || "";
  if (req.method !== "GET" || !res.ok || !type.includes("text/html")) return res;

  // Belt and braces: if the body is still gzipped, decompress it ourselves.
  // Anything else compressed (br, zstd) we can't safely rewrite, so pass it through.
  const enc = (res.headers.get("content-encoding") || "identity").toLowerCase();
  let body = res.body;
  if (enc === "gzip") body = body.pipeThrough(new DecompressionStream("gzip"));
  else if (enc !== "identity") return res;

  let html = await new Response(body).text();

  // Headers for any rewritten response: body is now plain text of a new length
  const out = new Headers(res.headers);
  out.delete("content-length");
  out.delete("content-encoding");

  const blocks = [...html.matchAll(BLOCK_RE)];
  if (!blocks.length) return new Response(html, { status: res.status, headers: out });

  const rendered = await Promise.all(blocks.map(async ([, inner]) => {
    const sku = extractSku(inner);
    if (!sku) return null;
    const items = await fetchFaqs(sku);
    return items ? renderFaqs(items) : null;
  }));

  // Replace from the end so earlier match indexes stay valid
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (!rendered[i]) continue; // fetch failed: leave original block, client JS can fall back
    const m = blocks[i];
    html = html.slice(0, m.index) + rendered[i].block + html.slice(m.index + m[0].length);
  }

  // Structured data belongs in <head>, not inside <main> content
  const ld = rendered.filter(Boolean).map((r) => r.ld).join("\n");
  if (ld) html = html.replace("</head>", `${ld}\n</head>`);

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

// Emits the block in standard EDS block-table markup: the same row/cell
// structure EDS itself serves for an authored block, with the SKU row
// replaced by one row per FAQ (question cell | answer cell). The block JS
// decorates it in the browser exactly as it would any other block, so the
// edge never produces decorated markup and there is one renderer, not two.
function renderFaqs(items) {
  const rows = items.map((it) => `
          <div>
            <div>${esc(it.question)}</div>
            <div><p>${esc(it.answer?.plaintext)}</p></div>
          </div>`).join("");

  // FAQPage structured data so crawlers and LLMs get the Q&A explicitly
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.question,
      acceptedAnswer: { "@type": "Answer", text: it.answer?.plaintext ?? "" },
    })),
  };

  return {
    block: `<div class="${BLOCK_NAME}">${rows}
        </div>`,
    ld: `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`,
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---- JSON endpoint for client-side rendering ------------------------------
// Used by the block JS wherever the page didn't come through this function
// (aem.page preview, da.live preview, local dev). Route: GET /faq-data?sku=XXX

// Origins allowed to call the endpoint from the browser
const ALLOWED_ORIGIN_RE =
  /^(https:\/\/([a-z0-9-]+\.)*(aem\.page|aem\.live|da\.live|frescopa\.coffee)|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;

export async function faqDataHandler(req) {
  const origin = req.headers.get("origin") || "";
  const headers = { "content-type": "application/json", vary: "Origin" };
  if (ALLOWED_ORIGIN_RE.test(origin)) headers["access-control-allow-origin"] = origin;

  const sku = new URL(req.url).searchParams.get("sku") || "";
  if (!SKU_RE.test(sku)) {
    return new Response(JSON.stringify({ error: "invalid sku" }), { status: 400, headers });
  }

  const items = await fetchFaqs(sku);
  headers["cache-control"] = "public, max-age=300";
  return new Response(JSON.stringify({ sku, items: items ?? [] }), { status: 200, headers });
}