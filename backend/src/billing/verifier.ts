import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type JWSRenewalInfoDecodedPayload,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';
import type { AppStoreConfig } from '../config.ts';
import type { Logger } from '../logger.ts';

export type TransactionType = 'auto_renewable' | 'non_consumable' | 'consumable' | 'non_renewing' | 'unknown';

export interface VerifiedTransaction {
  originalTransactionId: string;
  transactionId: string;
  productId: string;
  bundleId: string | null;
  type: TransactionType;
  purchaseDate: Date;
  expiresDate: Date | null;
  revocationDate: Date | null;
  environment: string;
  /** UUID the app attached at purchase time; we use the user id. */
  appAccountToken: string | null;
}

export interface VerifiedRenewalInfo {
  autoRenewStatus: boolean | null;
  isInBillingRetryPeriod: boolean;
  gracePeriodExpiresDate: Date | null;
}

export interface VerifiedNotification {
  notificationType: string;
  subtype: string | null;
  environment: string | null;
  transaction: VerifiedTransaction | null;
  renewalInfo: VerifiedRenewalInfo | null;
}

export interface AppStoreVerifier {
  verifyTransaction(jws: string): Promise<VerifiedTransaction>;
  verifyNotification(signedPayload: string): Promise<VerifiedNotification>;
}

export class VerificationError extends Error {
  readonly status: string;

  constructor(status: string, message: string) {
    super(message);
    this.name = 'VerificationError';
    this.status = status;
  }
}

const TYPE_MAP: Record<string, TransactionType> = {
  'Auto-Renewable Subscription': 'auto_renewable',
  'Non-Consumable': 'non_consumable',
  Consumable: 'consumable',
  'Non-Renewing Subscription': 'non_renewing',
};

const msToDate = (v: number | undefined): Date | null => (typeof v === 'number' ? new Date(v) : null);

/** Normalises Apple's decoded transaction into the shape the rest of the backend uses. */
export function mapTransaction(decoded: JWSTransactionDecodedPayload): VerifiedTransaction {
  if (!decoded.originalTransactionId || !decoded.transactionId || !decoded.productId) {
    throw new VerificationError('INCOMPLETE', 'transaction payload is missing identifiers');
  }
  return {
    originalTransactionId: decoded.originalTransactionId,
    transactionId: decoded.transactionId,
    productId: decoded.productId,
    bundleId: decoded.bundleId ?? null,
    type: TYPE_MAP[String(decoded.type ?? '')] ?? 'unknown',
    purchaseDate: msToDate(decoded.purchaseDate) ?? new Date(0),
    expiresDate: msToDate(decoded.expiresDate),
    revocationDate: msToDate(decoded.revocationDate),
    environment: String(decoded.environment ?? 'Unknown'),
    appAccountToken: decoded.appAccountToken ?? null,
  };
}

export function mapRenewalInfo(decoded: JWSRenewalInfoDecodedPayload): VerifiedRenewalInfo {
  return {
    autoRenewStatus: decoded.autoRenewStatus === undefined ? null : Number(decoded.autoRenewStatus) === 1,
    isInBillingRetryPeriod: decoded.isInBillingRetryPeriod === true,
    gracePeriodExpiresDate: msToDate(decoded.gracePeriodExpiresDate),
  };
}

export function loadRootCertificates(dir: string): Buffer[] {
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.cer') || f.toLowerCase().endsWith('.der'))
    .sort()
    .map((f) => readFileSync(join(dir, f)));
}

/** Production verifier backed by Apple's official library and root certificates. */
export class AppleAppStoreVerifier implements AppStoreVerifier {
  private readonly verifier: SignedDataVerifier;
  private readonly logger: Logger;

  constructor(config: AppStoreConfig, logger: Logger, rootCertificates = loadRootCertificates(config.rootCertsDir)) {
    if (rootCertificates.length === 0) {
      throw new Error(`no Apple root certificates found in ${config.rootCertsDir}`);
    }
    const environment = config.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX;
    this.verifier = new SignedDataVerifier(rootCertificates, true, environment, config.bundleId, config.appAppleId);
    this.logger = logger;
  }

  async verifyTransaction(jws: string): Promise<VerifiedTransaction> {
    try {
      return mapTransaction(await this.verifier.verifyAndDecodeTransaction(jws));
    } catch (err) {
      throw this.wrap(err);
    }
  }

  async verifyNotification(signedPayload: string): Promise<VerifiedNotification> {
    let decoded: ResponseBodyV2DecodedPayload;
    try {
      decoded = await this.verifier.verifyAndDecodeNotification(signedPayload);
    } catch (err) {
      throw this.wrap(err);
    }
    const data = decoded.data;
    let transaction: VerifiedTransaction | null = null;
    let renewalInfo: VerifiedRenewalInfo | null = null;
    try {
      if (data?.signedTransactionInfo) {
        transaction = mapTransaction(await this.verifier.verifyAndDecodeTransaction(data.signedTransactionInfo));
      }
      if (data?.signedRenewalInfo) {
        renewalInfo = mapRenewalInfo(await this.verifier.verifyAndDecodeRenewalInfo(data.signedRenewalInfo));
      }
    } catch (err) {
      throw this.wrap(err);
    }
    return {
      notificationType: String(decoded.notificationType ?? 'UNKNOWN'),
      subtype: decoded.subtype ? String(decoded.subtype) : null,
      environment: data?.environment ? String(data.environment) : null,
      transaction,
      renewalInfo,
    };
  }

  private wrap(err: unknown): VerificationError {
    if (err instanceof VerificationError) return err;
    if (err instanceof VerificationException) {
      const status = VerificationStatus[err.status] ?? 'FAILURE';
      this.logger.warn('app store verification failed', { status, cause: err.cause?.message });
      return new VerificationError(status, `App Store verification failed: ${status}`);
    }
    this.logger.warn('app store verification error', { err });
    return new VerificationError('FAILURE', (err as Error)?.message ?? 'verification failed');
  }
}
