import type { Notifier, PushPayload, PushTarget, SendResult } from '../src/push/notifier.ts';
import type { FetchLike, WebSocketLike } from '../src/feeds/feed.ts';

/** Notifier that records every send and lets tests script the result per token. */
export class RecordingNotifier implements Notifier {
  sent: Array<{ target: PushTarget; payload: PushPayload }> = [];
  results = new Map<string, SendResult>();

  async send(target: PushTarget, payload: PushPayload): Promise<SendResult> {
    this.sent.push({ target, payload });
    return this.results.get(target.token) ?? { ok: true };
  }

  async close(): Promise<void> {}
}

/** Scriptable WebSocket. Tests drive open/message/close by hand. */
export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private handlers: Record<string, Array<(ev: any) => void>> = {};
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit('close', undefined);
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    (this.handlers[type] ??= []).push(listener);
  }

  emit(type: string, ev: unknown): void {
    for (const h of this.handlers[type] ?? []) h(ev);
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', undefined);
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  dropConnection(): void {
    this.readyState = 3;
    this.emit('close', undefined);
  }
}

/** fetch stand-in keyed by URL prefix. */
export function fakeFetch(routes: Record<string, () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const r = await handler();
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return Object.assign(fn, { calls });
}
