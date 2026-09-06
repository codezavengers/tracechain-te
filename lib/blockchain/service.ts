import type { AddressValidation, Chain, Transaction, WalletKind, WalletMetadata } from "@/lib/types"
import { validateAddress } from "@/lib/blockchain/address-utils"
import { getChainConfig, NATIVE_ASSET } from "@/lib/blockchain/config"
import { providerCache, cacheKey, CACHE_TTL } from "@/lib/blockchain/cache"
import { ProviderError } from "@/lib/blockchain/net"
import type {
  BlockchainProvider,
  DataSource,
  ProviderResult,
  TokenTransfer,
  WalletBalance,
} from "@/lib/blockchain/data-source"
import { isDemoSource } from "@/lib/blockchain/data-source"
import { EthereumProvider, PolygonProvider, BSCProvider } from "@/lib/blockchain/providers/evm"
import { BitcoinProvider } from "@/lib/blockchain/providers/bitcoin"
import { MockBlockchainProvider } from "@/lib/blockchain/providers/mock"

const DEMO_NOTICE = "DEMO DATA — deterministic sample, not live blockchain data."

function liveProviderFor(chain: Chain): BlockchainProvider | null {
  switch (chain) {
    case "bitcoin":
      return new BitcoinProvider()
    case "ethereum":
      return new EthereumProvider()
    case "polygon":
      return new PolygonProvider()
    case "bsc":
      return new BSCProvider()
    default:
      // Tron has no bundled live adapter yet — falls back to demo data.
      return null
  }
}

interface RunResult<T> {
  data: T
  dataSource: DataSource
  provider: string
  notice?: string
}

// Core execution path: cache -> live/indexed provider -> mock fallback.
// Only non-mock results are cached, so demo data is never relabelled CACHED.
async function run<T>(
  chain: Chain,
  op: string,
  ttlMs: number,
  liveFn: (p: BlockchainProvider) => Promise<T>,
  mockFn: (m: MockBlockchainProvider) => Promise<T>,
): Promise<ProviderResult<T>> {
  const key = cacheKey([chain, op])
  const cached = providerCache.get<{ data: T; dataSource: DataSource; provider: string }>(key)
  if (cached.hit && cached.value) {
    return {
      data: cached.value.data,
      dataSource: "CACHED",
      chain,
      provider: cached.value.provider,
      fetchedAt: new Date().toISOString(),
      cached: true,
    }
  }

  const mock = new MockBlockchainProvider(chain)
  const live = liveProviderFor(chain)
  const canGoLive = live?.isConfigured() ?? false

  let result: RunResult<T>
  if (live && canGoLive) {
    try {
      const data = await liveFn(live)
      result = { data, dataSource: live.nativeSource, provider: live.name }
    } catch (err) {
      const reason = err instanceof ProviderError ? err.message : "live provider error"
      const data = await mockFn(mock)
      result = {
        data,
        dataSource: "MOCK",
        provider: mock.name,
        notice: `Live provider unavailable (${reason}). ${DEMO_NOTICE}`,
      }
    }
  } else {
    const data = await mockFn(mock)
    result = {
      data,
      dataSource: "MOCK",
      provider: mock.name,
      notice: DEMO_NOTICE,
    }
  }

  if (result.dataSource !== "MOCK") {
    providerCache.set(key, { data: result.data, dataSource: result.dataSource, provider: result.provider }, ttlMs)
  }

  return {
    data: result.data,
    dataSource: result.dataSource,
    chain,
    provider: result.provider,
    fetchedAt: new Date().toISOString(),
    cached: false,
    notice: result.notice,
  }
}

// Public façade — the production BlockchainProvider surface used by API routes.
export const blockchain = {
  validateAddress(address: string, chain?: Chain): AddressValidation {
    return validateAddress(address, chain)
  },

  isLiveCapable(chain: Chain): boolean {
    return getChainConfig(chain).configured && liveProviderFor(chain) !== null
  },

  getTransactions(address: string, chain: Chain): Promise<ProviderResult<Transaction[]>> {
    return run(
      chain,
      cacheKey(["txs", address]),
      CACHE_TTL.transactions,
      (p) => p.getTransactions(address, chain),
      (m) => m.getTransactions(address),
    )
  },

  getTransaction(hash: string, chain: Chain): Promise<ProviderResult<Transaction | null>> {
    return run(
      chain,
      cacheKey(["tx", hash]),
      CACHE_TTL.transaction,
      (p) => p.getTransaction(hash, chain),
      (m) => m.getTransaction(hash),
    )
  },

  getWalletBalance(address: string, chain: Chain): Promise<ProviderResult<WalletBalance>> {
    return run(
      chain,
      cacheKey(["bal", address]),
      CACHE_TTL.balance,
      (p) => p.getWalletBalance(address, chain),
      (m) => m.getWalletBalance(address),
    )
  },

  getTokenTransfers(address: string, chain: Chain): Promise<ProviderResult<TokenTransfer[]>> {
    return run(
      chain,
      cacheKey(["tok", address]),
      CACHE_TTL.tokenTransfers,
      (p) => p.getTokenTransfers(address, chain),
      (m) => m.getTokenTransfers(address),
    )
  },

  // Composite wallet lookup used by the wallet-investigation route. Returns a
  // single honest dataSource plus derived metadata. When the source is not
  // MOCK, metadata is synthesized from live balance + transaction stats.
  async inspectWallet(address: string, chain: Chain) {
    const [balRes, txRes, tokRes] = await Promise.all([
      this.getWalletBalance(address, chain),
      this.getTransactions(address, chain),
      this.getTokenTransfers(address, chain),
    ])

    // Overall source reflects the transaction feed (the primary intelligence).
    const dataSource = txRes.dataSource
    const demo = isDemoSource(dataSource)

    let metadata: WalletMetadata
    if (demo) {
      const mock = new MockBlockchainProvider(chain)
      const m = await mock.getMetadata(address)
      metadata =
        m ??
        synthMetadata(address, chain, balRes.data, txRes.data, "DEMO_DATA")
    } else {
      metadata = synthMetadata(address, chain, balRes.data, txRes.data, "LIVE_BLOCKCHAIN_DATA")
    }

    return {
      address,
      chain,
      dataSource,
      demo,
      notice: txRes.notice,
      provider: txRes.provider,
      fetchedAt: txRes.fetchedAt,
      cached: txRes.cached,
      metadata,
      balance: balRes.data,
      transactions: txRes.data,
      tokenTransfers: tokRes.data,
    }
  },
}

function synthMetadata(
  address: string,
  chain: Chain,
  balance: WalletBalance,
  txs: Transaction[],
  provenance: "DEMO_DATA" | "LIVE_BLOCKCHAIN_DATA",
): WalletMetadata {
  const times = txs.map((t) => t.timestamp).filter(Boolean).sort()
  const kind: WalletKind = "UNKNOWN"
  const now = new Date().toISOString()
  return {
    address,
    chain,
    kind,
    balance: balance.balance,
    asset: balance.asset || NATIVE_ASSET[chain],
    usdBalance: balance.usdBalance,
    firstSeen: times[0] ?? now,
    lastSeen: times[times.length - 1] ?? now,
    txCount: txs.length,
    provenance,
    attribution: null,
  }
}

export type WalletInspection = Awaited<ReturnType<typeof blockchain.inspectWallet>>
