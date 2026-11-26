/// <reference types="@fastly/js-compute" />

// faq.js
import { CacheOverride } from "fastly:cache-override";

import defaultConfig from "./faq-config.js";

/**
 * Creates the FAQ page proxy and JSON endpoint handlers for one site.
 * @param {object} options Overrides for the defaults in faq-config.js
 */
export function createFaqHandlers(options = {}) {
  const config = { ...defaultConfig, ...options };
  const {
    edsHost: EDS_HOST,
    publishHost: PUBLISH_HOST,
    skuQueryPath: SKU_QUERY_PATH,
    pathQuery: PATH_QUERY,
    listKey: LIST_KEY,
    skuBlock: SKU_BLOCK,
    pathBlock: PATH_BLOCK,
    cacheTtl: CACHE_TTL,
    skuPattern: SKU_RE,
    pathPattern: PATH_RE,
    allowedOrigins: ALLOWED_ORIGIN_RE,
  } = config;
  const PATH_QUERY_URL = `https://${PUBLISH_HOST}${config.pathQueryPath}`;

  /**
   * Proxies an EDS page and inlines FAQ content for every SKU_BLOCK block
   * (looked up by SKU) and PATH_BLOCK block (looked up by content fragment path).
   */
  async function faqHandler(req) {
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

    const blocks = findBlocks(html);
    if (!blocks.length) return new Response(html, { status: res.status, headers: out });

    const rendered = await Promise.all(blocks.map((block) => (
      block.type === SKU_BLOCK ? renderSkuBlock(block) : renderPathBlock(block)
    )));

    // Replace from the end so earlier match indexes stay valid
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (!rendered[i]) continue; // fetch failed: leave original block, client JS can fall back
      html = html.slice(0, blocks[i].index) + rendered[i].block + html.slice(blocks[i].end);
    }

    // Structured data belongs in <head>, not inside <main> content
    const ld = rendered.filter(Boolean).map((r) => r.ld).filter(Boolean).join("\n");
    if (ld) html = html.replace("</head>", `${ld}\n</head>`);

    // Each header is only present when the page contains that block type
    for (const [type, header] of [[SKU_BLOCK, "x-faq-ssr"], [PATH_BLOCK, "x-faq-path-ssr"]]) {
      if (blocks.some((b) => b.type === type)) {
        out.set(header, String(rendered.filter((r, i) => r && blocks[i].type === type).length));
      }
    }
    if (rendered.some(Boolean)) {
      out.delete("etag");
      out.delete("last-modified");
    }
    return new Response(html, { status: res.status, headers: out });
  }

  // Finds SKU_BLOCK and PATH_BLOCK wrappers, tracking div depth because authored
  // path lists have an arbitrary number of nested row/cell divs.
  function findBlocks(html) {
    const blocks = [];
    for (const start of html.matchAll(/<div\b[^>]*>/gi)) {
      if (blocks.length && start.index < blocks[blocks.length - 1].end) continue;
      const classes = start[0].match(/\sclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/) ?? [];
      const type = [SKU_BLOCK, PATH_BLOCK].find((name) => classes.includes(name));
      if (!type) continue;
      const tags = /<\/?div\b[^>]*>/gi;
      tags.lastIndex = start.index + start[0].length;
      let depth = 1;
      let tag;
      while ((tag = tags.exec(html))) {
        depth += tag[0].startsWith("</") ? -1 : 1;
        if (!depth) {
          blocks.push({
            type,
            index: start.index,
            end: tags.lastIndex,
            opening: start[0],
            inner: html.slice(start.index + start[0].length, tag.index),
          });
          break;
        }
      }
    }
    return blocks;
  }

  // ---- SKU blocks -----------------------------------------------------------
  // EDS origin markup for a key/value block:
  // <div class="faq-list-by-sku"><div><div><p>SKU</p></div><div><p>CSM6001</p></div></div></div>

  async function renderSkuBlock(block) {
    const sku = extractSku(block.inner);
    if (!sku) return null;
    const items = await fetchFaqsBySku(sku);
    return items ? renderFaqs(items, `<div class="${SKU_BLOCK}">`) : null;
  }

  function extractSku(inner) {
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const sku = text.match(/SKU\s+(\S+)/i)?.[1];
    return sku && SKU_RE.test(sku) ? sku : null;
  }

  async function fetchFaqsBySku(sku) {
    try {
      const r = await fetch(
        `https://${PUBLISH_HOST}${SKU_QUERY_PATH};sku=${encodeURIComponent(sku)}`,
        {
          cacheOverride: new CacheOverride("override", { ttl: CACHE_TTL }),
        },
      );
      if (!r.ok) return null;
      const json = await r.json();
      const items = json?.data?.[LIST_KEY]?.items;
      return Array.isArray(items) && items.length ? items : null;
    } catch {
      return null; // fail open to the unmodified block, no internals leaked to the page
    }
  }

  // ---- Content fragment path blocks ----------------------------------------
  // One fragment link or plain /content/dam/... path per row:
  // <div class="content-fragment"><div><div><p>/content/dam/.../faq</p></div></div></div>

  async function renderPathBlock(block) {
    try {
      const items = await fetchFaqsByPaths(extractPaths(block.inner));
      if (!items.length) {
        console.warn("No published FAQs matched the authored paths; preserving authored block");
        return null;
      }
      return renderFaqs(items, `${block.opening.slice(0, -1)} data-faq-ssr="true">`);
    } catch (error) {
      console.error("FAQ path rendering failed; preserving authored block", error);
      return null;
    }
  }

  function validPath(path) {
    return PATH_RE.test(path)
      && path.split("/").slice(3).every((part) => part && part !== "." && part !== "..");
  }

  function uniquePaths(paths) {
    if (!paths.length || !paths.every(validPath)) {
      throw new Error("Expected one or more /content/dam/ fragment paths");
    }
    return [...new Set(paths)];
  }

  function extractPaths(inner) {
    const links = [...inner.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)];
    if (links.length) return uniquePaths(links.map((match) => match[1]));
    const text = inner.replace(/<[^>]+>/g, "\n").trim();
    return uniquePaths(text.split(/\s+/).filter(Boolean));
  }

  // POSTs typed variables to the GraphQL endpoint: the persisted-query endpoint
  // doesn't apply an object filter. Throws on any failure so callers can decide
  // whether to fail open (page rendering) or return an error (JSON endpoint).
  async function fetchFaqsByPaths(paths) {
    const filter = {
      _path: {
        _logOp: "OR",
        _expressions: paths.map((value) => ({ value, _operator: "EQUALS" })),
      },
    };
    const res = await fetch(PATH_QUERY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: PATH_QUERY, variables: { filter } }),
    });
    if (!res.ok) throw new Error(`Path FAQ GraphQL query returned HTTP ${res.status}`);
    const json = await res.json();
    const items = json?.data?.[LIST_KEY]?.items;
    if (json?.errors?.length || !Array.isArray(items)
      || items.some((item) => !item || typeof item._path !== "string"
        || typeof item.question !== "string"
        || (item.answer?.plaintext != null && typeof item.answer.plaintext !== "string"))) {
      throw new Error("Path FAQ query returned an invalid GraphQL response");
    }
    // Only return requested fragments, in authored order
    const byPath = new Map(items.map((item) => [item._path, item]));
    return paths.filter((path) => byPath.has(path)).map((path) => byPath.get(path));
  }

  // ---- rendering ------------------------------------------------------------

  // Emits the block in standard EDS block-table markup: the same row/cell
  // structure EDS itself serves for an authored block, with the authored rows
  // replaced by one row per FAQ (question cell | answer cell). The block JS
  // decorates it in the browser exactly as it would any other block, so the
  // edge never produces decorated markup and there is one renderer, not two.
  function renderFaqs(items, opening) {
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
      block: `${opening}${rows}
          </div>`,
      ld: items.length
        ? `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`
        : "",
    };
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // ---- JSON endpoints for client-side rendering -----------------------------
  // Used by the block JS wherever the page didn't come through this function
  // (aem.page preview, da.live preview, local dev).

  function corsHeaders(req, extra) {
    const origin = req.headers.get("origin") || "";
    const headers = new Headers({ "content-type": "application/json", vary: "Origin", ...extra });
    if (ALLOWED_ORIGIN_RE.test(origin)) headers.set("access-control-allow-origin", origin);
    return headers;
  }

  // Route: GET /faq-data?sku=XXX
  async function faqDataHandler(req) {
    const headers = corsHeaders(req);
    const sku = new URL(req.url).searchParams.get("sku") || "";
    if (!SKU_RE.test(sku)) {
      return new Response(JSON.stringify({ error: "invalid sku" }), { status: 400, headers });
    }

    const items = await fetchFaqsBySku(sku);
    headers.set("cache-control", `public, max-age=${CACHE_TTL}`);
    return new Response(JSON.stringify({ sku, items: items ?? [] }), { status: 200, headers });
  }

  // Route: GET /faq-data-by-path?path=/content/dam/...&path=...
  async function faqByPathDataHandler(req) {
    const headers = corsHeaders(req, { "cache-control": "no-store" });
    let paths;
    try {
      paths = uniquePaths(new URL(req.url).searchParams.getAll("path"));
    } catch (error) {
      console.warn("Invalid FAQ path request", error);
      return new Response(JSON.stringify({ error: "invalid paths" }), { status: 400, headers });
    }
    try {
      const items = await fetchFaqsByPaths(paths);
      headers.set("cache-control", `public, max-age=${CACHE_TTL}`);
      return new Response(JSON.stringify({ paths, items }), { headers });
    } catch (error) {
      console.error("FAQ path data request failed", error);
      return new Response(JSON.stringify({ error: "FAQ content unavailable" }), { status: 502, headers });
    }
  }

  return { faqHandler, faqDataHandler, faqByPathDataHandler };
}

// Handlers bound to the default (Frescopa) configuration in faq-config.js
export const { faqHandler, faqDataHandler, faqByPathDataHandler } = createFaqHandlers();
