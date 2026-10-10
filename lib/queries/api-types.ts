// API response shapes (/api/* route handlers).
// NOTE: lib/types.ts (the shared contract) did not exist when this was written. These types should
// be moved into lib/types.ts (or re-exported from it) once that file lands; route handlers and UI
// should import them from there.
// All money values are USD. All timestamps are unix SECONDS.

export type Chain = 'ethereum' | 'arbitrum';
export const CHAINS: Chain[] = ['ethereum', 'arbitrum'];

export type HistoryRange = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';
export type ChangeWindow = '24h' | '7d' | '30d' | '1y';
export type GroupBy = 'none' | 'chain' | 'wallet' | 'protocol';
export type Scope = { kind: 'all' } | { kind: 'wallet'; walletId: number } | { kind: 'address'; address: string };

export interface Change {
  /** usd now minus usd then; null when there is no data at or before the reference time */
  abs: number | null;
  /** fraction (0.0127 = +1.27%); null when then is missing or zero */
  pct: number | null;
  /** portfolio value at the reference time */
  fromUsd: number | null;
  /** reference time used (now - window) */
  fromTs: number;
}

export type Changes = Record<ChangeWindow, Change>;

export interface Breakdown {
  key: string;
  label: string;
  usd: number;
  /** usd / sum of positive values in this breakdown (0..1); negative entries get a negative share */
  share: number;
}

export interface Totals {
  netUsd: number;
  /** wallet tokens + supplied (positive balances) */
  assetsUsd: number;
  /** borrowed, as a positive number */
  debtUsd: number;
  walletUsd: number;
  /** net value held in protocols (supplied - borrowed) */
  protocolUsd: number;
}

export interface BackfillProgress {
  doneDays: number;
  totalDays: number;
  /** 0..1, 1 when nothing to do */
  pct: number;
  /** earliest history start (unix s) across chains, null if unknown yet */
  startTs: number | null;
  complete: boolean;
  chains: { chain: Chain; doneDays: number; totalDays: number; startTs: number | null; startBlock: number | null; error: string | null }[];
  /** last backfill problem for this address (e.g. first activity could not be determined), null when fine */
  error: string | null;
}

export interface AddressSummary {
  id: number;
  address: string;
  label: string | null;
  chains: Chain[];
  isContract: Partial<Record<Chain, boolean>>;
  excluded: boolean;
  createdAt: number | null;
  wallets: { id: number; name: string }[];
  usd: number;
  change24h: Change;
  lastSnapshotAt: number | null;
  backfill: BackfillProgress;
}

export interface WalletSummary {
  id: number;
  name: string;
  color: string | null;
  sort: number;
  excluded: boolean;
  createdAt: number | null;
  addressCount: number;
  /** full value of the wallet's (non excluded) addresses; shared addresses count in every wallet they belong to */
  usd: number;
  change24h: Change;
}

export interface TopToken {
  /** canonical asset key (price key), e.g. coingecko:ethereum */
  key: string;
  symbol: string;
  name: string | null;
  logo: string | null;
  chains: Chain[];
  /** net amount: wallet + supplied - borrowed */
  amount: number;
  price: number | null;
  /** net usd (debt negative) */
  usd: number;
  walletUsd: number;
  suppliedUsd: number;
  /** positive number */
  borrowedUsd: number;
  share: number;
  /** units held (wallet + supplied), >= 0 */
  heldAmount?: number;
  /** units borrowed, >= 0 */
  borrowedAmount?: number;
  /** current borrow APY for this asset as a fraction, when borrowed on Aave */
  borrowApy?: number | null;
}

export interface AavePositionSummary {
  addressId: number;
  address: string;
  label: string | null;
  market: string;
  chain: Chain;
  suppliedUsd: number;
  /** positive number */
  borrowedUsd: number;
  netUsd: number;
  /** null = infinite (no debt) or unknown */
  healthFactor: number | null;
  /** fractions; null when unknown (rates not yet captured) */
  supplyApy?: number | null;
  borrowApy?: number | null;
  netApy?: number | null;
  ltvUsed?: number | null;
  liquidations?: LiquidationPoint[];
}

export interface AaveSummary {
  suppliedUsd: number;
  borrowedUsd: number;
  netUsd: number;
  lowestHealthFactor: number | null;
  positions: AavePositionSummary[];
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface JobInfo {
  id: number;
  type: string;
  payload: unknown;
  status: string;
  progress: number | null;
  total: number | null;
  error: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface JobsSummary {
  pending: number;
  running: number;
  failed: number;
  active: JobInfo[];
  backfill: { doneDays: number; totalDays: number; pct: number; complete: boolean };
}

export type PnlWindow = '24h' | '7d' | '30d' | '90d' | '1y' | 'all';

/**
 * Holdings-based PnL for one window. pnlUsd = sum over consecutive history points of
 * amount_at_earlier_point x (price_now - price_then) per (address, chain, token); debt rows count
 * negative, aTokens priced at their underlying. Transfers between tracked addresses therefore never
 * show as profit or loss.
 */
export interface PnlPeriod {
  window: PnlWindow;
  /** unix seconds of the first point used, null when there is no history in the window */
  fromTs: number | null;
  /** net worth at fromTs */
  startUsd: number | null;
  endUsd: number;
  /** endUsd - startUsd */
  changeUsd: number | null;
  /** price PnL */
  pnlUsd: number | null;
  /**
   * Return on invested capital as a fraction (0.0127 = +1.27%): pnlUsd / (startUsd + peak cumulative
   * net deposits in the window). Equals pnlUsd / startUsd when nothing was deposited; null when that
   * capital is below $1.
   */
  returnPct: number | null;
  /** changeUsd - pnlUsd: deposits, withdrawals, Aave interest and fees (mixed bucket) */
  otherUsd: number | null;
  /** largest contributors to pnlUsd by canonical asset, sorted by |pnlUsd| desc, max 5 */
  byAsset: { asset: string; symbol: string; pnlUsd: number }[];
}

export type PnlSummary = Record<PnlWindow, PnlPeriod>;

/** Liquidation estimate for one collateral asset, other assets held constant. */
export interface LiquidationPoint {
  addressId: number;
  market: string;
  chain: Chain;
  /** canonical asset id, e.g. 'ETH', 'BTC' */
  asset: string;
  symbol: string;
  price: number;
  liquidationPrice: number | null;
  /** fraction the price can fall before HF hits 1 (0.40 = 40%); null when not liquidatable by this asset */
  dropPct: number | null;
}

export interface NetExposure {
  /** canonical asset id, e.g. 'ETH', 'BTC', 'USD' */
  asset: string;
  symbol: string;
  /** wallet + supplied - borrowed, in units of the asset */
  amount: number;
  usd: number;
}

export interface RiskSummary {
  /** gross assets / net worth; null when net worth <= 0 */
  leverage: number | null;
  /** total debt / total borrowing power (collateral x LTV) across Aave positions; null without debt */
  ltvUsed: number | null;
  /** APYs as fractions, weighted by supplied / borrowed USD */
  supplyApy: number | null;
  borrowApy: number | null;
  /** (supply interest - borrow interest) per year / Aave net equity */
  netApy: number | null;
  /** expected interest per year in USD at current rates (can be negative) */
  annualYieldUsd: number | null;
  /** the most critical liquidation point (smallest dropPct) across positions, if any */
  liquidation: LiquidationPoint | null;
  liquidations: LiquidationPoint[];
  netExposure: NetExposure[];
  /** stablecoin share of gross assets, fraction */
  stableShare: number | null;
  /** all-time high of net worth in this scope */
  ath: { usd: number; ts: number } | null;
  /** (current - ath) / ath, fraction <= 0 */
  drawdownPct: number | null;
}

export interface PortfolioView {
  totals: Totals;
  change: Changes;
  pnl: PnlSummary;
  risk: RiskSummary;
  /** external deposits / withdrawals from the transactions ledger (transfers between tracked addresses excluded); null until ingested */
  flows?: FlowSummary | null;
  byChain: Breakdown[];
  byProtocol: Breakdown[];
  byWallet: WalletSummary[];
  topTokens: TopToken[];
  aave: AaveSummary;
  lastSnapshotAt: number | null;
  jobs: JobsSummary;
}

export type OverviewResponse = PortfolioView;

export interface WalletDetailResponse extends PortfolioView {
  wallet: WalletSummary;
  addresses: AddressSummary[];
}

export interface WalletWithAddresses extends WalletSummary {
  addresses: AddressSummary[];
}

export interface WalletsResponse {
  wallets: WalletWithAddresses[];
}

export interface TokenRow {
  chain: Chain;
  /** token contract (lowercase), 0x000..0 for native */
  token: string;
  symbol: string;
  name: string | null;
  logo: string | null;
  decimals: number | null;
  priceKey: string | null;
  price: number | null;
  amount: number;
  amountRaw: string | null;
  /** negative for borrowed rows */
  usd: number;
  spam: boolean;
}

export interface ProtocolPosition {
  protocol: 'aave-v3';
  market: string;
  chain: Chain;
  supplied: TokenRow[];
  borrowed: TokenRow[];
  suppliedUsd: number;
  borrowedUsd: number;
  netUsd: number;
  healthFactor: number | null;
  collateralUsd: number | null;
  debtUsd: number | null;
}

export interface AddressDetailResponse {
  address: AddressSummary;
  totals: Totals;
  change: Changes;
  chains: Breakdown[];
  wallet: { usd: number; tokens: TokenRow[] };
  protocols: ProtocolPosition[];
  hidden: { count: number; tokens: TokenRow[] };
  backfill: BackfillProgress;
  lastSnapshotAt: number | null;
}

export interface HistoryPoint {
  t: number;
  total: number;
  series: Record<string, number>;
  /** true when a held token had no historical price that day (it is counted as $0) */
  partial?: boolean;
  /** gross asset value (wallet + supplied, debt NOT subtracted) = the unleveraged line */
  assetsUsd?: number;
  /** positive number; total - assetsUsd = -debtUsd */
  debtUsd?: number;
}

export interface HistoryResponse {
  scope: string;
  range: HistoryRange;
  groupBy: GroupBy;
  from: number;
  to: number;
  /**
   * Series keys in stacking order. groupBy=wallet: one key per wallet id with the wallet's color (or
   * a stable palette color); an address shared by several wallets is stacked under the lowest wallet
   * id in scope only, so the layers always add up to `total`.
   */
  keys: { key: string; label: string; color: string | null }[];
  points: HistoryPoint[];
}

export interface PricesResponse {
  range: HistoryRange;
  series: Record<string, { t: number; usd: number }[]>;
}

export interface FxResponse {
  latest: { day: string; usdChf: number } | null;
  daily: Record<string, number>;
}

export interface HealthResponse {
  ok: boolean;
  lastSnapshotAt: number | null;
  workerHeartbeatAt: number | null;
  dbSizeBytes: number;
}

export interface JobsResponse {
  jobs: JobInfo[];
  summary: JobsSummary;
  addresses: { id: number; address: string; label: string | null; backfill: BackfillProgress }[];
}

export interface SyncResponse {
  jobIds: number[];
}

export interface AddAddressResponse {
  address: AddressSummary;
  jobIds: number[];
  created: boolean;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// ---------- transactions ledger ----------

export type TxKind =
  | 'receive'
  | 'send'
  | 'internal'
  | 'swap'
  | 'aave-supply'
  | 'aave-withdraw'
  | 'aave-borrow'
  | 'aave-repay'
  | 'approval'
  | 'spam'
  | 'other';

export interface TxTransfer {
  /** token contract, zero address for native */
  token: string;
  symbol: string;
  logo: string | null;
  /** units, always positive; direction says which way it moved for the tracked side */
  amount: number;
  /** value at the time of the transaction (daily price), null when unpriced */
  usd: number | null;
  direction: 'in' | 'out' | 'internal';
  from: string;
  to: string;
  /** label of a tracked address (address label, else wallet name), null for external */
  fromLabel: string | null;
  toLabel: string | null;
  fromOwn: boolean;
  toOwn: boolean;
}

export interface TxRow {
  /** `${chain}:${hash}` */
  id: string;
  chain: Chain;
  hash: string;
  /** unix seconds */
  ts: number;
  block: number;
  kind: TxKind;
  /** tracked addresses involved */
  addressIds: number[];
  transfers: TxTransfer[];
  /** main external counterparty, null for internal / protocol-only */
  counterparty: string | null;
  counterpartyLabel: string | null;
  /** value moved in (+) or out (-) of the scope at the time; 0 for internal; null when unpriced */
  netUsd: number | null;
  /** gas paid by a tracked address, null when not known */
  feeUsd: number | null;
  explorerUrl: string;
}

export interface FlowSummary {
  /** external value received (USD at the time), excluding transfers between tracked addresses and protocol (Aave) movements */
  depositsUsd: number;
  /** positive number */
  withdrawalsUsd: number;
  netDepositsUsd: number;
  /** unix seconds of the first ledger entry */
  sinceTs: number | null;
}

export interface TransactionsResponse {
  items: TxRow[];
  /** opaque cursor for the next page, null at the end */
  nextCursor: string | null;
  flows: FlowSummary | null;
  /** true while the ledger backfill for some address in scope is still running */
  syncing: boolean;
}
