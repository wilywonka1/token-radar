// Token Launch Radar — the value model and farm-plan generator.
//
// One sealed snapshot in, one ranked board out. Nothing here is a list of
// names: every number is derived from the snapshot's own figures, so the
// same code would rank a future snapshot it has never seen.
//
// THE VALUE MODEL (calibrated from the snapshot itself)
//   1. calibrateCategoryMultiples reads every protocol whose token already
//      trades (mcap_usd present) and forms ratio = mcap_usd / tvl_usd.
//      Ratios are winsorised to [0.03, 2.5] so one meme outlier or one
//      near-zero print cannot bend a whole category.
//   2. A category with at least 4 trading samples gets its median ratio,
//      shrunk 25% toward the global median (small samples borrow strength
//      from the whole market). Other categories use the global median.
//      The final multiple is clamped to [0.05, 1.50] and rounded to 4dp;
//      that rounded value is the one the arithmetic below uses, so the
//      dashboard can recompute every row exactly.
//   3. momentumMultiplier: 7-day TVL growth clamped to [-40, +60]%,
//      factor = 1 + growth/100 * 0.5  (range 0.80 .. 1.30).
//   4. maturityMultiplier: how long the protocol has run with no token,
//      factor = 0.70 + 0.60 * min(age_days, 1825) / 1825  (0.70 .. 1.30).
//      A protocol that has carried real TVL for years without a token has
//      more to launch than one listed last month. Unknown age uses 365d.
//   implied_value_usd = round(tvl_usd * category_multiple
//                             * momentum_multiplier * maturity_multiplier)
//
// Tokenised protocols are never ranked by this model: they are set aside
// in a separate live list carrying their actual mcap_usd, flagged as
// already trading. The ranked board is pre-token protocols only.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  ratio_floor: number;
  ratio_cap: number;
  min_category_samples: number;
  shrinkage_to_global: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  maturity_base: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  ratio_floor: 0.03,
  ratio_cap: 2.5,
  min_category_samples: 4,
  shrinkage_to_global: 0.25,
  multiple_floor: 0.05,
  multiple_cap: 1.5,
  growth_floor: -40,
  growth_cap: 60,
  growth_weight: 0.5,
  maturity_base: 0.7,
  maturity_range: 0.6,
  maturity_days: 1825,
  unknown_age_days: 365,
};

export const MODEL_VERSION = 'radar-calibrated-2';
export const EARLY_ROWS = 200;
export const LIVE_ROWS = 32;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_samples: number;
    growth_pct: number;
    momentum_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  category_multiple: number;
  category_samples: number;
  momentum_multiplier: number;
  maturity_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_multiple: number;
  category_multiples: Record<string, number>;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** One trading protocol's market-cap to TVL ratio, winsorised so outliers cannot bend a category. */
export function winsorisedRatio(p: SnapshotProtocol, model: ModelConstants = MODEL): number | null {
  if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) return null;
  return clamp(p.mcap_usd / p.tvl_usd, model.ratio_floor, model.ratio_cap);
}

/** The median of a non-empty list, taken on a sorted copy so the caller's order never matters. */
export function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface Calibration {
  global_multiple: number;
  by_category: Map<string, { multiple: number; samples: number }>;
}

/**
 * Calibrate a TVL-to-value multiple for every category from the snapshot's
 * own tokenised protocols: winsorised median ratio per category, shrunk
 * toward the global median, clamped, and rounded to the 4dp value the
 * ranking arithmetic actually uses.
 */
export function calibrateCategoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const all: number[] = [];
  const groups = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    const ratio = winsorisedRatio(p, model);
    if (ratio === null) continue;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = groups.get(key);
    if (list) list.push(ratio);
    else groups.set(key, [ratio]);
  }
  const globalRaw = all.length > 0 ? medianOf(all) : 0.2;
  const globalMultiple = round4(clamp(globalRaw, model.multiple_floor, model.multiple_cap));
  const byCategory = new Map<string, { multiple: number; samples: number }>();
  for (const [key, ratios] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (ratios.length < model.min_category_samples) {
      byCategory.set(key, { multiple: globalMultiple, samples: ratios.length });
    } else {
      const shrunk = medianOf(ratios) * (1 - model.shrinkage_to_global) + globalRaw * model.shrinkage_to_global;
      byCategory.set(key, { multiple: round4(clamp(shrunk, model.multiple_floor, model.multiple_cap)), samples: ratios.length });
    }
  }
  return { global_multiple: globalMultiple, by_category: byCategory };
}

/** The calibrated multiple one protocol is valued with, and how many trading peers calibrated it. */
export function categoryMultipleFor(p: SnapshotProtocol, calibration: Calibration): { multiple: number; samples: number } {
  const hit = calibration.by_category.get(p.category ?? 'Uncategorised');
  return hit ?? { multiple: calibration.global_multiple, samples: 0 };
}

/** Momentum: recent TVL growth, clamped so one hot week cannot double a valuation. */
export function momentumMultiplier(change7d: number | null, model: ModelConstants = MODEL): { pct: number; mult: number } {
  const raw = typeof change7d === 'number' && Number.isFinite(change7d) ? change7d : 0;
  const pct = clamp(raw, model.growth_floor, model.growth_cap);
  return { pct, mult: round4(1 + (pct / 100) * model.growth_weight) };
}

/** Maturity: years run with no token earn a premium over a protocol listed last month. */
export function maturityMultiplier(age: number | null, model: ModelConstants = MODEL): number {
  const days = age ?? model.unknown_age_days;
  return round4(model.maturity_base + (clamp(days, 0, model.maturity_days) / model.maturity_days) * model.maturity_range);
}

/** The full breakdown for one pre-token protocol: the model's claim, step by step. */
export function impliedValueFor(p: SnapshotProtocol, asOf: string, calibration: Calibration, model: ModelConstants = MODEL): {
  implied: number; categoryMultiple: number; categorySamples: number; growthPct: number; momentumMult: number; maturityMult: number; age: number | null;
} {
  const age = ageDays(asOf, p.listed_at);
  const cat = categoryMultipleFor(p, calibration);
  const mom = momentumMultiplier(p.change_7d, model);
  const mat = maturityMultiplier(age, model);
  const implied = Math.max(1, Math.round(p.tvl_usd * cat.multiple * mom.mult * mat));
  return { implied, categoryMultiple: cat.multiple, categorySamples: cat.samples, growthPct: mom.pct, momentumMult: mom.mult, maturityMult: mat, age };
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const calibration = calibrateCategoryMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValueFor(p, snapshot.as_of, calibration, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    on_watchlist: watch.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      category_multiple: s.v.categoryMultiple,
      category_samples: s.v.categorySamples,
      growth_pct: s.v.growthPct,
      momentum_multiplier: s.v.momentumMult,
      maturity_multiplier: s.v.maturityMult,
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Rough mainnet-style gas for one simple transaction on a chain, in dollars, cheapest first. */
export function gasUsdForChain(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 9;
  if (c === 'solana') return 0.25;
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'zksync era' || c === 'linea' || c === 'scroll') return 0.8;
  if (c === 'binance' || c === 'bsc' || c === 'polygon' || c === 'avalanche' || c === 'fantom' || c === 'tron') return 1.2;
  if (c === 'bitcoin') return 3;
  return 2;
}

/** Farm on the cheapest chain the protocol actually runs on: same activity, a fraction of the gas. */
export function preferredChain(p: SnapshotProtocol): string {
  if (p.chains.length === 0) return 'its main chain';
  return [...p.chains].sort((a, b) => gasUsdForChain(a) - gasUsdForChain(b) || (a < b ? -1 : a > b ? 1 : 0))[0]!;
}

export function capitalForTier(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 300;
  if (p.tvl_usd >= 500_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 125;
  if (p.tvl_usd >= 25_000_000) return 75;
  return 50;
}

export function holdDaysForAge(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function categoryKey(p: SnapshotProtocol): string {
  return (p.category ?? '').toLowerCase();
}

/** The core farming action for a category, written for this protocol, its chain and its capital tier. */
export function coreActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = categoryKey(p);
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral in ${n} on ${chain}, then borrow about $${Math.round(capital * 0.4)} against it so both sides of the market see your wallet`;
  if (c.includes('dex') || c.includes('exchange')) return `Swap about $${Math.round(capital / 2)} through ${n} on ${chain}, then add $${capital} to its busiest stablecoin pool and keep the LP position open`;
  if (c.includes('perp') || c.includes('derivat') || c.includes('futures')) return `Deposit $${capital} of USDC margin in ${n} on ${chain} and open one small hedged position (long spot elsewhere, short here) so funding, not direction, is your risk`;
  if (c.includes('bridge') || c.includes('cross')) return `Bridge $${capital} of USDC to ${chain} through ${n}, then use the bridged funds in one app on the far side instead of bridging straight back`;
  if (c.includes('restak') || c.includes('staking') || c.includes('stake')) return `Stake $${capital} worth of the chain's staking asset through ${n} on ${chain} and keep the receipt token in the same wallet, unstaked, for the full hold`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit $${capital} into one ${n} vault on ${chain} (pick the vault with the most depositors, not the highest advertised yield) and keep the vault shares`;
  if (c.includes('rwa') || c.includes('real world')) return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} after its onboarding check, and hold the asset rather than trading it on a secondary market`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${n} on ${chain}, then hold half and lend half in the protocol's own market if it has one`;
  if (c.includes('prediction')) return `Fund ${n} with $${capital} on ${chain} and take one position in its most liquid market, sized so a total loss is acceptable`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} for a position you actually hold elsewhere, and keep the policy to expiry`;
  if (c.includes('yield') || c.includes('farm') || c.includes('liquidity')) return `Provide $${capital} of liquidity in ${n} on ${chain} (a stablecoin pair if one exists) and keep the position open through the weekly actions below`;
  if (c.includes('launchpad')) return `Register the wallet with ${n} on ${chain} and complete one $${capital} participation or staking action it offers, keeping proof of the transaction`;
  if (c.includes('chain') || c.includes('payments')) return `Move $${capital} of real activity onto ${n} via ${chain}: bridge in, make three ordinary payments or transfers, and keep a balance above $${Math.round(capital / 5)}`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} through its main app and keep the position open through the weekly actions below`;
}

/** A second, different qualifying action so the farm is a pattern of use, not one deposit. */
export function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = categoryKey(p);
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp')) return `In week two, repay part of the borrow and re-borrow a smaller amount in ${n} so the wallet shows two separate borrow events, not one`;
  if (c.includes('dex') || c.includes('exchange')) return `In week two, make one swap in the opposite direction in ${n} and add a small top-up to the pool, so volume and liquidity both count`;
  if (c.includes('perp') || c.includes('derivat')) return `In week two, close the first hedge in ${n}, settle it, and open a fresh smaller one so the wallet has a completed trade cycle`;
  if (c.includes('bridge') || c.includes('cross')) return `In week two, bridge a smaller second amount through ${n} on a different route it offers, and spend or deposit it on the far side`;
  if (c.includes('restak') || c.includes('staking') || c.includes('stake')) return `In week two, claim any staking rewards in ${n} and restake them once, so the wallet shows a claim and a second stake`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `In week two, add a small top-up deposit to the same ${n} vault and vote or sign in wherever the vault lists its depositors' governance`;
  return `In week two, repeat the core action in ${n} at a quarter of the first size and on a different day, so the wallet reads as a returning user of ${chain}`;
}

/**
 * A concrete farm plan for one protocol: six steps, each an action with a
 * dollar cost and a time. Category picks the actions, the cheapest listed
 * chain picks the gas, TVL picks the capital tier, age picks the hold.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = preferredChain(p);
  const gas = gasUsdForChain(chain);
  const gasText = gas < 1 ? `about $${gas.toFixed(2)}` : `about $${gas}`;
  const capital = capitalForTier(p);
  const hold = holdDaysForAge(age);
  const weeks = Math.max(3, Math.round(hold / 7));
  return [
    {
      text: `Set up a fresh wallet for ${p.name} only, fund it on ${chain} with the capital below plus a gas buffer, and store its seed phrase offline on paper`,
      cost: `${gasText} of gas for the first funding transaction`,
      time: '10 minutes',
    },
    {
      text: coreActionFor(p, capital, chain),
      cost: `$${capital} of capital plus ${gasText} of gas`,
      time: '20 minutes to set up',
    },
    {
      text: secondActionFor(p, chain),
      cost: `about $${Math.round(capital / 4)} of extra capital and ${gasText} of gas`,
      time: '15 minutes in week two',
    },
    {
      text: `Repeat one qualifying action in ${p.name} every week for ${weeks} weeks (a deposit, swap, borrow, claim or vote), varying the day and keeping each transaction above $10 so it is not dust`,
      cost: `${gasText} of gas per week, about $${(gas * weeks).toFixed(2)} across the plan`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the main position for at least ${hold} days without withdrawing below half, so the wallet appears in more than one weekly snapshot of ${p.name}`,
      cost: `the $${capital} stays in the position; price and smart-contract risk are the real cost`,
      time: `${hold} days`,
    },
    {
      text: `Log every transaction hash, date and amount in a farm sheet, then check ${p.name}'s own points or rewards page weekly and claim only from a link that page itself publishes`,
      cost: 'nothing to check; never pay a fee to claim an airdrop',
      time: '5 minutes a week, 15 minutes to unwind at the end',
    },
  ];
}

/** Tokenised protocols, set aside: the market's own values, never the model's. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && (p.mcap_usd ?? 0) > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d, symbol: p.symbol }));
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, listed_at: row.listed_at, age_days: row.age_days,
    on_watchlist: row.on_watchlist, implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple, category_samples: row.model.category_samples,
    momentum_multiplier: row.model.momentum_multiplier, maturity_multiplier: row.model.maturity_multiplier,
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const calibration = calibrateCategoryMultiples(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  const multiples: Record<string, number> = {};
  for (const [key, v] of [...calibration.by_category.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) multiples[key] = v.multiple;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model,
    model_version: MODEL_VERSION, global_multiple: calibration.global_multiple,
    category_multiples: multiples, watchlist_size: snapshot.watchlist.length,
    board_size: board.length, early_size: early, live_size: live.length,
    rows: board.map(radarRow), live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row floor`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'all rows share one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
