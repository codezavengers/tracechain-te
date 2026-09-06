import type { Chain, Transaction } from "@/lib/types"
import { AbstractProvider } from "./base"
import { fetchJson } from "@/lib/blockchain/net"
import { getChainConfig } from "@/lib/blockchain/config"
import type { DataSource, TokenTransfer, WalletBalance } from "@/lib/blockchain/data-source"

// Blockstream/Esplora API shapes (public, keyless).
interface EsploraVin {
  prevout?: { scriptpubkey_address?: string; value?: number }
}
interface EsploraVout {
  scriptpubkey_address?: string
  value?: number
}
interface EsploraTx {
  txid: string
  status: { confirmed: boolean; block_height?: number; block_time?: number }
  vin: EsploraVin[]
  vout: EsploraVout[]
}
interface EsploraAddress {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number }
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number }
}

const SATS = 100_000_000

// Direct Bitcoin explorer adapter — yields LIVE data. The UTXO model is
// projected onto the simplified {from,to,amount} transaction shape by computing
// each transaction's net effect on the queried address.
export class BitcoinProvider extends AbstractProvider {
  readonly chain: Chain = "bitcoin"
  readonly name = "bitcoin:esplora"
  readonly nativeSource: DataSource = "LIVE"

  private base(): string {
    return getChainConfig("bitcoin").baseUrl
  }

  private projectTx(address: string, tx: EsploraTx): Transaction {
    const inputFromAddr = tx.vin.reduce((s, v) => s + (v.prevout?.scriptpubkey_address === address ? v.prevout?.value ?? 0 : 0), 0)
    const outputToAddr = tx.vout.reduce((s, v) => s + (v.scriptpubkey_address === address ? v.value ?? 0 : 0), 0)
    const net = outputToAddr - inputFromAddr
    const direction: "in" | "out" = net >= 0 ? "in" : "out"
    const counterparty =
      direction === "in"
        ? tx.vin[0]?.prevout?.scriptpubkey_address ?? "unknown"
        : tx.vout.find((v) => v.scriptpubkey_address && v.scriptpubkey_address !== address)?.scriptpubkey_address ??
          "unknown"
    return {
      hash: tx.txid,
      chain: "bitcoin",
      from: direction === "in" ? counterparty : address,
      to: direction === "in" ? address : counterparty,
      amount: Math.abs(net) / SATS,
      asset: "BTC",
      usdValue: 0,
      timestamp: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : new Date().toISOString(),
      blockHeight: tx.status.block_height ?? 0,
      direction,
      provenance: "LIVE_BLOCKCHAIN_DATA",
    }
  }

  async getTransactions(address: string): Promise<Transaction[]> {
    const txs = await fetchJson<EsploraTx[]>(`${this.base()}/address/${encodeURIComponent(address)}/txs`, {
      label: "bitcoin txs",
    })
    return txs.map((t) => this.projectTx(address, t))
  }

  async getTransaction(hash: string): Promise<Transaction | null> {
    try {
      const tx = await fetchJson<EsploraTx>(`${this.base()}/tx/${encodeURIComponent(hash)}`, { label: "bitcoin tx" })
      // Without a reference address, report the largest output as the movement.
      const largest = [...tx.vout].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]
      return {
        hash: tx.txid,
        chain: "bitcoin",
        from: tx.vin[0]?.prevout?.scriptpubkey_address ?? "unknown",
        to: largest?.scriptpubkey_address ?? "unknown",
        amount: (largest?.value ?? 0) / SATS,
        asset: "BTC",
        usdValue: 0,
        timestamp: tx.status.block_time ? new Date(tx.status.block_time * 1000).toISOString() : new Date().toISOString(),
        blockHeight: tx.status.block_height ?? 0,
        provenance: "LIVE_BLOCKCHAIN_DATA",
      }
    } catch {
      return null
    }
  }

  async getWalletBalance(address: string): Promise<WalletBalance> {
    const info = await fetchJson<EsploraAddress>(`${this.base()}/address/${encodeURIComponent(address)}`, {
      label: "bitcoin balance",
    })
    const sats = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum
    return { address, chain: "bitcoin", balance: sats / SATS, asset: "BTC", usdBalance: 0 }
  }

  // Bitcoin has no native token layer.
  async getTokenTransfers(): Promise<TokenTransfer[]> {
    return []
  }
}
