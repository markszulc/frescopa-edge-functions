import assert from 'node:assert/strict';
import { log } from '../src/lib/log.js';

describe('log', function () {
  it('logs request metadata without requiring Fastly stores or exposing query values and headers', function () {
    const originalLog = console.log;
    const records = [];
    console.log = (record) => records.push(JSON.parse(record));
    try {
      log(
        new Request('https://example.com/weather?ip=203.0.113.10', {
          headers: { authorization: 'example-test-value' },
        }),
        new Response('Weather', { status: 200 }),
      );
      assert.deepEqual(records, [{ method: 'GET', path: '/weather', status: 200 }]);
    } finally {
      console.log = originalLog;
    }
  });
});
