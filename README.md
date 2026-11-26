# Frescopa Edge Functions reference

A small, copyable reference project for AEM Edge Functions. It demonstrates
server-side rendering of EDS blocks and a standalone weather service, using
Frescopa content as the example.

The goal is realistic behaviour with understandable code, not a complete
production framework. All modules run inside **one deployed edge function**.
Each block owns its content-specific configuration, fetching, validation,
HTML and structured data so it can be copied and adapted independently.

## Quick start

AI coding assistants should also read [AGENTS.md](AGENTS.md).
Claude Code loads that guidance through [CLAUDE.md](CLAUDE.md).

Use **Node.js 22.15 or newer**, npm, and the Adobe CLI with the Edge Functions plugin:

```sh
npm install -g @adobe/aio-cli
aio plugins:install @adobe/aio-cli-plugin-aem-edge-functions
npm ci
aio login
aio aem edge-functions setup
aio aem edge-functions info --debug
npm test
npm run lint
npm run build
npm run serve
```

During setup, save locally, select the correct Adobe organization and program,
then select the EDS site. The site domain must be a registered hostname with
valid TLS and the provisioned Edge Functions API. Your deploy identity needs the
required AEM Administrator product profile in that organization.

The local edge server runs at `http://127.0.0.1:7676`:

```sh
curl http://127.0.0.1:7676/hello-world
curl 'http://127.0.0.1:7676/weather?ip=127.0.0.1'
curl 'http://127.0.0.1:7676/faq-data?sku=CSM6001'
curl 'http://127.0.0.1:7676/faq-data-by-path?path=/content/dam/frescopa/en/faqs/do-i-have-to-buy-frescopa-pods'
```

FAQ examples call the configured AEM Publish host and require published content.
Local IP geolocation is limited to Fastly's local fixtures; arbitrary public IPs
may return the friendly "Could not determine your location" response. Deployed
weather requests use Fastly geolocation and the caller IP supplied by the CDN.

After provisioning and routing are configured:

```sh
npm run deploy
aio aem edge-functions tail-logs my-edge-function
```

`npm run deploy` targets the existing `my-edge-function` service. The package name
in `fastly.toml` is build metadata, not the deployed service name.

## Source structure

```text
src/
  index.js                    Entry point: example/service routes and error handling
  block-handlers.js           Registers blocks and routes their JSON endpoints
  site-config.js              Shared EDS/Publish hosts and browser origin allowlist
  blocks/
    faq-list-by-sku.js         Complete SKU FAQ block implementation
    content-fragment.js        Complete FAQ fragment block implementation
  services/
    weather.js                 Standalone weather endpoint
  lib/
    page-handler.js            EDS proxy, block matching and HTML replacement
    json-cors.js               Generic JSON/CORS headers
    log.js                     Console request metadata logging
    response.js                Common HTTP error responses
    secret-store.js            Optional Fastly secret-store example
test/
  faq-list-by-sku-test.js      SKU block behaviour
  content-fragment-test.js     Fragment block behaviour
  block-handlers-test.js       Routing, configuration isolation and mixed-block integration
  page-handler-test.js         Generic page proxy behaviour
  weather-test.js              Weather service behaviour
  log-test.js                  Logging behaviour
  response-test.js             Shared HTTP response helpers
  index-test.js                Entry-point routing and error handling
  helpers/                    Node-only Fastly runtime test doubles
config/
  edgeFunctions.yaml           Service provisioning
  cdn.yaml                     CDN transformations and origin routing
docs/
  edge-functions-reference.md  Optional stores, logging and caching reference
```

- **[Blocks](src/blocks/)** have a 1:1 relationship with supported EDS blocks.
- **[Services](src/services/)** are standalone endpoints, not HTML block renderers.
- **[Utilities](src/lib/)** provide generic infrastructure. No shared content renderer.
- **[Tests](test/)** mirror the owning module's name. Integration tests are separate.
- `data/` is unnecessary unless static datasets are introduced.

## Routes and request flow

All listed endpoints use GET. Browser JSON endpoint paths are declared inside
their block modules; standalone routes are declared in [index.js](src/index.js).

| Route                        | Owner                     | Response                                                                        | Caching                                  |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `/hello-world`               | Entry-point demonstration | Plain text                                                                      | No explicit TTL in this example          |
| `/weather`                   | Weather service           | Plain text                                                                      | 300 seconds, CDN key varies by client IP |
| `/faq-data?sku=...`          | `faq-list-by-sku`         | `{ sku, items }` JSON                                                           | 300 seconds                              |
| `/faq-data-by-path?path=...` | `content-fragment`        | `{ paths, items }` JSON                                                         | 300 seconds                              |
| Remaining paths              | Page handler              | EDS origin response, with matching blocks rendered on successful GET HTML pages | Origin response cache headers            |

```text
Request -> index.js
  -> hello-world / weather
  -> block-handlers.js
       -> matching block JSON endpoint
       -> page-handler.js fetches EDS HTML once
            -> matching block modules fetch and render content
            -> replacements and structured data are inserted
```

The page proxy passes through non-GET, non-HTML and unsuccessful origin responses.
It handles gzip, but leaves unsupported encodings unchanged. Supported blocks
are opaque subtrees: nested supported blocks are not rendered independently.
This is a lightweight EDS markup matcher, not a general-purpose HTML parser.

Both FAQ JSON endpoints return **400/no-store** for invalid input and
**502/no-store** for upstream or malformed-data failures. A valid query with no
matching content returns **200** with `items: []`. This intentionally replaces
the old SKU endpoint's cached empty success response on upstream failure.
Page rendering failures are logged and preserve authored content for browser fallback;
one block's failure does not stop other blocks from rendering.

Weather returns **502/no-store** on API failures or invalid data, and
**400/no-store** without a client IP. Unavailable geolocation remains a friendly
cacheable **200** response. Zero degrees is a valid temperature.
The public Open-Meteo example needs no secret or Authorization header.

## Where configuration lives

| File                                            | Responsibility                                                   | Deployment                           |
| ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ |
| Local `.aio` (ignored by Git)                   | CLI organization, program and EDS domain/authentication settings | Local CLI only                       |
| [site-config.js](src/site-config.js)            | Shared EDS origin, Publish host and allowed browser origins      | Build and deploy code                |
| Each block module's `defaultConfig`             | Block class, JSON route, GraphQL query, validation and cache TTL | Build and deploy code                |
| [edgeFunctions.yaml](config/edgeFunctions.yaml) | Service name and optional origins/stores                         | Cloud Manager configuration pipeline |
| [cdn.yaml](config/cdn.yaml)                     | Which requests reach the function; weather IP cache key          | Cloud Manager configuration pipeline |
| [fastly.toml](fastly.toml)                      | Package metadata and optional local runtime fixtures             | Local build/serve                    |

The CDN routes all extensionless and `.html` paths through this function, leaving
other assets at their origin. See the actual configuration rather than copying
an incomplete route example. Changing code and changing CDN configuration are
separate deployment steps.

Build outputs in `bin/` and `pkg/`, installed dependencies and local credentials
are ignored. Never commit `.aio`, access tokens or real secrets.

## Copying or extending a block

1. Copy `src/blocks/<eds-block-name>.js`.
2. Update its factory name and `defaultConfig`: class, route, query, list key and validation.
3. Adapt the HTML renderer and structured-data schema for the new content type.
4. Register the factory in `createBlockHandlers`, with its own overrides.
5. Copy the corresponding test suite and update its authored markup and expected output.

HTML escaping and structured-data rendering are intentionally duplicated inside
each block. Changing one block's output cannot change another's. Block modules
only share site settings and generic JSON/CORS utilities; the SKU module also
uses Fastly's fetch-cache API.

The renderer contract is `{ className, ssrHeader, render }`. `render(block)`
receives `opening`, `inner`, `index` and `end`, and returns `{ block, ld }`
(replacement HTML and optional structured data), or `null` to preserve the original.
A browser JSON endpoint also supplies `dataPath` and `dataHandler`.
Handle and log content-fetching failures inside the module.

Factories work independently with their defaults. To override site and block
settings together:

```js
import { createBlockHandlers } from './src/block-handlers.js';

const handlers = createBlockHandlers({
  site: {
    edsHost: 'main--mysite--myorg.aem.live',
    publishHost: 'publish-p123-e456.adobeaemcloud.com',
  },
  faqListBySku: {
    queryPath: '/graphql/execute.json/mysite/FAQbySKU',
    cacheTtl: 60,
  },
  contentFragment: {
    queryPath: '/content/_cq_graphql/mysite/endpoint.json',
  },
});
// handlers.handleRequest(req): JSON endpoint or EDS page proxy
```

New standalone services belong in `src/services/` and need a route in `src/index.js`.
Adding modules does not require a new deployed service.

## Authored block contracts

**FAQ List by SKU** uses a key/value row:

```html
<div class="faq-list-by-sku">
  <div>
    <div><p>SKU</p></div>
    <div><p>CSM6001</p></div>
  </div>
</div>
```

**Content Fragment** currently supports **FAQ fragments only**, not arbitrary models.
Author one relative fragment link or plain `/content/dam/...` path per row,
without a label/header row:

```html
<div class="content-fragment">
  <div>
    <div><p>/content/dam/frescopa/en/faqs/do-i-have-to-buy-frescopa-pods</p></div>
  </div>
</div>
```

The fragment query POSTs typed `$filter` variables to the direct GraphQL endpoint.
Persisted-query endpoints were not applying this object filter correctly in the
example environment. Results are deduplicated and ordered by authored paths;
only requested fragments are returned. Paths must match published content exactly.
Changing models means updating the query, `listKey`, validation and renderer together.

Both blocks emit standard EDS question/answer rows and FAQPage JSON-LD in `<head>`.
`x-faq-ssr` and `x-faq-path-ssr` count successfully rendered blocks; fragment wrappers
also receive `data-faq-ssr="true"`.
The companion EDS browser decorator must understand these rows and hydrate
authored inputs from the JSON endpoints when SSR has not run, such as in preview.

## Tests, formatting and validation

```sh
npm test
npm test -- test/faq-list-by-sku-test.js test/content-fragment-test.js
npm run lint
npm run lint:fix
npm run build
```

Prettier supplies one formatting convention; no application framework or
transpilation is introduced. GitHub Actions runs formatting checks and the Node
tests. The Fastly build remains a separate local validation step requiring the
Adobe CLI. Tests mock Fastly modules and upstream requests; they require no
Adobe login and are not proof that a target environment is correctly provisioned.

## Troubleshooting

- **Wrong domain or org:** rerun `aio aem edge-functions setup` and save locally.
  Confirm with `aio aem edge-functions info --debug`. A changed CLI org does not
  grant access or switch your signed-in Adobe identity.
- **TLS hostname mismatch:** use the correctly registered site domain with valid
  TLS. Do not disable certificate validation.
- **403 / required product profile missing:** check organization, login and roles.
  An IMS token represents your interactive user; OAuth Server-to-Server uses the
  Developer Console technical account. Refresh login after permissions change.
- **Unrendered block:** check authored markup, exact published SKU/paths, query
  model and logs. Inspect the SSR count headers.
- **Stale content:** the outer CDN response cache and inner fetch cache are
  separate; purging one does not purge the other.

Request logs contain method, path and status. They intentionally omit query
values and headers, and require no config store or logging endpoint.
See the [platform reference](docs/edge-functions-reference.md) for optional stores,
log forwarding, cache control and purge commands.
