import type { PriceTick } from '../domain/price-book.ts';

export type TickListener = (tick: PriceTick) => void;

export interface PriceFeed {
  readonly name: string;
  /** Higher wins in the price book when two feeds price the same symbol. */
  readonly priority: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Replace the full set of symbols the feed should deliver. */
  setSymbols(symbols: readonly string[]): void;
  supports(symbol: string): boolean;
  onTick(listener: TickListener): void;
  /** One-off REST lookup for symbols nobody is streaming yet. */
  quote(symbol: string): Promise<PriceTick | undefined>;
}

/** Minimal WebSocket surface so tests can inject a fake and we do not depend on DOM typings. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export const WS_OPEN = 1;

export function globalWebSocket(): WebSocketConstructor {
  const ctor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!ctor) throw new Error('No global WebSocket implementation; Node 22 or newer is required');
  return ctor;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export function globalFetch(): FetchLike {
  return (url, init) => fetch(url, init);
}
