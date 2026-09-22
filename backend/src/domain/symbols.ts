/**
 * Curated catalogue shown in the app's symbol picker. The CoinGecko feed uses
 * the ids; Binance supports many more symbols, so the API also accepts symbols
 * outside this list when a feed can price them.
 */
export interface CatalogueEntry {
  symbol: string;
  name: string;
  coingeckoId: string;
}

export const SYMBOL_CATALOGUE: readonly CatalogueEntry[] = [
  { symbol: 'BTC', name: 'Bitcoin', coingeckoId: 'bitcoin' },
  { symbol: 'ETH', name: 'Ethereum', coingeckoId: 'ethereum' },
  { symbol: 'SOL', name: 'Solana', coingeckoId: 'solana' },
  { symbol: 'BNB', name: 'BNB', coingeckoId: 'binancecoin' },
  { symbol: 'XRP', name: 'XRP', coingeckoId: 'ripple' },
  { symbol: 'ADA', name: 'Cardano', coingeckoId: 'cardano' },
  { symbol: 'DOGE', name: 'Dogecoin', coingeckoId: 'dogecoin' },
  { symbol: 'TRX', name: 'TRON', coingeckoId: 'tron' },
  { symbol: 'TON', name: 'Toncoin', coingeckoId: 'the-open-network' },
  { symbol: 'AVAX', name: 'Avalanche', coingeckoId: 'avalanche-2' },
  { symbol: 'LINK', name: 'Chainlink', coingeckoId: 'chainlink' },
  { symbol: 'DOT', name: 'Polkadot', coingeckoId: 'polkadot' },
  { symbol: 'LTC', name: 'Litecoin', coingeckoId: 'litecoin' },
  { symbol: 'BCH', name: 'Bitcoin Cash', coingeckoId: 'bitcoin-cash' },
  { symbol: 'SHIB', name: 'Shiba Inu', coingeckoId: 'shiba-inu' },
  { symbol: 'UNI', name: 'Uniswap', coingeckoId: 'uniswap' },
  { symbol: 'XLM', name: 'Stellar', coingeckoId: 'stellar' },
  { symbol: 'ATOM', name: 'Cosmos', coingeckoId: 'cosmos' },
  { symbol: 'ETC', name: 'Ethereum Classic', coingeckoId: 'ethereum-classic' },
  { symbol: 'NEAR', name: 'NEAR Protocol', coingeckoId: 'near' },
  { symbol: 'APT', name: 'Aptos', coingeckoId: 'aptos' },
  { symbol: 'ARB', name: 'Arbitrum', coingeckoId: 'arbitrum' },
  { symbol: 'OP', name: 'Optimism', coingeckoId: 'optimism' },
  { symbol: 'FIL', name: 'Filecoin', coingeckoId: 'filecoin' },
  { symbol: 'HBAR', name: 'Hedera', coingeckoId: 'hedera-hashgraph' },
  { symbol: 'ICP', name: 'Internet Computer', coingeckoId: 'internet-computer' },
  { symbol: 'SUI', name: 'Sui', coingeckoId: 'sui' },
  { symbol: 'PEPE', name: 'Pepe', coingeckoId: 'pepe' },
  { symbol: 'AAVE', name: 'Aave', coingeckoId: 'aave' },
  { symbol: 'MKR', name: 'Maker', coingeckoId: 'maker' },
  { symbol: 'INJ', name: 'Injective', coingeckoId: 'injective-protocol' },
  { symbol: 'SEI', name: 'Sei', coingeckoId: 'sei-network' },
  { symbol: 'TIA', name: 'Celestia', coingeckoId: 'celestia' },
  { symbol: 'GRT', name: 'The Graph', coingeckoId: 'the-graph' },
  { symbol: 'ALGO', name: 'Algorand', coingeckoId: 'algorand' },
  { symbol: 'VET', name: 'VeChain', coingeckoId: 'vechain' },
  { symbol: 'SAND', name: 'The Sandbox', coingeckoId: 'the-sandbox' },
  { symbol: 'MANA', name: 'Decentraland', coingeckoId: 'decentraland' },
  { symbol: 'XTZ', name: 'Tezos', coingeckoId: 'tezos' },
  { symbol: 'EOS', name: 'EOS', coingeckoId: 'eos' },
  { symbol: 'FLOW', name: 'Flow', coingeckoId: 'flow' },
  { symbol: 'WIF', name: 'dogwifhat', coingeckoId: 'dogwifcoin' },
  { symbol: 'BONK', name: 'Bonk', coingeckoId: 'bonk' },
  { symbol: 'JUP', name: 'Jupiter', coingeckoId: 'jupiter-exchange-solana' },
  { symbol: 'WLD', name: 'Worldcoin', coingeckoId: 'worldcoin-wld' },
  { symbol: 'FET', name: 'Artificial Superintelligence Alliance', coingeckoId: 'fetch-ai' },
  { symbol: 'TAO', name: 'Bittensor', coingeckoId: 'bittensor' },
  { symbol: 'XMR', name: 'Monero', coingeckoId: 'monero' },
  { symbol: 'STX', name: 'Stacks', coingeckoId: 'blockstack' },
  { symbol: 'IMX', name: 'Immutable', coingeckoId: 'immutable-x' },
  { symbol: 'RENDER', name: 'Render', coingeckoId: 'render-token' },
  { symbol: 'ENA', name: 'Ethena', coingeckoId: 'ethena' },
  { symbol: 'ONDO', name: 'Ondo', coingeckoId: 'ondo-finance' },
  { symbol: 'CRO', name: 'Cronos', coingeckoId: 'crypto-com-chain' },
  { symbol: 'USDC', name: 'USD Coin', coingeckoId: 'usd-coin' },
  { symbol: 'DAI', name: 'Dai', coingeckoId: 'dai' },
];

export function coingeckoIdsFromCatalogue(extra: Record<string, string> = {}): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const e of SYMBOL_CATALOGUE) ids[e.symbol] = e.coingeckoId;
  for (const [k, v] of Object.entries(extra)) ids[k.toUpperCase()] = v;
  return ids;
}
