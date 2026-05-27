# VTSR-T Analysis v2: Combined Critique and Path Forward

> A combined reading of two analyses: `elo-analysis.md` (the Cambridge-paper-grounded v1) and a deep-research follow-up (`Analysis of the VTSR-T Algorithmic Matchmaking and Rating System in Competitive Environments.docx`, with companion visualization at `web/index.html`). Where the two agree, we take the convergence as load-bearing. Where they disagree, we surface the tension explicitly and propose an empirical tiebreaker. Where one source has unique signal, we surface it.

## TL;DR

- **What we got right (survives both critiques):** per-player rating, soft floor with taper, exclusion gates, K-factor decay shape, game-specific axes, and Bayesian-style commander-baseline shrinkage. These hold up cleanly under either reading.
- **The single biggest gap, both critiques agree:** we have never measured whether VTSR-T predicts anything. A `scripts/validate_elo.py` runner gates every other improvement.
- **Three net-new structural critiques** that v1 didn't surface:
  1. **Median-baseline tension** — Dehpanah et al. 2021 (across PUBG, LoL, *and* CS:GO, 100k+ matches) found that team threat in tactical shooters is empirically dominated by the **MAX** rating, not the median. Our `expected_performance(R_i, median(others))` may be miscalibrating expected outcomes for high-skew lobbies.
  2. **Locked-prior tension** — `pve_share` and `target_lock_pct` use hand-tuned locked overrides instead of the empirical running mean. PandaSkill (2025, League of Legends production system) is a modern alternative that handles role asymmetry via pure empirical role-modeling. Whether our normative override helps or hurts is empirically settle-able with a one-line ablation.
  3. **EOMM / inflation tension** — soft floor + 0.85 loss aversion together violate Elo zero-sum. Net rating across the corpus drifts upward over time even at static skill. Counter-Strike 2 ships a dual-track architecture (pure Hidden MMR + inflationary Display Rating) that resolves this without abandoning EOMM mechanics.
- **Where the harder framings overstate:** (a) full Glicko-2 RD migration is overkill — match-count K decay is real signal; combine, don't replace. (b) The "behavioral conditioning tool" framing of locked priors is hyperbolic; the locks are a documented design intent (normative, not descriptive) and the empirical question is whether they help, not whether they're "corruption." (c) The MAX-vs-median question is a real tension but median is right for *individual* expected-performance calibration — MAX is right for *team-outcome* prediction. They're different tools for different problems.
- **Combined "what we can do today" list (§9)** is ten items, ranked by (effort × impact ÷ data dependency). The first six need no winner data and could ship in weeks. The last four are medium-term re-architectures.

---

## 1. The two critiques in two pages

### 1a. The Cambridge paper (`csgo-rating-paper.pdf`)

*Skill Issues: An Analysis of CS:GO Skill Rating Systems* (Bober-Irizar, Dua & McGuinness, 2024) builds an open-source library called **skillbench** that empirically compares five rating systems on 9,929 professional CS:GO matches:

| System | Inputs | Per-player? | Best accuracy |
|---|---|---|---|
| WinRate baseline | win/loss | no | ~60% |
| Elo | win/loss | no | low-60s |
| Glicko2 | win/loss | no | mid-60s |
| TrueSkill | win/loss | no | 62.9% |
| **TrueSkillPlayers** | win/loss | **yes** | **64.1%** |

**Headline findings:**

1. Per-player rating beats per-team rating (64.1% vs 62.9%). The paper writes this is its "best achieved average accuracy."
2. Defaults are usually close to optimal (you lose more from bad parameters than you gain from good ones).
3. Run-to-run variance is large enough that two systems can swap ranks by chance on a single run.
4. Effect sizes between systems are small (3-4 percentage points between best and worst).
5. They explicitly *don't* test: time-varying skill, log-loss, per-player in-match performance, drawn matches.

**Crucial limit for our comparison:** their dataset is win/loss only. They couldn't evaluate a composite-performance rating like ours even if they'd wanted to. Their numbers are an upper bound for *what's possible with win/loss alone*, not a ceiling for what's possible with our richer per-match signal.

### 1b. The production-systems benchmarking reading (`Analysis of the VTSR-T Algorithmic Matchmaking and Rating System in Competitive Environments.docx`)

The second analysis approaches VTSR-T from a different angle: it benchmarks the system against **modern probabilistic tier-one production standards** rather than against a single academic dataset. Five citations carry the argument:

| Source | What it adds |
|---|---|
| Cambridge "Skill Issues" (2024) | Same paper as v1 — predictive validation as the gold standard. |
| **Dehpanah et al. 2021** (`Evaluating Team Skill Aggregation in Online Competitive Games`, also vendored at `critique/publications/`) | 100k+ matches across PUBG, LoL, CS:GO. Empirically: **MAX aggregation beats SUM/MIN/Mean/Median** for team threat in tactical shooters. |
| **TrueSkill 2** (Microsoft, 2018) | 52% → 68% accuracy lift in Halo 5 by including in-match signals. Models kills/deaths as Poisson with mean/variance scaling linearly with match length. |
| **PandaSkill** (2025, LoL production system) | Solves role asymmetry via independent ML models per role + OpenSkill, *without* hand-tuned overrides. Direct alternative to our locked priors. |
| **EOMM literature** (Chen 2017 / Elmachtoub 2024 / Kang 2024) | Establishes that engagement-optimized matchmaking is real, well-studied, and **incompatible with pure skill measurement**. CS2 ships a dual-track to resolve this. |

**The thesis statement (§1 of the docx):** VTSR-T "sacrifices mathematical zero-sum integrity in favor of Engagement Optimized Matchmaking (EOMM) principles." That sentence is what the rest of the document is arguing. v2 takes it seriously and answers it directly in §6.

**The five structural critiques (Sections 2.1–2.5):**

1. **2.1 The predictive validation gap.** Same as Cambridge §5.1.
2. **2.2 The mathematical fallacy of the median baseline.** New. MAX beats median in tactical shooters per Dehpanah.
3. **2.3 Deterministic K-factor vs. true Bayesian uncertainty.** Sharper version of v1 §5.3 — argues for Glicko-2 RD migration, not just inactivity boost.
4. **2.4 Hand-tuned priors compromise empirical integrity.** New. The locked `pve_share` (-0.05) and `target_lock_pct` (-0.10) overrides explicitly contradict the empirical audit (+0.111 and -0.466 respectively).
5. **2.5 EOMM vs. skill accuracy.** New. Soft floor + loss aversion = inflationary rating economy.

**The five proposed strategic fixes (§3 of the docx):** P_i benchmarking, MAX threat topology, Bayesian RD, unlock priors, decouple skill from engagement (dual-track).

---

## 2. VTSR-T in one page (recap)

Defined in `scripts/elo.py`. Per-player ELO-style scalar anchored at 1500.

| Component | Value |
|---|---|
| Granularity | Per-player |
| Update signal | 8-axis lobby-relative composite `P_i ∈ [-1, +1]`. Win/loss not used (`ALPHA = 0`). |
| Update rule | `dR = K_i · 2.5 · (P_i - E_i)` with loss aversion 0.85 and linear floor taper |
| Confidence parameter | None (only binary "Provisional" badge for `n < 10`) |
| Volatility tracking | None |
| Opponent reference | **median** of all other players in lobby |
| Role adjustment | v2.4 commander axis-shift: 4 audit-derived priors + shrunk rolling baseline; 2 hand-tuned LOCKED priors (`target_lock_pct: -0.10`, `pve_share: -0.05`); 2 role-blind axes |
| Exclusion gates | `is_campod` / `is_low_activity` / (v2.7 dashboard-only) `is_commander` thug-only mode |

The 8 axes (with weights):

| Axis | Weight | What it measures |
|---|---|---|
| `net_damage_share` | 0.18 | (dealt − received) ÷ lobby total |
| `thug_kill_rate` | 0.14 | Kills per minute (alpha-blended PvE) |
| `thug_accuracy` | 0.13 | Hit rate, weapon-baseline-normalized |
| `thug_efficiency` | 0.13 | Kills per damage dealt |
| `pve_share` | 0.12 | PvE damage share |
| `mobility` | 0.12 | Activity score from positioning |
| `snipe_bonus` | 0.10 | Snipe count weighted modestly |
| `target_lock_pct` | 0.08 | T-key target-lock dwell ratio |

---

## 3. Three-way side-by-side

| Property | Cambridge best (TSPlayers) | Production-systems target | VTSR-T (current) |
|---|---|---|---|
| Granularity | per-player | per-player | per-player ✓ |
| Update signal | binary win/loss | composite + win/loss blend | 8-axis composite (no win/loss) |
| Confidence parameter | Gaussian σ growing over time | Glicko-2 RD with time-decay | binary "Provisional" only |
| Opponent reference | per-pair updates | **MAX-weighted** | **median** |
| Role adjustment | none | empirical-only (PandaSkill style) | empirical + locked overrides |
| Floor / loss aversion | none | none for MMR; OK for display | soft floor + 0.85 multiplier |
| Late-joiner / quit handling | none | none addressed | per-row pure-omission gates |
| Predictive accuracy validation | yes | yes (skillbench-style) | **none** |
| Sensitivity analysis | yes | implied | **none** |
| Architecture | single rating | **dual-track (CS2 model)** | single rating |

---

## 4. What we got right (survives both critiques)

These six items hold up under both readings. v1 §4 covered them in depth; v2 confirms they survive the harder framings introduced in §1b.

### 4.1. Per-player rating ✓

Cambridge's #1 finding. Uncontested by either critique. With our roster churn this was unambiguously the right call.

### 4.2. Median-of-opponents as the reference rating — *partial check*

v1 praised this. The harder reading calls it a "fallacy." See §6.1 — **the right answer is "depends on the question."** Median is correct for individual expected-performance calibration; MAX is correct for team-outcome prediction. Both critiques are partially right; v2's recommendation is to ship a parallel MAX-weighted `E_i` and let the validator pick.

### 4.3. Soft floor with taper

The §1b reading critiques this as inflationary EOMM (§2.5). v1 defended it as community-trust mechanism. **Both are right.** The fix is the dual-track in §6.3 — keep the soft floor on the published Display Rating, drop it on a parallel pure Hidden MMR used for matchmaking and validation.

### 4.4. Game-specific 8-axis composite

Microsoft's TrueSkill 2 (cited favorably across both critiques) made its 52% → 68% Halo 5 lift specifically by including in-match performance signals — the same architectural choice we made. Neither critique disputes the axes themselves; the locked-prior critique (§6.2) is about how the axis values are *adjusted* per role, not about the axes existing.

### 4.5. Bayesian-style commander-baseline shrinkage (audit-derived axes only)

For the four audit-derived priors (`mobility`, `thug_kill_rate`, `net_damage_share`, `thug_efficiency`), our shrinkage `(n · running_mean + 30 · prior) / (n + 30)` is structurally identical to Bayesian shrinkage with a conjugate prior — the same family of math underlying Glicko/TrueSkill. **As the corpus grows, live data takes over the seed.** The §6.2 critique applies only to the *locked* axes (`target_lock_pct`, `pve_share`), not to the shrinkage mechanic itself.

### 4.6. Pure-omission exclusion gates with audit counters

`is_campod` / `is_low_activity` / (v2.7) `is_commander`. Cambridge's systems handle none of this; the §1b reading doesn't address it. Net: real strength of our system, surfaced in neither critique.

### 4.7. K-factor decay shape (the *match-count* part)

`K_i = 40 · (1 - n / (n + 10)) + 12` is the right idea — Glicko's whole pitch is that confidence should drive learning rate, and our match-count decay implements a coarse version of that. **What's missing is the time component** (§5.2 + §7.1).

---

## 5. Where the critiques converge (highest priority)

Items where Cambridge §5.1 and §1b §2.1 agree. Action on these gates everything else.

### 5.1. Predictive validation (THE gap)

Cambridge: rating systems are judged by held-out match-prediction accuracy. The §1b reading: log-loss benchmark via skillbench-style emulator. v1: build `scripts/validate_elo.py` to measure rank correlation, calibration, bootstrap stability.

**Convergent recommendation: build the validator.** Specifically, the v1 design (§5.1.b–d in `elo-analysis.md`) is unchanged in v2:

1. Pre-match `R_i` → post-match `P_i` Spearman rank correlation. Single most important number.
2. Calibration plot: bucket player-matches by `(R_i - median(R_others))`, compare actual mean `P_i` against predicted `E_i` curve.
3. Self-consistency: first-half mean `P_i` vs second-half mean `P_i` — establishes the *ceiling* for any rating reading from the composite.
4. Bootstrap stability: 80% match resampling × 100 runs → leaderboard ρ + per-player rating std (real ±N confidence band).
5. `clean_win` subset anchor: ~50–100 reliable matches, predict winner from higher mean pre-match `R_i`. Wide CI but anchors us to skillbench-style numbers.
6. **Synthetic-winner proxy:** define `synthetic_winner = team with higher mean P_i` and validate against `clean_win`. If ≥85% agreement, use as proxy on full corpus. Sidesteps small-N entirely.

**Worth adding (sharpened by the §1b reading):** explicit **log-loss** column in the report, not just top-1 accuracy. Per Cambridge §V.A's own admission, top-1 accuracy can't distinguish a 51%-confident win prediction from a 95%-confident one. Log-loss is one extra line in the validator and unlocks calibration analysis.

### 5.2. Time-decay / inactivity handling

Both critiques flag this. The harder framing wants full Glicko-2 RD migration; v1 proposed an additive K-boost. v2 splits the difference — see §7.1 (counter-argument) and §9 item 5 (recommendation).

### 5.3. Sensitivity analysis on parameter zoo

Cambridge §5.4 (Figure 2 grid search). The §1b reading implies it via "test before deploying." Convergent: run Dirichlet perturbation on `THUG_WEIGHTS` + jackknife match-dropout + single-axis ablation. Need no winner data.

---

## 6. Net-new structural gaps (surfaced in the §1b reading)

Three structural critiques v1 missed. Each one is real, each one has a tractable empirical test.

### 6.1. Median vs MAX baseline (§2.2 of the §1b reading)

**The claim:** Dehpanah et al. 2021 (100k+ matches across PUBG, LoL, CS:GO) empirically proves MAX aggregation beats SUM/MIN/Mean/Median for team threat in tactical shooters. Our `expected_performance(R_i, median(R_others))` "mathematically ignores the massive lethality the 2500-rated player brings" in a 4×1100 + 1×2500 lobby.

**My honest assessment:** the claim is *partially right*. It conflates two distinct uses of an opponent reference rating:

- **Use A: individual expected-performance calibration.** "Given a 1700 player in a lobby of 1500s, what `P_i` should we expect them to produce?" Here median is defensible — it's robust to one outlier ringer. v1 §4.2 had the right reasoning for this case.
- **Use B: team-outcome prediction.** "Which team is favored?" Here Dehpanah is right — MAX dominates. The carry's lethality is what makes a team a threat.

VTSR-T currently uses Use A in its update rule. But the *applications* of VTSR-T (Lobby Tools' Team Balonce, the eventual `α > 0` win/loss blend) implicitly depend on Use B. Same rating, two jobs, different math.

**Recommended fix:** ship `expected_performance_max(R_i, weighted_max(R_others))` *as a parallel function* (don't replace median). Run the §5.1 validator with both. Three possible outcomes:

1. Median wins on `P_i` rank correlation, MAX wins on `clean_win` winner-prediction → the "two jobs" thesis is correct; we keep median for ratings updates, use MAX for matchmaking/prediction.
2. MAX wins on both → the harder critique is right; switch the update rule to MAX.
3. Median wins on both → v1 was right; Dehpanah's finding doesn't transfer cleanly to BZCC.

This is genuinely empirically settle-able with the §5.1 validator, in days not months. It's the single highest-information experiment we can run.

**Implementation note:** "weighted MAX" should not be literally `max()` — that's noisy on small lobbies. Standard practice (per Dehpanah and PandaSkill) is to use a softmax-style weighted average that approaches `max()` as a temperature parameter goes to 0. A reasonable starting point: `R̄_max = (Σ R_j · exp(R_j / τ)) / (Σ exp(R_j / τ))` with `τ = 200`. Then `α_blend · median + (1 - α_blend) · MAX` is the most flexible variant — let the validator find `α_blend ∈ [0, 1]`.

### 6.2. Locked priors vs PandaSkill-style empirical-only (§2.4 of the §1b reading)

**The claim:** the locked overrides for `pve_share` (-0.05 vs empirical +0.111) and `target_lock_pct` (-0.10 vs empirical -0.466) "corrupt empirical integrity." PandaSkill (2025, LoL) solves role asymmetry via independent ML role models + OpenSkill, *without* hand-tuned overrides. Net: VTSR-T is "a behavioral conditioning tool rather than an objective skill evaluator."

**The math, for record:** in `scripts/elo.py:602`, the shift is `-baseline`. So:

- `pve_share`: locked baseline = `-0.05` → shift = `+0.05` per commander row. Adds 0.05 to every commander's pve_share post-clip z (then re-clipped to [-1, +1]).
- Pure empirical alternative: baseline = `+0.111` → shift = `-0.111`. Would *subtract* 0.111 from every commander's pve_share z.
- Net difference per commander row, per match: ~0.16 axis-shift × 0.12 weight = **0.019 P_i swing**, which translates to ~0.6 ELO per commander match at `K=12`. Across a 50-match commander career: ~30 ELO in our favor.

That's not nothing. The audit-vs-locked discrepancy is real and measurable.

**My honest assessment:** the critique is *partially right*, but the framing is wrong.

The "right" framing: VTSR-T's locked priors implement an explicit **normative** design choice — "commanders *should* do PvE work, so we reward it" — rather than a **descriptive** measurement of what they actually do. The code comments at `elo.py:133-139` document this intent verbatim. This isn't math-corruption; it's a deliberate trade-off between two valid philosophies of what a rating measures.

The "wrong" framing: "PandaSkill solves role asymmetry without hand-tuned overrides; therefore VTSR-T's overrides are wrong." That's not a math argument — it's a different design philosophy applied to a different game. PandaSkill was built for pro LoL, where role identity is fixed and contractual. Our commanders are *role-blind volunteers* — anyone can command on any given Friday night. The descriptive-only approach risks under-rewarding the rare-but-important commander volunteer for doing the unsexy work the team needs. That's a real cost the descriptive framework doesn't capture.

**Recommended fix:** the empirical tiebreaker. One-line change:

```python
COMMANDER_BASELINE_LOCKED_AXES = set()  # was {"target_lock_pct", "pve_share"}
```

Re-rate the corpus. Compare leaderboards (ρ, top-N agreement, per-player ELO delta histograms). Three possible outcomes:

1. Leaderboards barely move → locks aren't doing useful work, ship the unlocked version.
2. Commanders systematically drop → the descriptive framework is harsher on commanders than the normative one (which is what we'd predict). Decision becomes a values question: do we accept the harshness, or keep the locks as a documented design choice?
3. Some other axis interaction breaks → revisit.

The §5.1 validator can also tell us which version produces *better predictive accuracy* (rank correlation against next-match `P_i`). If unlocked predicts better, ship it. If locked predicts better, the normative design is paying for itself empirically. Either way, the answer is no longer hand-waving.

### 6.3. EOMM and the inflationary rating economy (§2.5 of the §1b reading)

**The claim:** soft floor (1000) + 0.85 loss aversion together create a non-zero-sum rating economy. Average rating drifts upward through participation alone, even at static skill. Cites Chen 2017 (foundational EOMM paper), Elmachtoub 2024 (*Management Science* on losing-streak churn), Kang 2024 (*Heliyon*, 6M Everybody's Marble matches showing weaker opponents reduce churn).

**My honest assessment:** the math is *correct*, and the citation stack is solid. This isn't a hot take — it's mainline matchmaking literature.

The math, for record: pure ELO is zero-sum (Σ ΔR = 0 across each match). VTSR-T is not, because:

- Loss aversion: every loss gets multiplied by 0.85, so the negative side of the zero-sum equation is dampened.
- Floor taper: losses near 1000 approach zero entirely.
- Net: Σ ΔR > 0 across every match (winners gain more than losers lose). Sustained over hundreds of matches per player, this is meaningful upward drift independent of skill.

**Why this matters for matchmaking specifically:** if Lobby Tools' Team Balonce is reading VTSR-T as a skill estimate, but VTSR-T is partially a participation reward, then balanced lobbies aren't actually balanced — they're balanced for *participation history*. The dual-track architecture from CS2 cleanly resolves this.

**Recommended fix: dual-track rating, the CS2 model.**

| Track | Used for | Mechanics |
|---|---|---|
| **Display Rating** (current VTSR-T) | Leaderboard, Player Profile, social comparison | All current EOMM mechanics retained: soft floor, loss aversion, K-factor decay |
| **Hidden MMR** (new `vtsr_t_pure`) | Lobby Tools' Team Balonce, §5.1 validator, future `α > 0` blend | Strict zero-sum: no soft floor, no loss-aversion multiplier, no floor taper. Same axes, same K shape. |

Implementation cost is moderate — `compute_elo()` runs twice with two parameter sets, emits two parallel JSON pairs (`elo_current.json` + `elo_current_pure.json`), and JS consumers wire to whichever one fits the question. The thug-only mode (v2.7) already established the precedent for parallel JSON pairs and a UI toggle.

**Open question (calls for the §5.1 validator to settle):** does Hidden MMR predict better than Display Rating? If yes, the dual-track is justified. If they predict identically, the EOMM mechanics aren't doing measurable harm and the dual-track is over-engineering.

---

## 7. Where the harder framings overstate

Three points where I disagree with the §1b reading's framing or specific recommendation. Each one has a defensible counter that's worth surfacing.

### 7.1. Full Glicko-2 RD migration is overkill (counter to §2.3 of the §1b reading)

**The §1b position:** deprecate match-count K entirely, port to Glicko-2 with a time-decaying RD.

**My counter:** match-count K decay is *real signal* — a 1-match player has more uncertainty than a 100-match player at the same elapsed time, and Glicko-2's RD encodes both signals together. v1's recommendation (additive inactivity boost on top of existing match-count decay) gets 80% of Glicko-2's benefit at 5% of the engineering cost.

**Pseudocode for the additive fix:**

```python
days_inactive = (now - last_match_date).days
inactivity_K_boost = min(20.0, 0.05 * days_inactive)  # caps at 400 days
K_i = base_K(matches_played) + inactivity_K_boost
```

**When to revisit Glicko-2:** if the §5.1 validator shows that ratings of returning players (>180 days inactive) systematically miscalibrate by >50 ELO even *with* the inactivity boost, the additive K isn't enough and a full Glicko-2 port becomes justifiable.

### 7.2. "Behavioral conditioning tool" is hyperbolic framing (counter to §2.4 of the §1b reading)

The §1b prose: "VTSR-T ceases to be an objective skill evaluator and operates as a behavioral conditioning tool."

**My counter:** every rating system embeds design intent. Pure win/loss Elo "conditions" players to value winning above all (including, e.g., feeding the carry). TrueSkill 2's quit-tendency penalty "conditions" players to stay in losing matches. PandaSkill's role-independence "conditions" players to stay in their lane. **There is no value-neutral rating system.** The honest framing is "what intent are we encoding, is it the intent we want, and is the empirical cost acceptable?" — which §6.2's ablation answers. Calling it "conditioning" rhetorically prejudges the question.

That said: the *underlying* point — that we've never tested whether the locks are doing useful work — is correct, and the §6.2 ablation is the right response.

### 7.3. MAX-only baseline ignores the lobby-calibration use case (counter to §2.2 of the §1b reading)

Already covered in §6.1. Short version: median is right for individual `P_i` calibration, MAX is right for team-outcome prediction, and the right answer is "ship both and let the validator pick" — not "deprecate median."

---

## 8. What the v1 measurement framework uniquely contributes

These items came from the Cambridge-grounded v1 reading and are unique to that critique. They survive the §1b lens unchanged:

1. **Bootstrap leaderboard stability** — 80% match resampling × 100 runs. Yields top-N Jaccard agreement *and* per-player rating std, which doubles as a real `±N` confidence band. Cheaper than Glicko-2 RD and produces an actually-empirical confidence interval.
2. **Self-consistency check** — first-half mean `P_i` vs second-half mean `P_i` per player. This is **the ceiling** for any rating system reading from the composite. If past `P_i` doesn't predict future `P_i`, no rating layer can fix that — we'd revisit the axes themselves before the rating math.
3. **Synthetic-winner proxy** — `synthetic_winner = team with higher mean P_i`, validated against `clean_win` subset. If ≥85% agreement, we sidestep the small-N winner problem and can validate `α > 0` blending against the full corpus.
4. **Axis correlation matrix + PCA** — tests whether the 8 axes double-count the underlying signal. `mobility ↔ thug_kill_rate`, `pve_share ↔ thug_efficiency`, etc. likely correlate; the composite weighted-sum implicitly assumes independence.
5. **Dirichlet weight perturbation** — sample `THUG_WEIGHTS` from a Dirichlet around the current point with concentration α=50 (tight) and α=10 (loose), recompute, measure leaderboard ρ. Detects whether we're tuning on a knife edge.
6. **Single-axis ablation** — drop each axis, re-rate, measure leaderboard ρ vs full system. An axis whose removal barely moves the rankings is dead weight.
7. **Log-loss / calibration metric** — distinct from top-1 accuracy. Cambridge §V.A admits they punted on this; it's one extra column in the validator output.

---

## 9. Combined recommendations, ranked

The unified action list. Each item attributes its source so future code reviews can trace claims back. "Source" abbreviations: **C** = Cambridge / v1, **A** = §1b production-systems reading, **B** = both.

| # | Action | Source | Effort | Impact | Data-gated? |
|---|---|---|---|---|---|
| 1 | **Build `scripts/validate_elo.py`** — rank correlation, calibration plot, self-consistency, bootstrap stability, axis ablation, log-loss, clean-win anchor, synthetic-winner proxy. Single JSON report. **Gates every other item below.** | B | Medium (1 week) | Highest | No |
| 2 | **Locked-priors ablation** — set `COMMANDER_BASELINE_LOCKED_AXES = set()`, re-rate, compare leaderboards and predictive accuracy via #1. Decide: keep locks, drop locks, or split (keep `target_lock_pct`, drop `pve_share`). | A | Trivial (1 hour + corpus re-rate) | Medium-High | No |
| 3 | **Parallel MAX-weighted `E_i`** — emit alongside median version, run #1 with both, decide. Three possible outcomes documented in §6.1. | A | Low (1 day) | High if MAX wins | No |
| 4 | **Sensitivity / stability suite** — Dirichlet `THUG_WEIGHTS` perturbation + jackknife match-dropout + axis correlation matrix + single-axis ablation. Bundles into #1's report. | C | Medium (1-2 days) | Medium-High (de-risks every other change) | No |
| 5 | **Inactivity-driven K boost** — additive `+min(20, 0.05·days_inactive)` on top of current match-count decay. Interim before optional full Glicko-2 port. | B | Low (half day) | Medium-High | No |
| 6 | **Synthetic-winner proxy validation** — once #1 ships, check `synthetic_winner = team with higher mean P_i` agreement rate against `clean_win` subset. If ≥85%, unlocks #8 against full corpus. | C | Trivial after #1 | High (unlocks #8) | Partial |
| 7 | **Parallel Hidden MMR (`vtsr_t_pure`)** — second `compute_elo()` pass with no soft floor, no loss aversion. Emit `elo_current_pure.json`. Compare predictive accuracy via #1. Foundation for full dual-track. | A | Medium (2-3 days) | Medium-High | No |
| 8 | **`α > 0` win/loss blend** — sweep `α ∈ {0.0, 0.1, 0.25, 0.5}` against #6's synthetic-winner accuracy or `clean_win` subset. Ship the value that maximizes both predictive metrics. | B | Low (after #6) | High (when unblocked) | **Yes — needs #6 or reliable winner data** |
| 9 | **Full dual-track architecture** — promote #7's `vtsr_t_pure` to first-class: Lobby Tools' Team Balonce reads from Hidden MMR, dashboard shows Display Rating, both surfaced in Player Profile pages. Mirrors CS2. | A | Medium (1-2 weeks) | High (matchmaking integrity) | No |
| 10 | **Optional: full Glicko-2 RD migration** — only if #1 + #5 prove the additive K-boost is empirically insufficient (>50 ELO miscalibration on returning players). | A | High (3+ weeks) | Probably small per Cambridge's own findings | No |

**Sequencing notes:**

- **Items #1–#5 ship in any order, none gated on winner data.** Do #1 first; everything else gets easier (and more justified) after.
- **#6 unlocks #8.** If the synthetic-winner proxy validates, we sidestep the small-N winner problem entirely and can ship `α > 0` against the full corpus.
- **#7 is the prerequisite for #9.** Ship #7 as a parallel JSON pair first (low risk, easy revert), promote to full dual-track once #1 confirms it predicts at least as well as Display Rating.
- **#10 is optional.** Cambridge's Figure 2 shows defaults are usually near-optimal; a full Glicko-2 port chasing 1-2% predictive lift we can't even measure yet is bad ROI until #5 proves insufficient.

The whole list is gated on **#1**. If you only do one thing, do #1.

---

## 10. Closing

The §1b production-systems reading sharpens v1's critique in three structural directions (median-vs-MAX, locked priors, EOMM/inflation) and brings a citation stack v1 didn't have (Dehpanah, TrueSkill 2's specific numbers, PandaSkill, the EOMM literature, CS2's dual-track). The thesis statement — "VTSR-T sacrifices zero-sum integrity for EOMM" — is correct on the math, defensible as a design intent, and resolvable via the dual-track architecture without abandoning the EOMM mechanics.

v1's unique contribution is the **measurement framework** itself: the validator design, bootstrap stability, synthetic-winner proxy, and axis correlation audit are the tools that turn every disagreement above into an empirical question instead of a debate.

The combined v2 path forward is therefore:

1. Build the measurement framework (§5.1, item #1).
2. Use it to settle every disagreement empirically (#2 locked priors, #3 MAX vs median, #7 dual-track).
3. Layer in the time-decay fixes (#5).
4. Once we have winner data or a validated proxy, blend `α > 0` (#8).
5. Promote the Hidden MMR to full dual-track (#9).
6. Reserve full Glicko-2 (#10) for when we've empirically demonstrated the additive K-boost is insufficient.

What we're missing across both critiques is not algorithmic sophistication — it's the discipline of empirical validation. **The single biggest takeaway from running both critiques side-by-side: the answer to almost every disagreement is "ship the validator, then settle it."** That's the one thing we should action immediately.

