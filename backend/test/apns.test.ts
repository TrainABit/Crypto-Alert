import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { classifyApnsResponse, createProviderToken } from '../src/push/apns.ts';

test('createProviderToken produces an ES256 JWT that verifies with the public key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const token = createProviderToken({ teamId: 'TEAM123456', keyId: 'KEY1234567', key: privateKey }, 1_700_000_000);
  const [h, c, s] = token.split('.');
  assert.ok(h && c && s);
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(header, { alg: 'ES256', kid: 'KEY1234567' });
  assert.deepEqual(claims, { iss: 'TEAM123456', iat: 1_700_000_000 });
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});

test('classifyApnsResponse maps dead tokens, retryable errors and success', () => {
  assert.deepEqual(classifyApnsResponse(200, ''), { ok: true });
  assert.deepEqual(classifyApnsResponse(410, '{"reason":"Unregistered"}'), {
    ok: false, status: 410, reason: 'Unregistered', unregister: true, retryable: false,
  });
  assert.deepEqual(classifyApnsResponse(400, '{"reason":"BadDeviceToken"}'), {
    ok: false, status: 400, reason: 'BadDeviceToken', unregister: true, retryable: false,
  });
  assert.deepEqual(classifyApnsResponse(403, '{"reason":"ExpiredProviderToken"}'), {
    ok: false, status: 403, reason: 'ExpiredProviderToken', unregister: false, retryable: true,
  });
  assert.deepEqual(classifyApnsResponse(503, 'not json'), {
    ok: false, status: 503, reason: 'Unknown', unregister: false, retryable: true,
  });
  assert.deepEqual(classifyApnsResponse(400, '{"reason":"BadTopic"}'), {
    ok: false, status: 400, reason: 'BadTopic', unregister: false, retryable: false,
  });
});
