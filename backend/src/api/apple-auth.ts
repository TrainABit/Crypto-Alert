import { createPublicKey, verify } from 'node:crypto';
import type { FetchLike } from '../feeds/feed.ts';
import { globalFetch } from '../feeds/feed.ts';

export interface AppleIdentity {
  sub: string;
  email: string | null;
}

export interface AppleIdTokenVerifier {
  verify(identityToken: string): Promise<AppleIdentity>;
}

export class AppleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppleAuthError';
  }
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

export interface AppleJwksVerifierOptions {
  /** Expected `aud`: the app's bundle id (or services id for web). */
  audience: string;
  jwksUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  cacheMs?: number;
}

const decodeSegment = (s: string): unknown => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/** Verifies Sign in with Apple identity tokens against Apple's published keys. */
export class AppleJwksVerifier implements AppleIdTokenVerifier {
  private readonly audience: string;
  private readonly jwksUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private keys: Map<string, Jwk> = new Map();
  private fetchedAt = 0;

  constructor(options: AppleJwksVerifierOptions) {
    this.audience = options.audience;
    this.jwksUrl = options.jwksUrl ?? 'https://appleid.apple.com/auth/keys';
    this.fetchImpl = options.fetchImpl ?? globalFetch();
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? 60 * 60 * 1000;
  }

  async verify(identityToken: string): Promise<AppleIdentity> {
    const parts = identityToken.split('.');
    if (parts.length !== 3) throw new AppleAuthError('malformed token');
    const [h, c, s] = parts as [string, string, string];
    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = decodeSegment(h) as { alg?: unknown; kid?: unknown };
      claims = decodeSegment(c) as Record<string, unknown>;
    } catch {
      throw new AppleAuthError('malformed token');
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AppleAuthError('unsupported token');

    const jwk = await this.key(header.kid);
    if (!jwk) throw new AppleAuthError('unknown signing key');
    const publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    const ok = verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'));
    if (!ok) throw new AppleAuthError('invalid signature');

    if (claims.iss !== 'https://appleid.apple.com') throw new AppleAuthError('unexpected issuer');
    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.audience) : aud === this.audience;
    if (!audOk) throw new AppleAuthError('unexpected audience');
    const exp = typeof claims.exp === 'number' ? claims.exp : 0;
    if (exp * 1000 <= this.now()) throw new AppleAuthError('token expired');
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new AppleAuthError('missing subject');
    return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : null };
  }

  private async key(kid: string): Promise<Jwk | undefined> {
    const stale = this.now() - this.fetchedAt > this.cacheMs;
    if (stale || !this.keys.has(kid)) await this.refresh();
    return this.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchImpl(this.jwksUrl);
    if (!res.ok) throw new AppleAuthError(`could not load Apple keys (HTTP ${res.status})`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, Jwk>();
    for (const k of body.keys ?? []) if (k && typeof k.kid === 'string') next.set(k.kid, k);
    this.keys = next;
    this.fetchedAt = this.now();
  }
}
