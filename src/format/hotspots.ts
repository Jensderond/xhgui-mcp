import type { Run } from "../backends/types.js";

export interface SymbolStats {
  symbol: string;
  ct: number;
  wt: number;    // inclusive wall time (µs)
  selfWt: number | null; // null if derivation impossible
}

/**
 * XHGui stores per-edge stats keyed as "parent==>child" (plus a root entry
 * usually keyed "main()"). Given those edges, derive per-symbol stats:
 *
 *   incl(sym) = Σ edge.wt where edge endpoints in "*==>sym"
 *   self(sym) = incl(sym) − Σ edge.wt where edge endpoints in "sym==>*"
 *
 * The root entry ("main()") is its own key with no "==>" separator; we treat
 * its stats as its own inclusive numbers (no incoming edges to sum).
 */
export function deriveSymbolStats(run: Run): Map<string, SymbolStats> {
  const incl = new Map<string, { ct: number; wt: number }>();
  const outgoing = new Map<string, number>(); // sym → Σ wt of outgoing edges
  const hadIncoming = new Set<string>();

  for (const [key, stats] of Object.entries(run.profile)) {
    const arrow = key.indexOf("==>");
    if (arrow === -1) {
      // Root entry, e.g. "main()". No parent.
      const existing = incl.get(key) ?? { ct: 0, wt: 0 };
      incl.set(key, { ct: existing.ct + stats.ct, wt: existing.wt + stats.wt });
      continue;
    }
    const parent = key.slice(0, arrow);
    const child = key.slice(arrow + 3);

    const childIncl = incl.get(child) ?? { ct: 0, wt: 0 };
    incl.set(child, { ct: childIncl.ct + stats.ct, wt: childIncl.wt + stats.wt });
    hadIncoming.add(child);

    outgoing.set(parent, (outgoing.get(parent) ?? 0) + stats.wt);
  }

  const out = new Map<string, SymbolStats>();
  for (const [sym, { ct, wt }] of incl) {
    const outSum = outgoing.get(sym) ?? 0;
    // A symbol with no incoming edges that isn't the root can't have reliable
    // self-time. The root ("main()") is fine: we have its raw wt.
    const isRoot = !sym.includes("==>") && !hadIncoming.has(sym);
    const selfWt = isRoot || hadIncoming.has(sym) ? wt - outSum : null;
    out.set(sym, { symbol: sym, ct, wt, selfWt });
  }
  return out;
}

export interface TopEntry {
  symbol: string;
  ct: number;
  inclMs: number;
  selfMs: number | null;
}

export function topByInclusive(stats: Map<string, SymbolStats>, n: number): TopEntry[] {
  return Array.from(stats.values())
    .sort((a, b) => b.wt - a.wt)
    .slice(0, n)
    .map(toTopEntry);
}

export function topBySelf(stats: Map<string, SymbolStats>, n: number): TopEntry[] {
  return Array.from(stats.values())
    .filter((s) => s.selfWt !== null)
    .sort((a, b) => (b.selfWt ?? 0) - (a.selfWt ?? 0))
    .slice(0, n)
    .map(toTopEntry);
}

export interface HotspotEntry extends TopEntry {
  category: string;
}

export function matchHotspots(stats: Map<string, SymbolStats>, patterns: string[]): HotspotEntry[] {
  if (patterns.length === 0) return [];
  const out: HotspotEntry[] = [];
  for (const pattern of patterns) {
    // Take the heaviest (by inclusive wt) symbol whose name contains the pattern.
    let best: SymbolStats | null = null;
    for (const s of stats.values()) {
      if (!s.symbol.includes(pattern)) continue;
      if (!best || s.wt > best.wt) best = s;
    }
    if (best) {
      out.push({ category: pattern, ...toTopEntry(best) });
    }
  }
  return out;
}

function toTopEntry(s: SymbolStats): TopEntry {
  return {
    symbol: s.symbol,
    ct: s.ct,
    inclMs: Number((s.wt / 1000).toFixed(1)),
    selfMs: s.selfWt === null ? null : Number((s.selfWt / 1000).toFixed(1)),
  };
}
