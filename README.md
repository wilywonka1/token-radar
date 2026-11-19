# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/wilywonka1/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/wilywonka1/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot of 758 protocols (as of 2026-11-14) and ranks the protocols that record no token by what a launch would be worth, each with a concrete plan for farming it before any token exists.

**The value model is calibrated from the snapshot itself — no hardcoded names, no fixed multiple.** `calibrateCategoryMultiples` in `lib/model.ts` takes every protocol whose token already trades, winsorises its market-cap/TVL ratio to [0.03, 2.5], and takes a median per category (shrunk 25% toward the global median, clamped to [0.05, 1.50]). A pre-token protocol's implied value is then its TVL × its category multiple × a momentum factor from its 7-day TVL growth (clamped, ×0.80–1.30) × a maturity factor for how long it has run with no token (×0.70–1.30). Tokenised protocols are never ranked by the model: they are set aside in the dashboard's "Already trading" view with their actual market caps.

The board covers all 40 watchlist protocols ($50M+ TVL, no token recorded) and adds 186 early finds below that floor — 226 ranked rows, each with a 6-step farm plan whose actions come from the protocol's category, whose gas comes from its cheapest listed chain, whose capital tier comes from its TVL, and whose hold period comes from its age. The dashboard is a static, no-network page: a sortable, filterable board (search, category, chain, watchlist/early scope, pre-token/already-trading toggle), a per-protocol detail view that recomputes the model step by step, and the full calibration table.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

This writes `out/board.json` (the ranked board), `out/data.js`, `out/dashboard/` (the page), `out/screenshots/` and `out/dossier.json`. Node 22.18+, standard library only; two runs write identical bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sqbwfzsd&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
