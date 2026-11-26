# AEM Edge Functions platform reference

Optional platform features for adapting the [reference project](../README.md).
These examples are not required by the default block or weather implementations.

## Provisioning and deployment

Deploy [config/edgeFunctions.yaml](../config/edgeFunctions.yaml) and
[config/cdn.yaml](../config/cdn.yaml) through a Cloud Manager
[configuration pipeline](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/operations/config-pipeline).
Code deployment does not update CDN rules. For an RDE, configuration can be
installed with `aio aem:rde:install -t env-config ./config`.

The service name is `my-edge-function`. If changing it, update provisioning,
CDN origin names and the npm deploy script together; this is not merely a file rename.

```sh
aio aem edge-functions info --debug
aio aem edge-functions list
aio aem edge-functions build
aio aem edge-functions deploy my-edge-function
aio aem edge-functions serve
aio aem edge-functions tail-logs my-edge-function
```

By default outgoing requests may use dynamic backends. Explicit origins can be
declared in the function configuration when origin restrictions are needed:

```yaml
origins:
  - name: my-origin
    domain: example.com
```

```js
const response = await fetch('https://example.com/data', { backend: 'my-origin' });
```

See [origin selectors](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-configuring-traffic#origin-selectors).

## Optional stores

Stores are not provisioned in sandbox programs even though edge functions run.
Do not make these examples mandatory unless the target environment supports them.

### Config store

Under `data` in `edgeFunctions.yaml`:

```yaml
configs:
  - key: EXAMPLE_SETTING
    value: example
```

```js
import { ConfigStore } from 'fastly:config-store';

const config = new ConfigStore('config_default');
const value = config.get('EXAMPLE_SETTING');
```

The store is named `config_default`; keys are case-sensitive. The project uses
plain JS configuration to keep its default examples easy to copy.

### Secret store

```yaml
secrets:
  - key: API_TOKEN
    value: ${{ API_TOKEN_SECRET }}
```

The value references a Cloud Manager secret; never put the real credential in
the YAML. Stores are named `secret_default` and secret values are immutable.

```js
import { SecretStoreManager } from '../src/lib/secret-store.js';

const apiToken = await SecretStoreManager.getSecret('API_TOKEN');
```

The optional helper supports bundled cloud secrets and individual local entries.
[fastly.toml](../fastly.toml) includes a dummy local entry solely for this example;
it is not used by weather. Configure local fixtures if copying this helper.
See [Cloud Manager secret variables](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/operations/config-pipeline#secret-env-vars).

### KV store

```yaml
kvs: true
```

This provisions an empty `kv_default`; initial entries are not declared in YAML.

```js
import { KVStore } from 'fastly:kv-store';

const kv = new KVStore('kv_default');
const entry = await kv.get('example-key');
if (entry) console.log(await entry.text());
await kv.put('example-key', 'example-value');
```

## Optional log forwarding

The project logs to console, viewable locally or through `tail-logs`. It does not
construct a named Fastly logger because that requires a configured endpoint.
For external logging, deploy an appropriate `logForwarding.yaml` alongside the
service configuration, for example:

```yaml
kind: LogForwarding
version: '1'
data:
  splunk:
    default:
      enabled: true
      host: splunk-host.example.com
      token: '${{ SPLUNK_TOKEN }}'
      index: AEMaaCS
```

Only then use the matching runtime logger:

```js
import { Logger } from 'fastly:logger';

const logger = new Logger('customerSplunk');
logger.log(JSON.stringify({ method: 'GET', path: '/example', status: 200 }));
```

Do not log credentials, request headers or personal data. See
[log forwarding](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/developing/log-forwarding).

## Caching: two independent layers

```text
Browser -> AEM CDN response cache -> Edge function fetch cache -> Origin
```

| Layer             | Stores                                       | Controlled by                                 | Purge                          |
| ----------------- | -------------------------------------------- | --------------------------------------------- | ------------------------------ |
| Outer CDN         | Final response returned by the function      | Response cache headers and CDN cache key      | CDN Cache Purge API            |
| Inner fetch cache | Origin responses fetched inside the function | Origin cache headers or Fastly cache override | Edge Functions purge-cache CLI |

The project caches successful block JSON responses for 300 seconds. SKU
persisted-query fetches use an explicit TTL. Fragment GraphQL queries use POST
and are not cached by the fetch cache. Rendered pages retain origin cache headers.

Example fetch cache override:

```js
import { CacheOverride } from 'fastly:cache-override';

const response = await fetch('https://example.com/data', {
  cacheOverride: new CacheOverride('override', { ttl: 300 }),
});
```

To bypass that cache, use `new CacheOverride('pass')`. This does not disable the
outer response cache. `Cache-Control: no-store` on an error response prevents
the outer cache from retaining the failure.

### Varying the CDN cache key

Weather depends on the caller's location. The request transformation in
[cdn.yaml](../config/cdn.yaml) sets the `ip` query parameter from the actual client
IP, making it part of the cache key. The handler uses that value for geolocation.
Keep the transformation when copying the weather route; otherwise different
visitors could receive the same cached location-dependent response.

Avoid `skipCache: true` when a suitable cache key can safely distinguish responses.
For other personalized services, define the cache key or deliberately disable
caching rather than copying weather's policy blindly.

### Purging

```sh
# Inner cache, by surrogate key
aio aem edge-functions purge-cache my-edge-function --surrogateKey my-page-key

# Inner cache, soft purge
aio aem edge-functions purge-cache my-edge-function --surrogateKey my-page-key --soft

# Inner cache, all entries: use with caution
aio aem edge-functions purge-cache my-edge-function --all
```

Programmatic inner-cache purge:

```js
import { purgeSurrogateKey } from 'fastly:compute';

purgeSurrogateKey('my-page-key');
```

Response `Surrogate-Key` headers identify the **outer** CDN entries, not the inner
fetch cache. Inner surrogate keys come from origin headers or programmatic cache writes.
Use the [CDN Cache Purge API](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-cache-purge)
for the outer cache.

If both layers contain stale data, invalidate both. Purging only the outer layer
can refill it from stale inner-cache content; purging only the inner layer leaves
the already cached response visible to browsers.

## Further reading

- [AEM Edge Delivery Services](https://www.aem.live/)
- [Fastly Compute](https://www.fastly.com/documentation/guides/compute/)
- [Fastly JavaScript API](https://js-compute-reference-docs.edgecompute.app/)
