/**
 * Each renderer supplies className, ssrHeader and async render(block).
 * Rendering returns { block, ld } or null to preserve authored content.
 */
export function createPageHandler(edsHost, renderers) {
  return async function pageHandler(req) {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set('host', edsHost);
    headers.delete('accept-encoding');
    const res = await fetch(`https://${edsHost}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      fastly: { decompressGzip: true },
    });
    const type = res.headers.get('content-type') || '';
    if (req.method !== 'GET' || !res.ok || !type.includes('text/html')) return res;

    const encoding = (res.headers.get('content-encoding') || 'identity').toLowerCase();
    let body = res.body;
    if (encoding === 'gzip') body = body.pipeThrough(new DecompressionStream('gzip'));
    else if (encoding !== 'identity') return res;
    let html = await new Response(body).text();
    const out = new Headers(res.headers);
    out.delete('content-length');
    out.delete('content-encoding');

    const blocks = findBlocks(html, renderers);
    const rendered = await Promise.all(blocks.map((block) => block.renderer.render(block)));
    // Replace backwards so offsets from the original HTML remain valid.
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (!rendered[i]) continue;
      html = html.slice(0, blocks[i].index) + rendered[i].block + html.slice(blocks[i].end);
    }
    const ld = rendered
      .filter(Boolean)
      .map((result) => result.ld)
      .filter(Boolean)
      .join('\n');
    if (ld) html = html.replace('</head>', `${ld}\n</head>`);
    for (const renderer of renderers) {
      if (blocks.some((block) => block.renderer === renderer)) {
        out.set(
          renderer.ssrHeader,
          String(rendered.filter((result, i) => result && blocks[i].renderer === renderer).length),
        );
      }
    }
    if (rendered.some(Boolean)) {
      out.delete('etag');
      out.delete('last-modified');
    }
    return new Response(html, { status: res.status, headers: out });
  };
}

function findBlocks(html, renderers) {
  const blocks = [];
  for (const start of html.matchAll(/<div\b[^>]*>/gi)) {
    if (blocks.length && start.index < blocks[blocks.length - 1].end) continue;
    const classes = start[0].match(/\sclass\s*=\s*(["'])(.*?)\1/i)?.[2]?.split(/\s+/) ?? [];
    const renderer = renderers.find(({ className }) => classes.includes(className));
    if (!renderer) continue;
    const tags = /<\/?div\b[^>]*>/gi;
    tags.lastIndex = start.index + start[0].length;
    let depth = 1;
    let tag;
    while ((tag = tags.exec(html))) {
      depth += tag[0].startsWith('</') ? -1 : 1;
      if (!depth) {
        blocks.push({
          renderer,
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
