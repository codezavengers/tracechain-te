import type { Chain, AddressValidation } from "@/lib/types"

// Address pattern matchers per chain. These are structural validators
// (format + length + basic checksum-shape), not full on-chain checks.
const PATTERNS: Record<Chain, RegExp> = {
  // BTC: legacy (1...), P2SH (3...), bech32 (bc1...)
  bitcoin: /\b(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/,
  ethereum: /\b0x[a-fA-F0-9]{40}\b/,
  polygon: /\b0x[a-fA-F0-9]{40}\b/,
  bsc: /\b0x[a-fA-F0-9]{40}\b/,
  // TRON base58, starts with T, length 34
  tron: /\bT[a-km-zA-HJ-NP-Z1-9]{33}\b/,
}

const EVM_CHAINS: Chain[] = ["ethereum", "polygon", "bsc"]

// Detect which chains an address could belong to (structural).
export function detectChains(address: string): Chain[] {
  const trimmed = address.trim()
  const matches: Chain[] = []

  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    // EVM address: ambiguous across ETH/Polygon/BSC by design.
    return [...EVM_CHAINS]
  }
  if (/^T[a-km-zA-HJ-NP-Z1-9]{33}$/.test(trimmed)) {
    matches.push("tron")
  }
  if (
    /^bc1[a-z0-9]{25,62}$/.test(trimmed) ||
    /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(trimmed)
  ) {
    matches.push("bitcoin")
  }
  return matches
}

export function validateAddress(address: string, preferredChain?: Chain): AddressValidation {
  const trimmed = (address || "").trim()
  if (!trimmed) {
    return {
      address: trimmed,
      valid: false,
      chain: null,
      candidateChains: [],
      reason: "Empty address.",
    }
  }

  const candidates = detectChains(trimmed)
  if (candidates.length === 0) {
    return {
      address: trimmed,
      valid: false,
      chain: null,
      candidateChains: [],
      reason: "Address does not match any supported chain format (BTC / EVM / TRON).",
    }
  }

  let chain: Chain = candidates[0]
  if (preferredChain && candidates.includes(preferredChain)) {
    chain = preferredChain
  }

  const ambiguous = candidates.length > 1
  return {
    address: trimmed,
    valid: true,
    chain,
    candidateChains: candidates,
    reason: ambiguous
      ? `Valid EVM-format address. Network is ambiguous across ${candidates.join(", ")}; defaulting to ${chain}.`
      : `Valid ${chain} address format.`,
  }
}

// Extract candidate wallet addresses from free-form complaint text.
export function extractWalletsFromText(text: string): { address: string; chain: Chain }[] {
  if (!text) return []
  const found = new Map<string, Chain>()

  const scan = (chain: Chain) => {
    const re = new RegExp(PATTERNS[chain].source, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const candidate = m[0]
      const validation = validateAddress(candidate, chain)
      if (validation.valid && validation.chain) {
        // Prefer non-EVM specific detection; EVM stored once.
        if (!found.has(candidate)) {
          found.set(candidate, validation.chain)
        }
      }
    }
  }

  // Order matters: scan specific formats first.
  scan("bitcoin")
  scan("tron")
  scan("ethereum") // covers all EVM

  return Array.from(found.entries()).map(([address, chain]) => ({ address, chain }))
}

export function shortAddress(address: string, size = 6): string {
  if (!address) return ""
  if (address.length <= size * 2 + 2) return address
  return `${address.slice(0, size)}…${address.slice(-4)}`
}
