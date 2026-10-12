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
  /**
   * changeUsd - pnlUsd - interestUsd + gasUsd: deposits and withdrawals (plus fees paid in tokens).
   * Without interestUsd / gasUsd (no yield data) it is changeUsd - pnlUsd and still holds interest.
   */
  otherUsd: number | null;
  /** largest contributors to pnlUsd by canonical asset, sorted by |pnlUsd| desc, max 5 */
  byAsset: { asset: string; symbol: string; pnlUsd: number }[];
  // ---------- YIELD + FX (optional, lib/queries/yield.ts, lib/queries/fx.ts) ----------
  /** net Aave interest in the window (earned - paid), USD at the time; negative when borrowing costs more */
  interestUsd?: number;
  /** gas paid by addresses of the scope in the window, positive USD (already part of changeUsd) */
  gasUsd?: number;
  /** true when interest was estimated from rates instead of measured (ledger or on-chain indices) */
  interestEstimated?: boolean;
  /** the same window in other display currencies (USD values converted at the day's rate) */
  currencies?: Partial<Record<FxCurrency, CurrencyPnl>>;
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
  /** Curve markets carry the loan detail in AddressDetailResponse.curve (health, soft liquidation) */
  protocol: 'aave-v3' | 'curve-crvusd' | 'llamalend';
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
  // ---------- YIELD + FX ----------
  /**
   * Unleveraged comparison line (USD): starts at the net worth of the range's first point and moves
   * by the price return of the gross assets only (wallet + supplied, as if held without debt) plus
   * the same deposits / withdrawals / interest the net worth gets. Equals total when there is no
   * debt; above total when leverage lost money, below when it gained. Set on every point.
   */
  unleveredUsd?: number;
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
  /**
   * Latest published day. usdChf is the legacy CHF field (same value as CHF); EUR / CHF are units of
   * the currency per USD (null when that currency has no rate yet). day = latest day of any currency.
   */
  latest: { day: string; usdChf: number; EUR?: number | null; CHF?: number | null } | null;
  /** legacy: USD -> CHF per day (YYYY-MM-DD). Use `rates.CHF` for new code. */
  daily: Record<string, number>;
  // ---------- YIELD + FX ----------
  /** units of the currency per USD per day (YYYY-MM-DD, every calendar day up to the last published one) */
  rates?: Record<FxCurrency, Record<string, number>>;
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
  // Curve crvUSD / LlamaLend loan actions (lib/ledger/classify.ts, legs with a controller / AMM / vault)
  | 'curve-borrow'
  | 'curve-repay'
  | 'curve-deposit'
  | 'curve-withdraw'
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
  /**
   * external value received (USD at the time): only value from externally owned accounts (and unpaired
   * Arbitrum bridge legs), netted per transaction. Transfers between tracked addresses, paired bridges,
   * protocol (Aave, Curve) movements, swaps and contract interactions never count (lib/ledger/classify.ts).
   */
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

// ---------- YIELD + FX (Aave rates, interest, gas, display currencies) ----------

/** Display currencies other than USD (all money is stored in USD). */
export type FxCurrency = 'EUR' | 'CHF';
export const FX_CURRENCIES: FxCurrency[] = ['EUR', 'CHF'];
export type DisplayCurrency = 'USD' | FxCurrency;

/**
 * One PnL window in a display currency C. All values are amounts of C (not USD); rates are units
 * of C per USD. change = end - start = market + fxEffect + interest - gas + other exactly.
 */
export interface CurrencyPnl {
  currency: FxCurrency;
  rateStart: number;
  rateEnd: number;
  /** net worth at the window start, converted at that day's rate */
  start: number;
  end: number;
  change: number;
  /** price PnL converted at each point's day */
  market: number;
  /** currency effect: net worth held x the change of the rate (USD gaining against C is positive) */
  fxEffect: number;
  /** net Aave interest converted per day; null without yield data (then it is inside other) */
  interest: number | null;
  /** gas converted per day, positive cost; null without yield data */
  gas: number | null;
  /** deposits / withdrawals (and interest / gas when those are null) */
  other: number;
}

export interface RatePoint {
  t: number;
  /** fractions (0.031 = 3.1%), null when unknown */
  supplyApy: number | null;
  borrowApy: number | null;
}

/** Rate history of one Aave reserve held (supplied or borrowed) by the scope in the range. */
export interface ReserveRateSeries {
  chain: Chain;
  market: string;
  /** underlying token (lowercase) */
  asset: string;
  symbol: string;
  supplied: boolean;
  borrowed: boolean;
  points: RatePoint[];
}

export interface RatesResponse {
  scope: string;
  range: HistoryRange;
  from: number;
  to: number;
  reserves: ReserveRateSeries[];
  /**
   * Scope net APY per point (fraction): (supplied usd x supply APY - borrowed usd x borrow APY) /
   * (supplied usd - borrowed usd) over the scope's Aave positions; null without positions or equity.
   */
  netApy: { t: number; netApy: number | null }[];
}

export interface YieldAsset {
  /** canonical asset id, e.g. 'ETH', 'USD' */
  asset: string;
  symbol: string;
  /** supply interest, USD at the time (positive = earned) */
  earnedUsd: number;
  /** borrow interest, USD at the time (positive = paid) */
  paidUsd: number;
}

export interface YieldBucket {
  /** bucket start (UTC day or Monday week start), unix seconds */
  t: number;
  earnedUsd: number;
  paidUsd: number;
  gasUsd: number;
  /** earned - paid - gas */
  netUsd: number;
  /** running sum of netUsd from the range start */
  cumulativeUsd: number;
}

export interface YieldResponse {
  scope: string;
  range: HistoryRange;
  from: number;
  to: number;
  /** supply interest, positive USD */
  earnedUsd: number;
  /** borrow interest, positive USD */
  paidUsd: number;
  /** gas paid by addresses of the scope (tx.fee_usd of transactions they sent), positive USD */
  gasUsd: number;
  /** earned - paid - gas */
  netUsd: number;
  /**
   * How interest was measured: 'ledger' (balance change minus supplies / withdrawals / borrows /
   * repays from the transactions ledger), 'index' (balance x growth of the on-chain reserve index),
   * 'estimate' (balance x APY x time), 'mixed' when segments used different methods, 'none' without
   * Aave positions.
   */
  method: 'ledger' | 'index' | 'estimate' | 'mixed' | 'none';
  /** true when any part used the APY estimate */
  estimated: boolean;
  /** false until the ledger has been ingested for an address of the scope (gas is then 0) */
  gasKnown: boolean;
  byAsset: YieldAsset[];
  bucket: 'day' | 'week';
  buckets: YieldBucket[];
}

// ---------- LEDGER: smart wallet suggestions (GET / POST /api/suggestions) ----------

/** 'safe' = Safe transaction service owners lookup, 'dsproxy' = DeFi Saver / Maker DSProxy registry. */
export type SuggestionSource = 'safe' | 'dsproxy';

/** A smart wallet (Safe, DSProxy) owned by a tracked EOA that is not tracked yet on `chain`. */
export interface WalletSuggestion {
  id: number;
  /** lowercase */
  address: string;
  chain: Chain;
  source: SuggestionSource;
  /** the tracked EOA that owns it */
  owner: { addressId: number; address: string; label: string | null };
  /** wallets the address is added to on accept (the owner's wallets) */
  wallets: { id: number; name: string }[];
  /** unix seconds */
  createdAt: number | null;
}

export interface SuggestionsResponse {
  suggestions: WalletSuggestion[];
}

export interface SuggestionActionResponse {
  id: number;
  status: 'accepted' | 'dismissed';
  /** the tracked address after accepting, null on dismiss */
  addressId: number | null;
  /** discovery / live jobs enqueued for the added address */
  jobIds: number[];
}

// ---------- CRVUSD: Curve crvUSD mint markets and LlamaLend (lib/protocols/curve-crvusd.ts) ----------
// Balance rows of these positions use protocol 'curve-crvusd' (mint) or 'llamalend' and the generic
// sides (supply = collateral and soft liquidation part, borrow = debt), so totals, PnL, history and net
// exposure include them without the fields below. The fields below carry the protocol specific detail.

export type CurveProtocolKey = 'curve-crvusd' | 'llamalend';

/** One Curve crvUSD / LlamaLend loan of an address (from curve_positions of the current slice). */
export interface CurvePositionInfo {
  addressId: number;
  chain: Chain;
  protocol: CurveProtocolKey;
  /** market key, e.g. eth-crvusd-3-weth (also tokens.market of the position rows) */
  market: string;
  collateralSymbol: string;
  borrowedSymbol: string;
  /** collateral units */
  collateral: number;
  /** borrowed token units held in the AMM bands (soft liquidation), 0 outside soft liquidation */
  stablecoin: number;
  /** debt in borrowed token units */
  debt: number;
  /** USD, positive: collateral + soft liquidation part */
  collateralUsd: number;
  /** USD, positive */
  debtUsd: number;
  /** Curve health(user, true) as a fraction: 0 = liquidation line, 0.1 = 10% headroom; null without a loan */
  health: number | null;
  /** 1 + health: the same headroom on the Aave health factor scale (1 = liquidation) */
  healthFactorLike: number | null;
  /** true while part of the collateral is converted to the borrowed token (stablecoin > 0) */
  softLiquidation: boolean;
  /** AMM borrow APY (fraction), live snapshots only */
  borrowApy: number | null;
}

// Optional additions to existing responses (declaration merging keeps the original declarations untouched).
export interface AddressDetailResponse {
  /** CRVUSD: Curve crvUSD / LlamaLend loans of the address; absent until the read model fills it */
  curve?: CurvePositionInfo[];
}

export interface PortfolioView {
  /** CRVUSD: Curve crvUSD / LlamaLend loans in scope (overview and wallet views); absent until the read model fills it */
  curve?: CurvePositionInfo[];
}

// ---------- FRONTEND: small optional additions the UI needs ----------

export interface CurvePositionInfo {
  /** FRONTEND: the address (lowercase) and its label, for links from overview cards */
  address?: string;
  label?: string | null;
}

export interface TxRow {
  /** set when a transfer of this transaction is one leg of a paired L1 <-> L2 bridge (bridge_pairs) */
  bridge?: { from: Chain; to: Chain };
}

/** GET /api/pnl?scope= : the PnL summary of one scope (list rows show the ROI of the selected range). */
export interface ScopePnlResponse {
  scope: string;
  pnl: PnlSummary;
}

// ---------- BOT REPORT: GET /api/bot/report (read-only, bearer token) ----------

export type ReportWindow = '24h' | '7d' | '30d';

/** One canonical asset (ETH and WETH merged) at the window start and now. */
export interface ReportHolding {
  /** canonical asset key, e.g. coingecko:ethereum */
  key: string;
  symbol: string;
  chains: Chain[];
  /** units held (wallet + supplied), >= 0 */
  heldStart: number;
  heldEnd: number;
  /** units borrowed, >= 0 */
  borrowedStart: number;
  borrowedEnd: number;
  /** net USD (debt negative) at the window start, valued at that time's price */
  usdStart: number;
  usdEnd: number;
  /** usdEnd - usdStart */
  usdChange: number;
  /** USD per unit at the start (from the stored snapshot) and now; null when unpriced */
  priceStart: number | null;
  priceEnd: number | null;
  /** fraction (0.031 = +3.1%); null when either price is missing */
  priceChangePct: number | null;
  /** new = not held at the start, closed = held at the start but not now, changed = units moved, price = only the price moved */
  status: 'new' | 'closed' | 'changed' | 'price';
}

/** Aave or Curve position, with its health at the window start when it existed then. */
export interface ReportPosition {
  protocol: 'aave-v3' | 'curve-crvusd' | 'llamalend';
  market: string;
  chain: Chain;
  address: string;
  label: string | null;
  /** USD, positive numbers */
  collateralUsd: number;
  debtUsd: number;
  /** health factor scale, 1 = liquidation (Curve: 1 + health); null without debt */
  healthFactor: number | null;
  healthFactorStart: number | null;
  /** fraction the most critical collateral price can fall before liquidation; null when unknown */
  liquidationDropPct: number | null;
  /** Curve only: part of the collateral is being converted (soft liquidation) */
  softLiquidation?: boolean;
}

/** One transaction of the window, compacted for a bot. */
export interface ReportTx {
  ts: number;
  chain: Chain;
  kind: TxKind;
  /** value moved in (+) or out (-) of the scope at the time, USD; 0 for internal; null when unpriced */
  netUsd: number | null;
  /** gas paid by a tracked address, positive USD, null when unknown */
  feeUsd: number | null;
  counterparty: string | null;
  counterpartyLabel: string | null;
  /** units always positive, `direction` says which way they moved for the scope */
  transfers: { symbol: string; amount: number; usd: number | null; direction: 'in' | 'out' | 'internal' }[];
  explorerUrl: string;
}

export interface ReportAlert {
  level: 'info' | 'warning' | 'critical';
  /** stable machine key, e.g. health-factor-low, data-stale */
  code: string;
  message: string;
}

/**
 * Daily "what changed" report for bots. Every money field is USD unless it sits under `currency`.
 * Debt is negative in net values (usdStart / usdEnd) and positive in debtUsd / borrowed fields.
 */
export interface BotReportResponse {
  generatedAt: number;
  scope: string;
  window: ReportWindow;
  /** window start used (now - window, or the first history point when history starts later) */
  from: number;
  to: number;
  freshness: {
    lastSnapshotAt: number | null;
    workerHeartbeatAt: number | null;
    /** true when the newest live snapshot is older than 1 hour: numbers may lag */
    stale: boolean;
    backfillComplete: boolean;
    failedJobs: number;
  };
  netWorth: {
    startUsd: number | null;
    endUsd: number;
    changeUsd: number | null;
    /** fraction; null when the start is below $1 */
    changePct: number | null;
    /** positive numbers */
    assetsUsd: number;
    debtUsd: number;
  };
  /** holdings-based PnL of the window (same definitions as the overview: price PnL, interest, gas, other = deposits / withdrawals) */
  pnl: PnlPeriod;
  /** headline numbers in the requested display currency (amounts of that currency, not USD) */
  currency: {
    code: DisplayCurrency;
    /** units of the currency per USD at the start and now; 1 for USD */
    rateStart: number;
    rateEnd: number;
    start: number | null;
    end: number;
    change: number | null;
    /** price PnL, currency effect and the rest, summing to change (USD: fxEffect 0) */
    market: number | null;
    fxEffect: number | null;
  };
  /** assets whose units or value changed, sorted by |usdChange| desc (max 25) */
  holdings: ReportHolding[];
  positions: ReportPosition[];
  risk: Pick<RiskSummary, 'leverage' | 'ltvUsed' | 'netApy' | 'annualYieldUsd' | 'stableShare' | 'drawdownPct' | 'ath'>;
  activity: {
    /** transactions in the window (spam and approvals hidden), newest first */
    count: number;
    byKind: Partial<Record<TxKind, number>>;
    /** at most 50, newest first */
    items: ReportTx[];
    /** true when more than `items` happened in the window */
    truncated: boolean;
    /** true while the ledger backfill is still running (activity may be incomplete) */
    syncing: boolean;
  };
  alerts: ReportAlert[];
}
