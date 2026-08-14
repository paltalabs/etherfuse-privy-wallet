import {createPrivateKey, createSign, randomUUID} from 'node:crypto';
import type {
  KycLaunch,
  OfframpAnchorDetails,
  OnrampOrderState,
  OrderState,
  RampKycStatus,
  RampOrderStatus,
  RampProvider,
  RampQuote
} from './provider.js';
import {RampProviderError} from './provider.js';

export interface EtherfuseDeps {
  /** Sent RAW in `Authorization` — never with a `Bearer ` prefix (see `call` below). */
  apiKey: string;
  /** `NetworkConfig.etherfuse.apiBaseUrl` — sandbox vs. production, no trailing slash. */
  apiBaseUrl: string;
  /** `NetworkConfig.etherfuse.dashboardBaseUrl` — hosts the `/auth/launch` KYC form target. */
  dashboardBaseUrl: string;
  /** Etherfuse's chain token; only Stellar is wired in this codebase. */
  blockchain: 'stellar';
  /** `CODE:ISSUER` of the asset Etherfuse delivers/expects on this chain (`NetworkConfig.etherfuse.assetId`). */
  assetId: string;
  /** Must equal the Issuer URL registered in the Etherfuse dashboard's Partner JWT section. */
  jwtIssuer: string;
  /** Must match a `kid` in the JWKS registered at that dashboard's JWKS URL. */
  jwtKid: string;
  /** RSA PKCS8 private key PEM; `\n`-escaped newlines (the shape a `.env` value has) are accepted. */
  jwtPrivateKeyPem: string;
  /** injected for tests; default globalThis.fetch */
  fetchFn?: typeof fetch;
}

// `RampProviderError.message` is truncated to this length — the full raw
// provider body is never forwarded to a client.
const ERROR_MESSAGE_MAX_LENGTH = 300;

// The only scope the sandbox accepts for the hosted identity flow; any other
// value is rejected with `invalid_scope`
// (docs/evidence/etherfuse-sandbox-findings.md "## Launch JWT").
const KYC_LAUNCH_SCOPE = 'verification';
const KYC_LAUNCH_TARGET = '/idv';
const KYC_LAUNCH_PATH = '/auth/launch';
// ~5 minutes, matching the documented partner-JWT lifetime.
const KYC_LAUNCH_TTL_SECONDS = 300;

const KYC_STATUSES: readonly RampKycStatus[] = ['not_started', 'in_progress', 'submitted', 'approved', 'denied'];
const ORDER_STATUSES: readonly RampOrderStatus[] = [
  'created',
  'funded',
  'completed',
  'finalized',
  'failed',
  'refunded',
  'canceled'
];

interface EtherfuseQuoteResponse {
  quoteId: string;
  sourceAmount: string;
  destinationAmount: string;
  /** RFC 3339, exactly 2 minutes out. */
  expiresAt: string;
  exchangeRate: string;
  /** Denominated in the SOURCE asset. */
  feeAmount: string;
}

interface EtherfuseOnrampOrderResponse {
  onramp: {
    orderId: string;
    /** Always `''` for BRL — the CLABE-shaped response is reused for PIX. */
    depositClabe: string;
    depositAmount: string;
    depositBankName: string;
    depositAccountHolder: string;
  };
}

interface EtherfuseOfframpOrderResponse {
  offramp: {
    orderId: string;
    withdrawAnchorAccount: string;
    /** Base64 of 32 bytes. */
    withdrawMemo: string;
    withdrawMemoType: string;
  };
}

interface EtherfuseOrderReadResponse {
  orderId: string;
  status: string;
  /** Absent on completed ON-ramp orders; on off-ramp orders it is Etherfuse's own tx, not ours. */
  confirmedTxSignature?: string;
  /** Only present at `status: 'completed'` — absent on every other status (`docs/evidence/etherfuse-sandbox-findings.md` "## Fiat received & settlement"). Full provider precision, e.g. `"19.620062792064687229069147940"`. */
  amountInTokens?: string;
}

interface EtherfuseErrorBody {
  message?: string;
  error?: string;
  description?: string;
}

/**
 * Etherfuse error bodies are frequently a BARE JSON STRING (e.g. `"Organization
 * must be approved before adding a bank account"`,
 * docs/evidence/etherfuse-sandbox-findings.md "## Bank account (BRL/PIX)"),
 * and sometimes an object carrying `message`/`error`/`description`. Anything
 * else falls back to a truncated JSON dump so no non-2xx response is ever
 * swallowed silently. Always truncated — the raw body never reaches a client.
 */
function extractErrorMessage(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, ERROR_MESSAGE_MAX_LENGTH);
  if (body && typeof body === 'object') {
    const b = body as EtherfuseErrorBody;
    if (typeof b.message === 'string') return b.message.slice(0, ERROR_MESSAGE_MAX_LENGTH);
    if (typeof b.error === 'string') return b.error.slice(0, ERROR_MESSAGE_MAX_LENGTH);
    if (typeof b.description === 'string') return b.description.slice(0, ERROR_MESSAGE_MAX_LENGTH);
  }
  return JSON.stringify(body).slice(0, ERROR_MESSAGE_MAX_LENGTH);
}

interface ParsedDecimal {
  /** The value's digits with the decimal point removed. */
  digits: bigint;
  /** How many of those digits are fractional. */
  scale: number;
}

/**
 * Etherfuse amounts arrive as decimal strings, sometimes with a 27-digit tail
 * (`"19.620062792064687229069147940"`). Parsing them into (digits, scale)
 * keeps every conversion below on exact integer arithmetic — a float parse
 * would silently lose the tail and, worse, drift on multiplication.
 */
function parseDecimal(value: string): ParsedDecimal {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new Error(`expected a non-negative decimal string, got ${JSON.stringify(value)}`);
  const fraction = match[2] ?? '';
  return {digits: BigInt(`${match[1]}${fraction}`), scale: fraction.length};
}

/** Rescales an exact (digits, scale) decimal to integer cents, rounding as asked. */
function scaleToCents(digits: bigint, scale: number, mode: 'floor' | 'ceil'): number {
  if (scale <= 2) return Number(digits * 10n ** BigInt(2 - scale));
  const divisor = 10n ** BigInt(scale - 2);
  const truncated = digits / divisor;
  const hasRemainder = digits % divisor > 0n;
  return Number(mode === 'ceil' && hasRemainder ? truncated + 1n : truncated);
}

/**
 * A non-negative decimal string → integer cents. `floor` for anything the
 * merchant RECEIVES (never promise more than gets delivered), `ceil` for fees
 * (never understate what is charged). Exported for its own unit tests.
 */
export function decimalToCents(value: string, mode: 'floor' | 'ceil'): number {
  const {digits, scale} = parseDecimal(value);
  return scaleToCents(digits, scale, mode);
}

/**
 * Any status other than the five known ones reads as `in_progress`: an
 * unrecognized (or newly added) KYC state must never break a merchant's
 * onboarding-status call, and only `approved` ever unlocks anything, so
 * "unknown" is safely equivalent to "still verifying".
 */
function toKycStatus(value: unknown): RampKycStatus {
  const known = KYC_STATUSES.find((status) => status === value);
  return known ?? 'in_progress';
}

/**
 * Unlike a KYC status, an unrecognized ORDER status cannot be defaulted: the
 * value flows straight into the client envelope (`RampOrderStatusSchema`,
 * `@paltalabs/shared`) and every consumer branches on it, so an unknown value
 * is surfaced as a provider error instead of being guessed at.
 */
function toOrderStatus(value: unknown, reason: string): RampOrderStatus {
  const known = ORDER_STATUSES.find((status) => status === value);
  if (!known) throw new RampProviderError(reason, `unrecognized order status ${JSON.stringify(value)}`);
  return known;
}

function toRampQuote(json: EtherfuseQuoteResponse): RampQuote {
  return {
    quoteId: json.quoteId,
    // RFC 3339 in, epoch ms out — `RampQuote.expiresAt`'s contract.
    expiresAt: Date.parse(json.expiresAt),
    // Exact by construction (the service builds it from integer cents), so
    // the rounding mode never actually bites here.
    senderAmountCents: decimalToCents(json.sourceAmount, 'floor'),
    receiverAmountCents: decimalToCents(json.destinationAmount, 'floor'),
    flatFeeCents: decimalToCents(json.feeAmount, 'ceil'),
    commercialQuotation: Number(json.exchangeRate)
  };
}

/**
 * Runs a response-mapping function and converts any thrown error into a
 * `RampProviderError` tagged with the SAME `reason` as the call's own HTTP
 * failures. `provider.ts`'s `RampProviderError` doc comment promises this:
 * "Thrown ... on a non-2xx provider response OR malformed provider data" —
 * without this wrapper, a garbage decimal string (`parseDecimal` throws a
 * plain `Error`) would propagate as an unhandled rejection instead of the
 * client-safe 502 `ramp_provider_error` every other failure mode produces.
 * A `RampProviderError` thrown by the mapper itself (none currently do,
 * but a future one might) passes through unchanged rather than being
 * double-wrapped.
 */
function mapResponse<T, R>(json: T, mapFn: (json: T) => R, reason: string): R {
  try {
    return mapFn(json);
  } catch (err) {
    if (err instanceof RampProviderError) throw err;
    throw new RampProviderError(reason, err instanceof Error ? err.message : String(err));
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Production `RampProvider` for Etherfuse (BRL over PIX ↔ Stellar). Every
 * path/body/response mapping below is evidence-backed against a real sandbox
 * run — see `docs/evidence/etherfuse-sandbox-findings.md` and the proven call
 * pattern (`ef()`) in `api/scripts/spike-etherfuse.ts`. Full trace in
 * `docs/modules/api-ramp.md`.
 */
export function createEtherfuseProvider(deps: EtherfuseDeps): RampProvider {
  const {apiKey, apiBaseUrl, dashboardBaseUrl, blockchain, assetId, jwtIssuer, jwtKid, jwtPrivateKeyPem} = deps;
  const fetchFn = deps.fetchFn ?? globalThis.fetch;

  /**
   * Calls Etherfuse with the auth header every call needs, parses the JSON
   * body, and converts any non-2xx response into a `RampProviderError` tagged
   * with the call-site's sanitized `reason`. Never throws the raw fetch
   * `Response`, and never logs the API key or full request headers.
   *
   * The key goes in `Authorization` RAW: a `Bearer ` prefix is Etherfuse's
   * documented #1 cause of 401 (docs/evidence/etherfuse-sandbox-findings.md,
   * header note). Bodies are parsed tolerantly — `POST
   * /ramp/order/fiat_received` answers 200 with an empty body.
   */
  async function call<T>(method: string, path: string, body: unknown, reason: string): Promise<T> {
    const res = await fetchFn(`${apiBaseUrl}${path}`, {
      method,
      headers: {Authorization: apiKey, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new RampProviderError(reason, extractErrorMessage(json));
    return json as T;
  }

  /** Used by `getOrder` to poll an order's current state. */
  async function readOrder(orderId: string): Promise<EtherfuseOrderReadResponse> {
    return call<EtherfuseOrderReadResponse>('GET', `/ramp/order/${orderId}`, undefined, 'order_fetch_failed');
  }

  /** The `POST /ramp/quote` body, identical for both directions bar the asset pair. */
  async function createQuote(
    input: {customerId: string; walletAddress: string; sourceAmount: string},
    quoteAssets: {type: 'onramp' | 'offramp'; sourceAsset: string; targetAsset: string}
  ): Promise<RampQuote> {
    const json = await call<EtherfuseQuoteResponse>(
      'POST',
      '/ramp/quote',
      {
        // Client-generated (i.e. generated HERE, server-side — never supplied
        // by an API caller), same convention as `orderId`/`transactionId`.
        quoteId: randomUUID(),
        customerId: input.customerId,
        blockchain,
        quoteAssets,
        sourceAmount: input.sourceAmount,
        walletAddress: input.walletAddress
      },
      'quote_rejected'
    );
    return mapResponse(json, toRampQuote, 'quote_rejected');
  }

  return {
    async createOrganization({customerId, displayName, email}) {
      await call(
        'POST',
        '/ramp/organization',
        {
          id: customerId,
          displayName,
          // Only personal organizations are wired: the merchant IS the
          // verified individual (the /idv flow verifies a person).
          accountType: 'personal',
          userInfo: {email, displayName}
        },
        'organization_creation_failed'
      );
    },

    async getKycStatus(customerId) {
      const json = await call<{status?: string}>('GET', `/ramp/customer/${customerId}/kyc`, undefined, 'kyc_fetch_failed');
      return toKycStatus(json.status);
    },

    buildKycLaunch(customerId, userInfo) {
      const now = Math.floor(Date.now() / 1000);
      // RS256, NOT ES256: the sandbox rejects ES256 outright ("Disallowed
      // signature algorithm: algorithm `ES256` is not one of: RS256"),
      // despite JWKS being an open format
      // (docs/evidence/etherfuse-sandbox-findings.md "## Launch JWT").
      const header = {alg: 'RS256', typ: 'JWT', kid: jwtKid};
      const payload = {
        iss: jwtIssuer,
        // Anything other than the customer's own organization id registers a
        // brand-new person on Etherfuse's side.
        sub: customerId,
        aud: `${apiBaseUrl}/auth/token`,
        scope: KYC_LAUNCH_SCOPE,
        jti: randomUUID(),
        // `email` and `name` are REQUIRED claims (live-verified), and
        // Etherfuse exposes no way to read a personal org's registered email
        // back — so the caller supplies them on every launch. The claim is
        // informational: the address the /idv flow actually confirms is the
        // one the organization was created with, so a caller who lies here
        // only affects their own session.
        email: userInfo.email,
        name: userInfo.displayName,
        iat: now,
        exp: now + KYC_LAUNCH_TTL_SECONDS
      };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      // A PEM read out of `.env` carries literal `\n` two-character
      // sequences; a real multi-line PEM is unaffected by this replace.
      const key = createPrivateKey(jwtPrivateKeyPem.replace(/\\n/g, '\n'));
      const signature = createSign('SHA256').update(signingInput).sign(key);
      return {
        actionUrl: `${dashboardBaseUrl}${KYC_LAUNCH_PATH}`,
        assertion: `${signingInput}.${b64url(signature)}`,
        target: KYC_LAUNCH_TARGET
      } satisfies KycLaunch;
    },

    async registerBankAccount(customerId, input) {
      // The BRL fields nest under `account` — the flat shape is not accepted
      // (docs/evidence/etherfuse-sandbox-findings.md "## Bank account
      // (BRL/PIX)").
      const json = await call<{bankAccountId: string}>(
        'POST',
        `/ramp/customer/${customerId}/bank-account`,
        {account: input},
        'bank_account_registration_failed'
      );
      return {bankAccountId: json.bankAccountId};
    },

    async registerWallet(customerId, publicKey) {
      // claimOwnership is LOAD-BEARING: without it the wallet's own kycStatus
      // stays `not_started` even after the org is approved, and every order
      // 400s with "Terms and conditions have not been completed for the
      // selected wallet" (docs/evidence/etherfuse-sandbox-findings.md
      // "## Wallet registration").
      const json = await call<{walletId: string}>(
        'POST',
        `/ramp/customer/${customerId}/wallet`,
        {publicKey, blockchain, claimOwnership: true},
        'wallet_registration_failed'
      );
      return {walletId: json.walletId};
    },

    async createOnrampQuote({customerId, walletAddress, amountBrl}) {
      return createQuote({customerId, walletAddress, sourceAmount: amountBrl}, {
        type: 'onramp',
        sourceAsset: 'BRL',
        targetAsset: assetId
      });
    },

    async createOfframpQuote({customerId, walletAddress, amountToken}) {
      return createQuote({customerId, walletAddress, sourceAmount: amountToken}, {
        type: 'offramp',
        sourceAsset: assetId,
        targetAsset: 'BRL'
      });
    },

    async createOnrampOrder(input) {
      // Maps ONLY the create response — no follow-up read. The create
      // response carries ONLY the deposit block (no status, no settlement
      // amount, docs/evidence/etherfuse-sandbox-findings.md "## Onramp order
      // & deposit payload"); status is implicitly `created`, and the
      // settlement amount is the caller's own (already-quoted) figure, never
      // derived here — see `OnrampOrderState`'s doc comment
      // (`provider.ts`) for why a read-back was rejected.
      const created = await call<EtherfuseOnrampOrderResponse>('POST', '/ramp/order', input, 'order_rejected');

      return {
        orderId: created.onramp.orderId,
        // `depositClabe` is always '' for BRL — dropped rather than exposed
        // as an always-empty field.
        deposit: {
          depositAmount: created.onramp.depositAmount,
          depositBankName: created.onramp.depositBankName,
          depositAccountHolder: created.onramp.depositAccountHolder
        }
      } satisfies OnrampOrderState;
    },

    async createAnchorOfframpOrder(input) {
      const json = await call<EtherfuseOfframpOrderResponse>(
        'POST',
        '/ramp/order',
        {...input, useAnchor: true},
        'order_rejected'
      );
      // The memo type is the one thing the caller cannot recover from getting
      // wrong (it decides `Memo.hash` vs `Memo.text`), so it is validated
      // here rather than asserted downstream.
      if (json.offramp.withdrawMemoType !== 'hash') {
        throw new RampProviderError(
          'order_rejected',
          `anchor order returned memo type ${JSON.stringify(json.offramp.withdrawMemoType)}, expected "hash"`
        );
      }
      return {
        orderId: json.offramp.orderId,
        withdrawAnchorAccount: json.offramp.withdrawAnchorAccount,
        withdrawMemoBase64: json.offramp.withdrawMemo,
        withdrawMemoType: 'hash'
      } satisfies OfframpAnchorDetails;
    },

    async getOrder(orderId) {
      const json = await readOrder(orderId);
      return {
        orderId: json.orderId,
        status: toOrderStatus(json.status, 'order_fetch_failed'),
        txHash: json.confirmedTxSignature ?? null,
        // Raw echo, no rounding here — see OrderState.amountTokens's doc
        // comment for why truncation is the CALLER's job, not this mapping's.
        amountTokens: json.amountInTokens ?? null
      } satisfies OrderState;
    },

    async simulateFiatReceived(orderId) {
      await call('POST', '/ramp/order/fiat_received', {orderId}, 'simulate_failed');
    }
  };
}
