import http2 from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { ApnsConfig } from '../config.ts';
import type { Logger } from '../logger.ts';
import { silentLogger } from '../logger.ts';
import type { Notifier, PushPayload, PushTarget, SendResult } from './notifier.ts';
import { buildApnsBody } from './payload.ts';

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

/** Apple requires a fresh provider token at least every 60 minutes and at most every 20. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const base64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** Builds the ES256 JWT used for token based APNs authentication. */
export function createProviderToken(input: { teamId: string; keyId: string; key: KeyObject }, issuedAtSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: input.keyId }));
  const claims = base64url(JSON.stringify({ iss: input.teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key: input.key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Maps an APNs HTTP response to a SendResult. */
export function classifyApnsResponse(status: number, body: string): SendResult {
  if (status === 200) return { ok: true };
  let reason = 'Unknown';
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed.reason === 'string') reason = parsed.reason;
  } catch {
    /* body was not JSON */
  }
  const unregister = status === 410 || DEAD_TOKEN_REASONS.has(reason);
  const retryable = !unregister && (RETRYABLE_STATUSES.has(status) || reason === 'ExpiredProviderToken');
  return { ok: false, status, reason, unregister, retryable };
}

export interface ApnsClientOptions {
  logger?: Logger;
  now?: () => number;
  hosts?: { production: string; sandbox: string };
}

/**
 * APNs client over HTTP/2 with token based authentication.
 * One session per environment is kept open and recreated when it drops.
 */
export class ApnsClient implements Notifier {
  private readonly key: KeyObject;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly hosts: { production: string; sandbox: string };
  private token: { value: string; issuedAt: number } | null = null;
  private sessions: Partial<Record<PushTarget['environment'], http2.ClientHttp2Session>> = {};
  private readonly config: ApnsConfig;

  constructor(config: ApnsConfig, options: ApnsClientOptions = {}) {
    this.config = config;
    this.key = createPrivateKey(config.privateKey);
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.hosts = options.hosts ?? APNS_HOSTS;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<SendResult> {
    const body = JSON.stringify(buildApnsBody(payload));
    let result = await this.request(target, payload, body);
    if (!result.ok && result.reason === 'ExpiredProviderToken') {
      this.providerToken(true);
      result = await this.request(target, payload, body);
    }
    if (!result.ok) {
      this.logger.warn('apns send failed', { status: result.status, reason: result.reason, unregister: result.unregister });
    }
    return result;
  }

  async close(): Promise<void> {
    for (const session of Object.values(this.sessions)) session?.close();
    this.sessions = {};
  }

  private providerToken(force = false): string {
    const now = this.now();
    if (force || !this.token || now - this.token.issuedAt > TOKEN_LIFETIME_MS) {
      this.token = {
        value: createProviderToken({ teamId: this.config.teamId, keyId: this.config.keyId, key: this.key }, Math.floor(now / 1000)),
        issuedAt: now,
      };
    }
    return this.token.value;
  }

  private session(environment: PushTarget['environment']): http2.ClientHttp2Session {
    const existing = this.sessions[environment];
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(this.hosts[environment]);
    const drop = () => {
      if (this.sessions[environment] === session) delete this.sessions[environment];
    };
    session.on('error', (err) => {
      this.logger.warn('apns session error', { environment, err });
      drop();
    });
    session.on('close', drop);
    session.on('goaway', drop);
    this.sessions[environment] = session;
    return session;
  }

  private request(target: PushTarget, payload: PushPayload, body: string): Promise<SendResult> {
    return new Promise((resolve) => {
      let session: http2.ClientHttp2Session;
      try {
        session = this.session(target.environment);
      } catch (err) {
        resolve({ ok: false, status: 0, reason: `ConnectError: ${(err as Error).message}`, unregister: false, retryable: true });
        return;
      }
      const headers: http2.OutgoingHttpHeaders = {
        ':method': 'POST',
        ':path': `/3/device/${target.token}`,
        authorization: `bearer ${this.providerToken()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(this.now() / 1000) + 3600),
        'content-type': 'application/json',
      };
      if (payload.collapseId) headers['apns-collapse-id'] = payload.collapseId.slice(0, 64);

      let settled = false;
      const finish = (result: SendResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let req: http2.ClientHttp2Stream;
      try {
        req = session.request(headers);
      } catch (err) {
        finish({ ok: false, status: 0, reason: `RequestError: ${(err as Error).message}`, unregister: false, retryable: true });
        return;
      }
      let status = 0;
      let chunks = '';
      req.setEncoding('utf8');
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        finish({ ok: false, status: 0, reason: 'Timeout', unregister: false, retryable: true });
      });
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.on('data', (chunk: string) => {
        chunks += chunk;
      });
      req.on('end', () => finish(classifyApnsResponse(status, chunks)));
      req.on('error', (err) => finish({ ok: false, status: 0, reason: `StreamError: ${err.message}`, unregister: false, retryable: true }));
      req.end(body);
    });
  }
}
