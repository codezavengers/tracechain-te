import type { Chain, Transaction } from "@/lib/types"

// Honest provenance label attached to every value the provider layer returns.
//   LIVE    - fetched just now directly from a chain node / explorer API
//   INDEXED - fetched just now from a third-party indexer (Etherscan family)
//   CACHED  - re-served from our short-lived in-memory cache
//   MOCK    - deterministic demo data (no live source configured or a fallback)
export type DataSource = "LIVE" | "INDEXED" | "CACHED" | "MOCK"

export const DATA_SOURCE_LABEL: Record<DataSource, string> = {
  LIVE: "Live blockchain",
  INDEXED: "Indexed (explorer)",
  CACHED: "Cached",
  MOCK: "Demo data",
}

export function isDemoSource(s: DataSource): boolean {
  return s === "MOCK"
}

// Envelope returned by the high-level blockchain service. `dataSource` is the
// single source of truth for how the payload was derived.
export interface ProviderResult<T> {
  data: T
  dataSource: DataSource
  chain: Chain
  provider: string
  fetchedAt: string
  cached: boolean
  // Present when the result is demo data or a degraded fallback, so the UI can
  // surface an unmistakable "DEMO DATA" / "using fallback" notice.
  notice?: string
}

export interface WalletBalance {
  address: string
  chain: Chain
  balance: number
  asset: string
  usdBalance: number
}

// ERC-20 / BEP-20 / TRC-20 style token movement, distinct from a native transfer.
export interface TokenTransfer {
  hash: string
  chain: Chain
  from: string
  to: string
  tokenSymbol: string
  tokenName: string
  tokenAddress: string
  amount: number
  decimals: number
  timestamp: string
  blockHeight: number
  direction?: "in" | "out"
  // Always "TOKEN" for this shape; present for symmetry with normalization.
  transferType?: "TOKEN"
}

// Phase 6/7 — investigation-scoped pagination + filtering options.
export interface TxQueryOptions {
  page?: number
  offset?: number // rows per page
  maxPages?: number
  // Investigation filters.
  startDate?: string // ISO — inclusive lower bound
  endDate?: string // ISO — inclusive upper bound
  maxTransactions?: number // hard cap (defaults to MAX_INVESTIGATION_TRANSACTIONS)
}

// Metadata describing how much history was actually retrieved.
export interface TxPageMeta {
  totalFetched: number
  pagesFetched: number
  truncated: boolean
}

export interface TransactionPage {
  transactions: Transaction[]
  meta: TxPageMeta
}

// Shared pagination limits (Phase 6/7).
export const MAX_ROWS_PER_PAGE = 100
export const DEFAULT_MAX_PAGES = 5
export const MAX_INVESTIGATION_TRANSACTIONS = 500

// Phase 12 — provider health status taxonomy.
export type ProviderHealthStatus = "HEALTHY" | "DEGRADED" | "RATE_LIMITED" | "UNAVAILABLE" | "DEMO"

export interface ProviderHealth {
  chain: Chain
  provider: string
  status: ProviderHealthStatus
  latencyMs: number | null
  lastSuccess: string | null
  configured: boolean
  mode: "LIVE" | "DEMO"
}

// The production provider contract every chain adapter implements.
// Chain is accepted as an optional argument for interface symmetry; each
// concrete adapter is already bound to a single chain.
export interface BlockchainProvider {
  readonly chain: Chain
  readonly name: string
  // The data source this provider yields when it succeeds (LIVE/INDEXED/MOCK).
  readonly nativeSource: DataSource
  isConfigured(): boolean
  validateAddress(address: string, chain?: Chain): import("@/lib/types").AddressValidation
  getTransactions(address: string, chain?: Chain, options?: TxQueryOptions): Promise<Transaction[]>
  getTransaction(hash: string, chain?: Chain): Promise<Transaction | null>
  getWalletBalance(address: string, chain?: Chain): Promise<WalletBalance>
  getTokenTransfers(address: string, chain?: Chain): Promise<TokenTransfer[]>
  // Phase 6/7 — paginated retrieval returning history + honest metadata.
  getTransactionsDetailed?(address: string, options?: TxQueryOptions): Promise<TransactionPage>
}
