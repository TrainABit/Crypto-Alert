import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AppleJwksVerifier } from '../src/api/apple-auth.ts';
import { fakeFetch } from './fakes.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string; kty: string };
const NOW = 1_800_000_000_000;

function makeToken(claims: Record<string, unknown>, kid = 'kid-1'): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid })}.${enc(claims)}`;
  const sig = sign('sha256', Buffer.from(data), privateKey).toString('base64url');
  return `${data}.${sig}`;
}

const claims = { iss: 'https://appleid.apple.com', aud: 'com.example.app', exp: NOW / 1000 + 600, sub: 'apple-user-1', email: 'x@privaterelay.appleid.com' };

test('verifies a valid Apple identity token and caches keys', async () => {
  const fetchImpl = fakeFetch({ 'https://appleid.apple.com/auth/keys': () => ({ status: 200, body: { keys: [{ kid: 'kid-1', ...jwk, alg: 'RS256', use: 'sig' }] } }) });
  const verifier = new AppleJwksVerifier({ audience: 'com.example.app', fetchImpl, now: () => NOW });
  assert.deepEqual(await verifier.verify(makeToken(claims)), { sub: 'apple-user-1', email: 'x@privaterelay.appleid.com' });
  await verifier.verify(makeToken(claims));
  assert.equal(fetchImpl.calls.length, 1, 'keys are cached');
  await assert.rejects(verifier.verify(makeToken(claims, 'kid-unknown')), /unknown signing key/);
  assert.equal(fetchImpl.calls.length, 2, 'an unknown kid triggers one refresh');
});

test('rejects wrong audience, issuer, expiry, signature and shape', async () => {
  const fetchImpl = fakeFetch({ 'https://appleid.apple.com/auth/keys': () => ({ status: 200, body: { keys: [{ kid: 'kid-1', ...jwk }] } }) });
  const verifier = new AppleJwksVerifier({ audience: 'com.example.app', fetchImpl, now: () => NOW });
  await assert.rejects(verifier.verify(makeToken({ ...claims, aud: 'com.other' })), /audience/);
  await assert.rejects(verifier.verify(makeToken({ ...claims, iss: 'https://evil' })), /issuer/);
  await assert.rejects(verifier.verify(makeToken({ ...claims, exp: NOW / 1000 - 1 })), /expired/);
  const good = makeToken(claims);
  await assert.rejects(verifier.verify(good.slice(0, -4) + 'AAAA'), /signature/);
  await assert.rejects(verifier.verify('not.a.jwt.at.all'), /malformed/);
  assert.deepEqual(await verifier.verify(makeToken({ ...claims, aud: ['x', 'com.example.app'] })), { sub: 'apple-user-1', email: 'x@privaterelay.appleid.com' });
});
