/// <reference types="@fastly/js-compute" />

import { faqHandler } from "./faq.js";

const QUERY_URL = "https://publish-p137825-e1511252.adobeaemcloud.com/content/_cq_graphql/frescopa/endpoint.json";
const QUERY = `query getFaqsByPaths($filter: FaqModelFilter) {
  faqList(filter: $filter) {
    items {
      _path
      question
      answer { plaintext }
      category
      sku
    }
  }
}`;
const BLOCK_NAME = "content-fragment";
const ALLOWED_ORIGIN_RE =
  /^(https:\/\/([a-z0-9-]+\.)*(aem\.page|aem\.live|da\.live|frescopa\.coffee)|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/;

function validPath(path) {
  return /^\/content\/dam\/[A-Za-z0-9._/-]+$/.test(path)
    && path.split("/").slice(3).every((part) => part && part !== "." && part !== "..");
}

function uniquePaths(paths) {
  if (!paths.length || !paths.every(validPath)) {
    throw new Error("Expected one or more /content/dam/ fragment paths");
  }
  return [...new Set(paths)];
}

async function fetchFaqs(paths) {
  const filter = {
    _path: {
      _logOp: "OR",
      _expressions: paths.map((value) => ({ value, _operator: "EQUALS" })),
    },
  };
  const res = await fetch(QUERY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { filter } }),
  });
  if (!res.ok) throw new Error(`Path FAQ GraphQL query returned HTTP ${res.status}`);
  const json = await res.json();
  const items = json?.data?.faqList?.items;
  if (json?.errors?.length || !Array.isArray(items)
    || items.some((item) => !item || typeof item._path !== "string"
      || typeof item.question !== "string"
      || (item.answer?.plaintext != null && typeof item.answer.plaintext !== "string"))) {
    throw new Error("Path FAQ query returned an invalid GraphQL response");
  }
  const byPath = new Map(items.map((item) => [item._path, item]));
  return paths.filter((path) => byPath.has(path)).map((path) => byPath.get(path));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]
  ));
}

function renderFaqs(items, opening) {
  const rows = items.map((item) =>
    `<div><div>${escapeHtml(item.question)}</div><div><p>${escapeHtml(item.answer?.plaintext)}</p></div></div>`
  ).join("");
  const data = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer?.plaintext ?? "" },
    })),
  };
  return {
    block: `${opening.slice(0, -1)} data-faq-ssr="true">${rows}</div>`,
    ld: items.length
      ? `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`
      : "",
  };
}

function findBlocks(html) {
  const blocks = [];
  const starts = /<div\b[^>]*>/gi;
  for (const start of html.matchAll(starts)) {
    const classes = start[0].match(/\sclass\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!classes?.split(/\s+/).includes(BLOCK_NAME)) continue;
    // Authored lists have an arbitrary number of nested row/cell divs.
    const tags = /<\/?div\b[^>]*>/g;
    tags.lastIndex = start.index + start[0].length;
    let depth = 1;
    let tag;
    while ((tag = tags.exec(html))) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (!depth) {
        blocks.push({
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

function extractPaths(inner) {
  const links = [...inner.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)];
  if (links.length) return uniquePaths(links.map((match) => match[1]));
  const text = inner.replace(/<[^>]+>/g, "\n").trim();
  return uniquePaths(text.split(/\s+/).filter(Boolean));
}

export async function faqByPathHandler(req) {
  const res = await faqHandler(req);
  if (req.method !== "GET" || !res.ok
    || !(res.headers.get("content-type") || "").includes("text/html")
    || !["identity", ""].includes((res.headers.get("content-encoding") || "").toLowerCase())) {
    return res;
  }
  let html = await res.text();
  const blocks = findBlocks(html);
  if (!blocks.length) return new Response(html, res);

  const rendered = await Promise.all(blocks.map(async (block) => {
    try {
      return renderFaqs(await fetchFaqs(extractPaths(block.inner)), block.opening);
    } catch (error) {
      console.error("FAQ path rendering failed; preserving authored block", error);
      return null;
    }
  }));
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (rendered[i]) {
      html = html.slice(0, blocks[i].index) + rendered[i].block + html.slice(blocks[i].end);
    }
  }
  const ld = rendered.filter(Boolean).map((result) => result.ld).filter(Boolean).join("\n");
  if (ld) html = html.replace("</head>", `${ld}\n</head>`);
  const headers = new Headers(res.headers);
  headers.set("x-faq-path-ssr", String(rendered.filter(Boolean).length));
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (rendered.some(Boolean)) {
    headers.delete("etag");
    headers.delete("last-modified");
  }
  return new Response(html, { status: res.status, headers });
}

export async function faqByPathDataHandler(req) {
  const origin = req.headers.get("origin") || "";
  const headers = new Headers({
    "content-type": "application/json",
    vary: "Origin",
    "cache-control": "no-store",
  });
  if (ALLOWED_ORIGIN_RE.test(origin)) headers.set("access-control-allow-origin", origin);
  let paths;
  try {
    paths = uniquePaths(new URL(req.url).searchParams.getAll("path"));
  } catch (error) {
    console.warn("Invalid FAQ path request", error);
    return new Response(JSON.stringify({ error: "invalid paths" }), { status: 400, headers });
  }
  try {
    const items = await fetchFaqs(paths);
    headers.set("cache-control", "public, max-age=300");
    return new Response(JSON.stringify({ paths, items }), { headers });
  } catch (error) {
    console.error("FAQ path data request failed", error);
    return new Response(JSON.stringify({ error: "FAQ content unavailable" }), { status: 502, headers });
  }
}
