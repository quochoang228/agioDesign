import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl, parseDuckDuckGo } from '../../bridge/net.mjs';

test('isPrivateIp flags loopback, private, link-local and mapped addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('assertPublicUrl rejects non-http schemes and private hosts', async () => {
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /only http/);
  await assert.rejects(assertPublicUrl('not a url'), /invalid url/);
  await assert.rejects(assertPublicUrl('http://127.0.0.1:22/'), /private/);
  await assert.rejects(assertPublicUrl('http://[::1]/'), /private/);
  await assert.rejects(assertPublicUrl('http://localhost/'), /private/);
  const u = await assertPublicUrl('https://1.1.1.1/x');
  assert.equal(u.hostname, '1.1.1.1');
});

test('parseDuckDuckGo extracts results, unwraps uddg links and skips ads', () => {
  const html = `
    <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Ad</a>
    <a class="result__snippet">ad snippet</a>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">Example <b>A</b></a>
    <a class="result__snippet">First &amp; best</a>`;
  const results = parseDuckDuckGo(html);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/a');
  assert.equal(results[0].title, 'Example A');
  assert.equal(results[0].snippet, 'First & best');
});
