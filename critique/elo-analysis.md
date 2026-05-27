# VTSR-T vs. Skillbench: An Analysis Through the Lens of *Skill Issues* (Bober-Irizar et al., 2024)

> Comparing our 8-axis Thug ELO system to the empirical findings of [*Skill Issues: An Analysis of CS:GO Skill Rating Systems*](https://arxiv.org/abs/2410.02831) (Bober-Irizar, Dua & McGuinness, University of Cambridge, 2024).

## TL;DR

- **What we got right:** per-player rating (the paper's single biggest finding), Bayesian-style commander-baseline shrinkage, role-fairness adjustment, soft floor with taper, game-specific axes (TrueSkill 2 explicitly endorses this), and pure-omission exclusion gates.
- **Where we have a real gap:** we've never measured whether VTSR-T predicts anything. The paper makes prediction accuracy the entire point of having a rating system; we don't measure ours. We also lack a Glicko-style rating deviation, which means a returning player after six months is treated identically to one who played yesterday.
- **Important data caveat:** we don't yet have reliable win/loss ground truth (`match.winner` is inferred from a kill-feed toggle model and is only definitive on the `clean_win` subset). That means we can't run a literal skillbench port — but it doesn't excuse us from validation. We have something the paper *didn't* have: per-player composite performance `P_i` for every player in every match. That's a richer validation target than win/loss, and we can use it today.
- **The paper's biggest practical message:** algorithms matter less than people think. The gap between Glicko2 and per-player TrueSkill is roughly 1–2% of accuracy. Acquisition function (matchmaking) and per-player vs per-team granularity matter more. Defaults are usually close to optimal.
- **The paper's biggest blind spot for us:** their dataset is professional CS:GO with stable 5-person rosters; ours is open pickup matches with high roster churn. Their finding that "5v5 TrueSkill outperforms 1v1 TrueSkill" probably *doesn't* apply directly to a league of ~25 rotating players.

---

## 1. The paper in one page

*Skill Issues* builds an open-source library called `skillbench` that empirically compares five rating systems on 9,929 professional CS:GO matches scraped from hltv.org:

| Rating system | What it tracks | Inputs | Per-player? |
|---|---|---|---|
| **WinRate** (their baseline) | naïve fraction of matches won | win/loss only | no (per-team) |
| **Elo** | a single point estimate `R` | win/loss only | no (per-team) |
| **Glicko2** | rating + deviation `RD` + volatility `σ` | win/loss only | no (per-team) |
| **TrueSkill** | Gaussian skill `(μ, σ)` over teams | win/loss only | no (per-team) |
| **TrueSkillPlayers (TSPlayers)** | Gaussian `(μ, σ)` per individual | win/loss only | **yes** |

They wrap each system in a "surrogate modelling" loop: the rating algorithm itself helps choose the next match to learn from, via an **acquisition function** (basically a matchmaker). Six AFs are tested, plus a "cheating" oracle.

### Headline empirical findings

1. **Per-player TrueSkill (TSPlayers) wins overall.** 64.1% predictive accuracy vs 62.9% for team-based TrueSkill, on the same data. The paper writes this is its "best achieved average accuracy" and that the per-player formulation is more robust to parameter changes (1.3% performance range vs 7.5%).
2. **Glicko2 beats team-Elo and even team-TrueSkill** for team-based ratings.
3. **TrueSkill default parameters are close to optimal** — sensitivity analysis shows you can lose 7.5% by tuning `β` and `σ` poorly, but you only gain 0.5–1.5% by tuning them well.
4. **Choice of acquisition function and choice of emulator are largely decoupled.** A bad AF (`MostSeen`, `LikeliestWin`) can cost more than the gap between rating systems.
5. **Run-to-run variance is "surprising."** With limited data, two rating systems can swap ranks by chance on a single run. Effect sizes are small.
6. **All systems plateau quickly** — most of the benefit is reached within ~1000 matches.

### What they explicitly *don't* test

- Time-varying skill (matches are shuffled out of order to maximise matchup variety)
- Log-loss (only top-1 win-prediction accuracy)
- Per-player performance metrics within a match (kills, ADR, etc.) — they only feed in win/loss
- Drawn matches (excluded from evaluation)

This last omission is huge for our comparison. **The paper has nothing to say about composite-performance ratings like ours, because their dataset is win/loss only.** We get free bonus signal CS:GO-on-hltv didn't have.

---

## 2. VTSR-T in one page

Our system, defined in `scripts/elo.py`:

| Component | Value |
|---|---|
| Per-player or per-team? | **Per-player** |
| Inputs to update | An 8-axis lobby-relative composite `P_i ∈ [-1, +1]`. Win/loss is *not* used (`ALPHA = 0`). |
| Update rule | ELO-style: `dR = K_i · S · (P_i - E_i)` with loss aversion 0.85 and a linear floor taper |
| Confidence parameter | None (only a binary "Provisional" badge for `n < 10`) |
| Volatility tracking | None |
| Match-quality / matchmaking | None — we don't pick matchups |

### Per-match update mechanics

For each rated player `i` in each match:

1. Compute eight raw axis values across the lobby (e.g. `net_damage_share`, `thug_kill_rate`, `target_lock_pct`).
2. Z-score per axis across the lobby, clip to `[-2, +2]`, divide by 2 → each player's per-axis score lands in `[-1, +1]`.
3. (v2.4) For commander rows on four audit-derived axes, additively shift by a shrunk baseline (Bayesian-style: locked seed prior + running empirical mean), then re-clip.
4. Weight-sum into composite `P_i = Σ_a w_a · z'_{i,a}`.
5. Compute expected performance against the lobby:
   `E_i = 2 / (1 + 10^((R̄ - R_i) / 800)) - 1`,
   where `R̄` is the **median** opponent rating.
6. Update: `dR = K_i · 2.5 · (P_i - E_i)`, with `K_i = 40 · (1 - n / (n + 10)) + 12` decaying from ~52 → 12 over a player's first ~50 matches.
7. If `dR < 0`, multiply by `0.85 · floor_taper(R_i)` so losses near the floor approach zero.

### v2.5 / v2.7 exclusion gates

- `is_campod` (>25% time in a camera-pod ship)
- `is_low_activity` (event-stream presence covered <75% of match duration)
- (v2.7, dashboard-toggle only) `is_commander` for thug-only mode

Excluded rows produce **no delta, no `matches_played` bump, no rating change** — the match simply did not happen for that player.

---

## 3. Side-by-side

| Property | Paper's best (TSPlayers) | VTSR-T |
|---|---|---|
| Granularity | per-player | per-player ✓ |
| Update signal | binary win/loss | continuous 8-axis composite |
| Confidence parameter | Gaussian σ that grows over time | none — binary "Provisional" only |
| Volatility | implicit in σ updates | none |
| Floor / "elo hell" mitigation | none (TrueSkill has no floor) | soft floor at 1000 with 150-pt linear taper, plus 0.85 loss aversion |
| K-factor / learning rate | adaptive via σ | hand-tuned decay curve |
| Opponent reference | per-pair updates against each other player | **median** of all other players in lobby |
| Role / position adjustment | none | per-axis commander shift (v2.4) with Bayesian shrinkage |
| Late-joiner / quit handling | none in their evaluation; TrueSkill 2 paper proposes it | per-row pure-omission gates (`is_campod`, `is_low_activity`) |
| Matchmaking | studied as separate "acquisition function" | n/a — community pickup games |
| Predictive accuracy validation | yes — held-out match prediction | **none** |
| Sensitivity analysis | yes — log-grid search on σ, β, τ | **none** |
| Log-loss / calibration | mentioned as future work | **none** |

---

## 4. What we got right

### 4.1. We chose per-player updating (the paper's #1 finding)

The single most important empirical finding in the paper is that **per-player TrueSkill beats per-team TrueSkill** (64.1% vs 62.9% prediction accuracy after 2000 matches). Their reasoning: per-player ratings let players carry their skill with them when rosters change, where per-team rating systems require a "core" of three retained players to keep meaning.

Our entire corpus is roster churn — pickups with shifting 5v5 lineups. **Per-player was unambiguously the right call**, and it directly mirrors what the paper found. We didn't need a Bayesian inference framework to get there; an ELO-style scalar per player gives us most of the benefit with much less machinery.

### 4.2. We use median-of-opponents as the reference rating

`expected_performance(R_i, median(R_others))` — see [`elo.py:189`](scripts/elo.py).

Pairwise Elo updates use the opponent's rating directly. In a 10-player lobby, that doesn't scale. The naive workaround is "use the mean," which is exactly the wrong thing because a single outlier (a 2200-rated veteran in a lobby of 1500s) pulls the reference up for everyone, deflating everyone else's expected score.

We used the median. The Cambridge paper doesn't explicitly recommend this because they only ever do pairwise team-vs-team updates, but the [PUBG paper they cite (Dehpanah et al. 2020)](https://arxiv.org/abs/2008.06787) explicitly identified this as a problem with multi-player lobbies. We pre-empted it.

### 4.3. We have a real soft floor (paper-acknowledged "elo hell")

The paper's introduction calls out "elo hell" — players feeling stuck because losses hurt as much at low ratings as high ratings — as a "major point of contention" in the CS:GO community. None of the systems they evaluate have a floor or loss-aversion term. We do: `loss_multiplier = 0.85 · clamp(0, 1, (R - 1000) / 150)`. Losses go to zero as you approach 1000.

This isn't a predictive-accuracy improvement; it's a **community-trust improvement**. Worth keeping.

### 4.4. We baked in game-specific axes (TrueSkill 2's main pitch)

The paper points to Microsoft's [TrueSkill 2 (2018)](https://www.microsoft.com/en-us/research/publication/trueskill-2-improved-bayesian-skill-rating-system/) as state-of-the-art and calls out its key contribution: incorporating **game-specific signals** like the player's individual performance in the match, tendency to quit, and skill in other game modes. Microsoft reports TrueSkill 2 lifted Halo 5 prediction accuracy from 52% → 68%.

Our 8 axes (kill rate, accuracy, efficiency, PvE share, mobility, snipe bonus, T-key usage, net damage share) are a coarse implementation of exactly this idea. The composite `P_i` *is* a game-specific performance signal — it is to BZCC roughly what TrueSkill 2's per-match performance term is to Halo 5.

### 4.5. Bayesian-style commander-baseline shrinkage

Our v2.4 commander adjustment blends a hand-tuned seed prior with a running empirical mean using shrinkage strength 30:

`baseline[a] = (n · running_mean[a] + 30 · prior[a]) / (n + 30)`

This is structurally identical to Bayesian shrinkage with a conjugate prior — the same family of math underlying Glicko/TrueSkill. As the corpus grows, live data takes over the seed; locked axes (`target_lock_pct`, `pve_share`) retain design intent permanently. **This is genuinely sophisticated** and it is an answer to a problem the Cambridge paper doesn't even attempt to solve (role-fairness in mixed-role lobbies).

### 4.6. Pure-omission exclusion gates with audit counters

`is_campod` and `is_low_activity` (and v2.7's `is_commander` thug-only toggle) are zero-penalty omissions: no delta, no `matches_played` increment. TrueSkill 2 has a related concept (quit handling, AFK detection); we have a stricter, more transparent version with corpus-wide row counters in `elo_current.json` so the gates are auditable.

The paper's v1 systems handle none of this. Glicko/TrueSkill/Elo all blindly apply outcomes regardless of whether the player was present.

### 4.7. K-factor decay = poor man's confidence parameter

`K_i = 40 · (1 - n / (n + 10)) + 12` mimics Glicko's RD-driven adaptive learning rate. New players get K ≈ 52; settled veterans get K = 12. **This is the *right* shape** — Glicko's whole pitch is that confidence should drive learning rate.

What we're missing is the *time* component (next section).

---

## 5. Where the paper exposes real gaps

I'll order these by impact.

### 5.1. We never validate predictive accuracy ⚠️ Highest priority

The Cambridge paper's entire methodology section is held-out match-prediction accuracy. They ask: given two teams' ratings before a match, can the rating system pick the winner? Random gets 50%; WinRate alone gets ~60%; their best system gets 64.1%.

**We don't measure anything analogous.** We have no idea whether VTSR-T predicts match outcomes — or even whether higher-rated players reliably outperform lower-rated ones on the next match's `P_i`.

#### 5.1.a. Data caveat: we don't have reliable team-level win/loss yet

A literal port of skillbench depends on ground-truth team winners. Our `match.winner` field is inferred from a kill-feed toggle model and is only definitive on the `clean_win` subset (`compute_match_winner()` in `scripts/process_stats.py`); `contested` and `unclear` outcomes are best-effort and shouldn't be used as ground truth. Across the corpus, the reliable-winner subset is small.

**This is a constraint, not an excuse.** The paper used win/loss because hltv.org gives them nothing else. *We have richer signal than the paper had access to* — per-player composite performance `P_i` for every player in every rated match. That's a stronger validation target than win/loss because it preserves ~10× more information per match (per-player ranks vs a single team winner). The reframed validation question:

> Given a player's pre-match rating `R_i`, does it predict where they'll land in the lobby's post-match `P_i` distribution?

#### 5.1.b. Five validators that work on data we have today

These all read from existing pipeline output (`elo_history.json` deltas + per-match `leaderboard[].personal` data) and need no winner ground truth:

1. **Pre-match rating → post-match `P_i` rank correlation.** For each rated match, compute Spearman ρ between `{R_i pre-match}` and `{P_i actual}`. Aggregate across matches; break out by lobby size and date range. A well-calibrated rating averages ρ ≥ 0.3; near-zero means the rating is uncorrelated with composite performance. **This is the single most important validator** — it directly answers "does the rating predict anything?"
2. **Calibration plot: rating gap vs actual outperformance.** Bin every player-match by `(R_i - median(R_others))` into buckets. For each bucket, plot mean actual `P_i`. Overlay the predicted `E_i` logistic curve. If actual `P_i` consistently exceeds `E_i` for big positive rating gaps, the system is *under*-confident in strong players. This calibrates the exact prediction VTSR-T already makes — the `(P_i - E_i)` gap that drives every rating delta.
3. **Self-consistency: does past `P_i` predict future `P_i`?** For each player with ≥10 matches, correlate first-half mean `P_i` with second-half mean `P_i`. This establishes the **ceiling** for any rating system reading from the composite — if past `P_i` doesn't predict future `P_i`, no clever update rule will fix that, and we'd need to revisit the axes or weights *before* worrying about the rating layer. Independent of VTSR-T entirely.
4. **Bootstrap leaderboard stability.** Resample 80% of matches with replacement, re-run `compute_elo()`, snapshot the leaderboard. Repeat 100 times. Report Spearman ρ of leaderboard order across samples (top-N agreement) plus per-player rating standard deviation across samples — that std *is* a real `±N` confidence band for the leaderboard. Needs zero predictive target.
5. **Use the small `clean_win` subset as a calibration anchor.** For the clean-win subset, compute synthetic predicted winner = team with higher mean pre-match `R_i`, report agreement rate with the actual winner. Even at N = 50–100 clean-win matches the confidence interval is wide (~±10%) but it tells us whether VTSR-T predicts winners at 50% (random), 60% (WinRate-baseline-equivalent), or 70%+ (genuinely useful). Then validate a proxy: define `synthetic_winner = team with higher mean P_i` and check agreement against `clean_win` on the same subset. If agreement is 85%+, the proxy is reasonable, and we can run skillbench-style validation against `synthetic_winner` on the *full* corpus — sidestepping the small-N problem entirely.

#### 5.1.c. Stability checks that need no predictive target at all

These don't even need `P_i` — just run them on the existing pipeline output:

- **Jackknife match dropout.** Drop one random match, re-run, compare leaderboards. Repeat 1000 times. If a single match swings the order significantly, the system is undertrained.
- **Dirichlet perturbation of `THUG_WEIGHTS`.** Sample weights from a Dirichlet around the current point with concentration α=50 (tight) and α=10 (loose), recompute, measure rank stability. Tells us whether we're tuning on a knife edge.
- **Single-axis ablation.** Drop each axis one at a time, recompute, measure leaderboard ρ vs full system. An axis whose removal barely moves the rankings is dead weight.
- **Axis correlation matrix.** Compute the 8×8 Pearson correlation across the corpus. If two axes are 0.8+ correlated, the composite double-counts that signal regardless of weights.

#### 5.1.d. Concrete first-week deliverable

A single new script — `scripts/validate_elo.py` — chronological-mode runner that emits a JSON report:

```json
{
  "rank_correlation":           {"mean": 0.42, "median": 0.45, "by_match_count": {...}},
  "calibration":                {"buckets": [...], "predicted_E_i": [...], "actual_mean_P_i": [...]},
  "self_consistency":           {"first_half_vs_second_half_rho": 0.61},
  "bootstrap_stability":        {"top_10_jaccard_mean": 0.88, "rating_std_p50": 23.4},
  "clean_win_subset":           {"n": 87, "rating_predicts_winner": 0.64, "ci": [0.54, 0.73]},
  "synthetic_winner_validity":  {"agrees_with_clean_win": 0.89},
  "axis_ablation":              {"net_damage_share": {"removed_rho": 0.97}, "...": "..."}
}
```

That single report tells us: is VTSR-T predicting anything? Is the composite stable? Are any axes dead weight? What's the empirical confidence band per player? — without ever depending on reliable team-level win/loss data.

### 5.2. We discard win/loss entirely (`ALPHA = 0`) — *contingent on data*

Our published rating is `VTSR-T = α·R^W + (1-α)·R^T` with `α = 0`. We have a `match.winner` field now (added in `match.schema_version = 3`), but nothing consumes it for rating.

**Why this matters in principle:** the paper's WinRate baseline — literally `(1 + win_rate(A) - win_rate(B)) / 2` — predicts CS:GO matches at ~60% accuracy. WinRate is a useful signal *because* the rating output is calibrated to the prediction objective.

**Why we can't act on it yet:** the win/loss data we'd need to validate this blend is exactly the data we're missing (§5.1.a). With only the `clean_win` subset reliable, we don't have enough N to confidently tune `α` against winner-prediction accuracy. Premature blending against unreliable `contested` / `unclear` outcomes would actively introduce noise, not reduce it.

**Recommendation, sequenced:**

1. Ship the §5.1 validator first. Use it to measure `P_i`-rank prediction accuracy and the `clean_win`-subset winner accuracy at the current `α = 0`.
2. As the corpus grows (more matches → more `clean_win` rows → tighter confidence interval), revisit. When the `clean_win` subset reaches ~200 matches, sweep `α` ∈ {0.0, 0.1, 0.25, 0.5} and pick the value that maximises both metrics simultaneously.
3. If the `synthetic_winner` proxy from §5.1.b validates well (≥85% agreement with `clean_win`), use it to sweep `α` against the *full* corpus instead of waiting for the `clean_win` subset to grow.

The "blend in win/loss" intent stays exactly the same; the prerequisite is the validation framework, not a different schema.

### 5.3. No rating deviation (`RD`) — returning players are mishandled

Glicko2's whole reason for existing was that Elo treats a rating that hasn't been updated in five years identically to one updated yesterday. Our K-factor decay solves this for *new* players (they get bigger updates) but not for *returning* players (a 50-match player who comes back after 8 months is treated like one who played last week).

The fix is to grow `RD` (or our analogue: bump the K-factor) with time-since-last-match, exactly the way Glicko2 does. Pseudocode:

```
days_inactive = (now - last_match_date).days
inactivity_K_boost = min(20, 0.05 * days_inactive)  # tunable
K_i = base_K(matches_played) + inactivity_K_boost
```

This matters more in our domain than in pro CS:GO because our players cycle in and out over months.

### 5.4. No sensitivity analysis on our parameter zoo

The paper's Figure 2 is a logarithmic grid search over `σ`, `β`, `τ`. They find:

- `β` and `σ` are very important; `τ` matters much less
- The default ratio `β = σ/2` is roughly optimal
- TSPlayers is more robust to parameter changes than TSEmulator

VTSR-T has **far more knobs**: 8 axis weights (sum to 1), 6 commander priors, `ALPHA_PVE`, `ELO_K_BASE`, `ELO_K_FLOOR`, `ELO_PROVISIONAL_PRIOR`, `ELO_RATING_SCALE`, `ELO_LOGISTIC_SCALE`, `ELO_K_LOSS_AVERSION`, `ELO_FLOOR_TAPER_WINDOW`, `COMMANDER_BASELINE_SHRINKAGE`. We've never asked "if I perturb the axis weights by ±50%, does the leaderboard reorder?"

The risk is real: with 8 axes summing to 1, the leaderboard effectively lives in a 7-dimensional weight simplex, and we have no idea which subspaces of that simplex produce stable orderings.

**Recommendation:** once §5.1 is in place, do a Monte Carlo perturbation. Sample `THUG_WEIGHTS` from a Dirichlet around the current point with concentration parameters. Measure Spearman correlation of the leaderboard rank ordering across samples. If ρ > 0.95, we're safe. If ρ < 0.8, we're tuning on a knife edge.

### 5.5. No log-loss / calibration metric

The paper explicitly calls this out as a limitation of their own work (§V.A): "It may be insightful to compute the log-loss of each emulator to reward stronger beliefs." Cambridge punted, and so did we.

Top-1 prediction accuracy is a coarse metric — it can't distinguish "predicts winner with 51% confidence" from "predicts winner with 95% confidence." For a system that publishes ratings users compare side-by-side, calibration matters: if we say a 1700-rated player has roughly a 65% chance of outperforming a 1500-rated player in a randomly drawn 6-person lobby, is that empirically true?

This is also free to compute once §5.1 is in place — log-loss is a one-line addition to the validator.

### 5.6. Implicit independence assumption across our 8 axes

Our weighted sum `P_i = Σ_a w_a · z'_{i,a}` implicitly assumes the 8 axes are independent or near-independent. They are not:

- `mobility` and `thug_kill_rate` correlate (active players run into more fights)
- `net_damage_share` and `thug_efficiency` overlap (both are damage-throughput signals)
- `pve_share` and `thug_efficiency` are mathematically linked (efficiency excludes structure damage from the denominator)

Z-scoring per axis each match doesn't fix this — it just normalizes scale, not correlation. A composite where two of eight axes are 0.7-correlated effectively double-counts that signal.

The paper doesn't speak directly to this (their inputs are 1-dimensional: win/loss). But the standard fix from multivariate stats is:

1. Compute the 8×8 axis correlation matrix on a representative match window
2. PCA it to find effective dimensionality
3. Either reweight axes by the inverse of their dominant-PC loading, or re-derive weights so the *principal components* sum to 1, not the raw axes

This is a one-evening exercise after §5.1 ships.

### 5.7. We hand-tuned weights without an objective function

The current `THUG_WEIGHTS` were chosen by judgment. Once §5.1 is in place, we have an objective function (log-loss against held-out match outcomes, or Spearman of pre-match `R_i` vs intra-lobby `P_i` rank). At that point, **the weights become an optimization problem**, not a design problem.

The paper's analog is its weighted-AF parameterization (`α`, `β` in their Eq. 9), which they hand-tuned to `α=1, β=1` and acknowledge in future work could be Bayesian-optimised per emulator. We're in the same place.

### 5.8. No matchmaking / lobby balancing fed by VTSR-T

The paper's central novelty is the surrogate-modelling loop where the rating system *chooses* what to learn from. That doesn't apply to community pickups — but the **Lobby Tools page**'s Team Balonce surface absolutely is a matchmaking system. It currently uses VTSR-T plus commander experience as inputs. If we ever measure (§5.1) that VTSR-T predicts intra-lobby outperformance well, the Played Meter imbalance gauge becomes much more credible.

---

## 6. Where the paper does *not* apply to us cleanly

Three honest critiques in our favour.

### 6.1. Their dataset is professional CS:GO with stable rosters

9,929 hltv.org matches between teams who train together for months. A "team" in their dataset has an identity that survives across matches. **Our domain has no team identity** — every match is a fresh split. The paper's per-team systems (Elo, Glicko2, team-TrueSkill) fundamentally don't fit our data; only TSPlayers does.

Their finding "Glicko2 beats Elo for team-based ratings" is largely irrelevant to us.

### 6.2. Their evaluation is win/loss only

Their dataset literally doesn't have per-player kill counts, accuracy, ADR, or any in-game stat. They couldn't evaluate composite-performance ratings even if they wanted to. **We have richer data than their entire study had access to.** The whole `P_i` machinery exploits signal they didn't have.

This means their comparative results are an upper bound on what win/loss-only systems can do. A rating system with access to per-match performance data (us, TrueSkill 2) should do strictly better — which Microsoft confirms with TrueSkill 2's 52→68% jump.

### 6.3. Their effect sizes are small

The gap between their best system (TSPlayers + Weighted AF, 64.1%) and the lazy WinRate baseline (60.4% average over AFs) is **3.7 percentage points** after 2000 matches. Their own §IV says "the amount of variance observed run-to-run was a surprising result. Any two skill rating systems could achieve comparable performance" on a single run.

This is a useful sanity check on our own ambitions. A perfect rating system, applied to our data, probably can't do dramatically better than a well-calibrated one. We shouldn't sink months into a Glicko2 port chasing 1.5% predictive-accuracy gains we can't even measure yet.

---

## 7. Concrete recommendations, ranked

| # | Recommendation | Effort | Impact | Data-gated? |
|---|---|---|---|---|
| 1 | **Build a `P_i`-based validator** (`scripts/validate_elo.py`): rank correlation, calibration plot, self-consistency, bootstrap stability, axis ablation, and the small `clean_win`-subset anchor. See §5.1.d for the JSON shape. | Medium | Highest — gates every other improvement | No |
| 2 | **Sensitivity analysis** via Dirichlet perturbation of `THUG_WEIGHTS` + jackknife match-dropout. Publish stability bands in the methodology modal. | Medium | Medium-High | No |
| 3 | **Axis-correlation audit + single-axis ablation** — 8×8 Pearson matrix and per-axis "removed_rho" from the validator. Trim or rebalance redundant axes. | Low | Medium | No |
| 4 | **Add inactivity-driven K-factor boost** for returning players. Mimics Glicko2's RD growth-during-inactivity. | Low | Medium-High | No |
| 5 | **Track per-player rating deviation `RD`** (or use bootstrap rating std from #1). Render as `±N` confidence band on the leaderboard. | Medium | Low-Medium for accuracy, High for UX clarity | No |
| 6 | **Validate the `synthetic_winner = higher mean P_i` proxy** against the `clean_win` subset. If ≥85% agreement, use it to validate `α` blending without depending on full-corpus winner data. | Trivial after #1 | High (unlocks #7) | Partially — needs #1 |
| 7 | **Add `α > 0` blend with `match.winner`** once #1 + #6 confirm the prerequisites. Sweep `α` ∈ {0.0, 0.1, 0.25, 0.5} against synthetic-winner or `clean_win`-subset accuracy. Ship if it lifts accuracy; document if it doesn't. | Low | High (when unblocked) | **Yes — needs reliable winner data or validated proxy** |
| 8 | **Log-loss / calibration reporting** — one extra column in the validator output once `α > 0` makes published win-probabilities meaningful. | Trivial after #1 | Medium | No |
| 9 | Optional: re-derive `THUG_WEIGHTS` via Bayesian optimisation against #1's objective function. | High | Probably small (per the paper's Fig. 2 finding that defaults are near-optimal) | No |

**Sequencing notes.** Items #1–#5 do not depend on win/loss data and should ship first. Item #6 unlocks #7 by establishing a validated proxy for winner outcomes; #7 is the only item explicitly gated on either reliable winner data or successful proxy validation. Items #8–#9 are downstream polish.

The whole list is gated on #1. If you only do one thing, do #1.

---

## 8. Closing note

The Cambridge paper is honest about its own limits ("we test only on a single dataset," "we have only evaluated emulators on non-draw outcomes," "matches are not presented in time-order"). It is, by their own admission, a study of static rating-system behaviour on stable pro teams, with win/loss-only signal.

VTSR-T was built for a different problem: ranking 25 churning players on a richer per-match signal where lobby composition shifts every Friday night. Most of our novelty (the 8-axis composite, commander-baseline shrinkage, soft floor with taper, exclusion gates) is exactly the kind of game-specific work *Skill Issues* identifies as the next frontier — and TrueSkill 2 confirms the value of.

What we're missing is the discipline of measuring whether any of it works. That's the single biggest takeaway from the paper, and the one thing we should action.
