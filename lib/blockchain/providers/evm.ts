import type { Chain, Transaction } from "@/lib/types"
import { AbstractProvider } from "./base"
import { fetchJson, ProviderError } from "@/lib/blockchain/net"
import { getChainConfig, NATIVE_ASSET } from "@/lib/blockchain/config"
import type { DataSource, TokenTransfer, WalletBalance } from "@/lib/blockchain/data-source"

// Etherscan V2 unified-API response envelope.
interface EtherscanEnvelope<T> {
  status: string
  message: string
  result: T
}

interface EtherscanTx {
  blockNumber: string
  timeStamp: string
  hash: string
  from: string
  to: string
  value: string
  isError?: string
}

interface EtherscanTokenTx {
  blockNumber: string
  timeStamp: string
  hash: string
  from: string
  to: string
  value: string
  tokenName: string
  tokenSymbol: string
  tokenDecimal: string
  contractAddress: string
}

const MAX_ROWS = 50

// Etherscan-family (indexer) adapter shared by Ethereum, Polygon and BSC. The
// numeric chainId selects the network on the V2 unified endpoint.
export class EvmProvider extends AbstractProvider {
  readonly nativeSource: DataSource = "INDEXED"
  readonly name: string

  constructor(readonly chain: Chain) {
    super()
    this.name = `evm:${chain}`
  }

  isConfigured(): boolean {
    return getChainConfig(this.chain).configured
  }

  private buildUrl(params: Record<string, string>): string {
    const cfg = getChainConfig(this.chain)
    if (!cfg.configured) {
      throw new ProviderError(`${this.chain} live provider is not configured.`, "not_configured")
    }
    const u = new URL(cfg.baseUrl)
    if (cfg.chainId) u.searchParams.set("chainid", String(cfg.chainId))
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    if (cfg.apiKey) u.searchParams.set("apikey", cfg.apiKey)
    return u.toString()
  }

  private toUnits(raw: string, decimals: number): number {
    // Convert an integer-string in base units to a human float without losing
    // precision from BigInt overflow for reasonable magnitudes.
    if (!raw) return 0
    try {
      const negative = raw.startsWith("-")
      const digits = negative ? raw.slice(1) : raw
      const big = BigInt(digits)
      const divisor = BigInt("1" + "0".repeat(decimals))
      const whole = big / divisor
      const frac = big % divisor
      const fracStr = frac.toString().padStart(decimals, "0").slice(0, 8)
      const val = Number(`${whole}.${fracStr}`)
      return negative ? -val : val
    } catch {
      return 0
    }
  }

  private direction(address: string, from: string, to: string): "in" | "out" {
    return to.toLowerCase() === address.toLowerCase() ? "in" : "out"
  }

  async getTransactions(address: string): Promise<Transaction[]> {
    const url = this.buildUrl({
      module: "account",
      action: "txlist",
      address,
      startblock: "0",
      endblock: "99999999",
      page: "1",
      offset: String(MAX_ROWS),
      sort: "desc",
    })
    const res = await fetchJson<EtherscanEnvelope<EtherscanTx[] | string>>(url, {
      label: `${this.chain} txlist`,
    })
    if (!Array.isArray(res.result)) {
      // "No transactions found" comes back as status "0" with a string result.
      if (res.status === "0" && /no transactions/i.test(String(res.result))) return []
      throw new ProviderError(`${this.chain} txlist error: ${res.message || "unknown"}.`, "http")
    }
    const asset = NATIVE_ASSET[this.chain]
    return res.result.map((t) => ({
      hash: t.hash,
      chain: this.chain,
      from: t.from,
      to: t.to,
      amount: this.toUnits(t.value, 18),
      asset,
      usdValue: 0,
      timestamp: new Date(Number(t.timeStamp) * 1000).toISOString(),
      blockHeight: Number(t.blockNumber),
      direction: this.direction(address, t.from, t.to),
      provenance: "LIVE_BLOCKCHAIN_DATA" as const,
    }))
  }

  async getTransaction(hash: string): Promise<Transaction | null> {
    const url = this.buildUrl({
      module: "proxy",
      action: "eth_getTransactionByHash",
      txhash: hash,
    })
    const res = await fetchJson<{ result: null | { from: string; to: string; value: string; blockNumber: string } }>(
      url,
      { label: `${this.chain} tx` },
    )
    if (!res.result) return null
    const r = res.result
    return {
      hash,
      chain: this.chain,
      from: r.from,
      to: r.to ?? "",
      amount: this.toUnits(BigInt(r.value || "0x0").toString(), 18),
      asset: NATIVE_ASSET[this.chain],
      usdValue: 0,
      timestamp: new Date().toISOString(),
      blockHeight: r.blockNumber ? Number(BigInt(r.blockNumber)) : 0,
      provenance: "LIVE_BLOCKCHAIN_DATA",
    }
  }

  async getWalletBalance(address: string): Promise<WalletBalance> {
    const url = this.buildUrl({
      module: "account",
      action: "balance",
      address,
      tag: "latest",
    })
    const res = await fetchJson<EtherscanEnvelope<string>>(url, { label: `${this.chain} balance` })
    return {
      address,
      chain: this.chain,
      balance: this.toUnits(String(res.result ?? "0"), 18),
      asset: NATIVE_ASSET[this.chain],
      usdBalance: 0,
    }
  }

  async getTokenTransfers(address: string): Promise<TokenTransfer[]> {
    const url = this.buildUrl({
      module: "account",
      action: "tokentx",
      address,
      page: "1",
      offset: String(MAX_ROWS),
      sort: "desc",
    })
    const res = await fetchJson<EtherscanEnvelope<EtherscanTokenTx[] | string>>(url, {
      label: `${this.chain} tokentx`,
    })
    if (!Array.isArray(res.result)) return []
    return res.result.map((t) => {
      const decimals = Number(t.tokenDecimal) || 18
      return {
        hash: t.hash,
        chain: this.chain,
        from: t.from,
        to: t.to,
        tokenSymbol: t.tokenSymbol || "TOKEN",
        tokenName: t.tokenName || "Unknown token",
        tokenAddress: t.contractAddress,
        amount: this.toUnits(t.value, decimals),
        decimals,
        timestamp: new Date(Number(t.timeStamp) * 1000).toISOString(),
        blockHeight: Number(t.blockNumber),
        direction: this.direction(address, t.from, t.to),
      }
    })
  }
}

// Named subclasses to match the required adapter architecture. Each binds the
// shared Etherscan V2 logic to a specific network.
export class EthereumProvider extends EvmProvider {
  constructor() {
    super("ethereum")
  }
}
export class PolygonProvider extends EvmProvider {
  constructor() {
    super("polygon")
  }
}
export class BSCProvider extends EvmProvider {
  constructor() {
    super("bsc")
  }
}
