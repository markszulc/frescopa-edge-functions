# Agent guidance

Read the [README](README.md) first for architecture, authored markup, routes,
configuration and setup. Optional platform examples live in the
[platform reference](docs/edge-functions-reference.md).

## Project goals

This is an AEM Edge Functions reference project: realistic enough to learn from,
but small, readable and easy to copy. Avoid production-framework complexity,
unnecessary abstractions and new dependencies unless the task requires them.
Use vanilla ES modules with explicit `.js` import extensions.

## Ownership and structure

- Keep a 1:1 relationship between `src/blocks/<eds-block-name>.js` and its EDS block.
  Each module owns its defaults, queries, validation, fetching, HTML rendering,
  structured data and browser JSON endpoint.
- Intentional duplication of content rendering and escaping is acceptable.
  Do not extract it into a shared renderer merely to eliminate duplication:
  a copied block should be independently adaptable to another content type.
- Put standalone endpoints in `src/services/`.
- Keep `src/lib/` utilities generic and named by responsibility.
- Keep shared hosts and browser origins in `src/site-config.js`; block-specific
  configuration belongs inside its block.
- Register blocks in `src/block-handlers.js`; standalone routes belong in `src/index.js`.
- Match tests to owning module names: `test/<module-name>-test.js`.
  Keep routing and page-proxy integration tests separate from block tests.

## Behaviour and safety

- Preserve endpoint URLs, authored markup contracts, SSR markers, structured data,
  ordering and caching unless an intentional change is requested and documented.
- Log failures explicitly. Preserve authored content when block SSR fails so
  other blocks can render and the browser can hydrate it.
- JSON upstream failures return uncached `502` responses, not empty successes.
  Valid queries with no matches return `200` with an empty item list.
- Keep tests independent of Adobe credentials and live upstream services.
- Do not log credentials, query values or request headers.
- Never commit `.aio`, tokens, real secrets or generated `bin/` and `pkg/` artifacts.
- Do not deploy, push or rename the provisioned service without explicit approval.
  The existing service is `my-edge-function`; code deployment and CDN configuration
  deployment are separate operations.
- Preserve unrelated worktree changes. Update directly related documentation.

## Validation

Use the existing tools and Prettier convention:

```sh
npm test
npm run lint
npm run build
```

Prefer targeted tests while iterating; run relevant integration tests when changing
shared behaviour. `npm run lint:fix` formats files. The Fastly build requires the
Adobe CLI; report checks that could not run rather than claiming success.
Documentation-only changes need formatting checks, not a runtime build.
Stop temporary local servers after validation.
