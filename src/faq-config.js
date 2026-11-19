// faq-config.js
//
// Site-specific settings for the FAQ edge handlers in faq.js. To reuse the
// handlers on another site, copy this file with that site's values and pass it
// to createFaqHandlers(), or edit these defaults.
// Swap these for ConfigStore reads once it works (see cpilsworth/ssreds src/fastly.ts).

export default {
  // EDS origin the page proxy fetches from
  edsHost: "main--frescopa26--markszulc.aem.live",

  // AEM Publish tier that serves the FAQ content
  publishHost: "publish-p137825-e1511252.adobeaemcloud.com",

  // Persisted query for FAQs by SKU; the SKU is appended as ";sku=<value>"
  skuQueryPath: "/graphql/execute.json/frescopa/FAQbySKU",

  // GraphQL endpoint for FAQs by content fragment path (POST with typed variables)
  pathQueryPath: "/content/_cq_graphql/frescopa/endpoint.json",

  // GraphQL query for FAQs by path. It must accept a $filter on _path and return
  // items with _path, question and answer { plaintext }.
  pathQuery: `query getFaqsByPaths($filter: FaqModelFilter) {
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

  // Response key holding the items in both queries: data.<listKey>.items
  listKey: "faqList",

  // Block class names the page proxy hydrates
  skuBlock: "faq-list-by-sku",
  pathBlock: "content-fragment",

  // Seconds to cache the SKU persisted query at the edge, and the JSON endpoints
  // in browsers/CDN
  cacheTtl: 300,

  // Authors control SKUs, so they are validated before going in a URL
  skuPattern: /^[A-Za-z0-9_-]{1,40}$/,

  // Fragment paths accepted by the path block and JSON endpoint
  pathPattern: /^\/content\/dam\/[A-Za-z0-9._/-]+$/,

  // Origins allowed to call the JSON endpoints from the browser
  allowedOrigins:
    /^(https:\/\/([a-z0-9-]+\.)*(aem\.page|aem\.live|da\.live|frescopa\.coffee|frescopacoffee\.com)|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/,
};
