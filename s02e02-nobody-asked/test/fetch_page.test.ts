// A7: fetch_page cannot be turned against the host or its network (SSRF), and reads are bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage, isBlockedIp } from '../src/fetch_page.ts';

const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }];
const okFetch = async () => new Response('<html><head><title>T</title><script>evil()</script></head><body><p>Hello &amp; welcome</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });

test('A7: private, loopback, link-local and metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['93.184.215.14', '8.8.8.8', '2606:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
});

test('A7: localhost and private hosts are refused before any request', async () => {
  let called = 0;
  const f = async () => { called += 1; return okFetch(); };
  for (const url of ['http://localhost/', 'http://127.0.0.1:8080/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/']) {
    const r = await fetchPage(url, { fetchImpl: f as never });
    assert.equal(r.ok, false, url);
  }
  const r = await fetchPage('http://internal.example/', { fetchImpl: f as never, lookup: async () => [{ address: '10.0.0.7', family: 4 }] });
  assert.equal(r.ok, false);
  assert.equal(called, 0);
});

test('A7: other schemes, credentials in the URL and odd ports are refused', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'http://user:pass@example.com/', 'http://example.com:22/', 'javascript:alert(1)']) {
    const r = await fetchPage(url, { fetchImpl: okFetch as never, lookup: publicLookup });
    assert.equal(r.ok, false, url);
  }
});

test('A7: a redirect to a private address is refused', async () => {
  const f = async (u: string) =>
    String(u).includes('example.com') ? new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }) : okFetch();
  const r = await fetchPage('https://example.com/', { fetchImpl: f as never, lookup: async (h: string) => (h === 'example.com' ? publicLookup() : [{ address: '169.254.169.254', family: 4 }]) });
  assert.equal(r.ok, false);
});

test('A7: an oversize page is cut, not read whole', async () => {
  const big = 'a'.repeat(3_000_000);
  const r = await fetchPage('https://example.com/', { fetchImpl: (async () => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } })) as never, lookup: publicLookup, maxBytes: 100_000 });
  assert.equal(r.ok, true);
  if (r.ok) assert.ok(r.text.length <= 100_000 + 200);
});

test('A7: HTML becomes text without scripts', async () => {
  const r = await fetchPage('https://example.com/', { fetchImpl: okFetch as never, lookup: publicLookup });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.text.includes('Hello & welcome'));
    assert.ok(!r.text.includes('evil()'));
  }
});
