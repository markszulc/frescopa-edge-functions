import { registerHooks } from 'node:module';

export async function withFastlyModules(importModules) {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'fastly:cache-override') {
        return {
          url: 'data:text/javascript,export class CacheOverride { constructor(mode, options) { this.mode = mode; this.options = options; } }',
          shortCircuit: true,
        };
      }
      if (specifier === 'fastly:geolocation') {
        return nextResolve(new URL('./geolocation.js', import.meta.url).href, context);
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    return await importModules();
  } finally {
    hooks.deregister();
  }
}
