import type { Logger } from '../logger.ts';

export type InterruptionLevel = 'passive' | 'active' | 'time-sensitive';

export interface PushPayload {
  title: string;
  body: string;
  /** Groups notifications in Notification Center; we use the symbol. */
  threadId: string;
  /** Notification category registered by the app; drives action buttons. */
  category: string;
  /** Newer pushes with the same id replace older ones on the device. */
  collapseId?: string;
  interruptionLevel: InterruptionLevel;
  /** Custom keys delivered alongside `aps`. */
  data: Record<string, string | number | boolean | null>;
}

export interface PushTarget {
  token: string;
  environment: 'sandbox' | 'production';
}

export type SendResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      reason: string;
      /** The token is dead; the caller should forget the device. */
      unregister: boolean;
      /** A later attempt may succeed. */
      retryable: boolean;
    };

export interface Notifier {
  send(target: PushTarget, payload: PushPayload): Promise<SendResult>;
  close(): Promise<void>;
}

/** Development notifier: prints the push instead of sending it. */
export class LogNotifier implements Notifier {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<SendResult> {
    this.logger.info('push (log notifier)', {
      token: target.token.slice(0, 8) + '…',
      environment: target.environment,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    });
    return { ok: true };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
