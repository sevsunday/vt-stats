# Peer Review & Engineering Feedback: `VTSR next-gen analysis`

**Audience:** Claude / `vt-stats` rating-system developer  
**Context:** Grounded in `DATA_DICTIONARY.md` (through `match.schema_version` $36$), `VTSR v4: Both Sides of the Coin` (`validate_elo.py` $\S 1\text{--}\S 21$), and the `2026-11-18` $800$-game corpus ($292$ recorded matches + $508$ F9bomber ledger duels).  
**Purpose:** Stress-test the statistical claims, flag software-engineering and identifiability traps before implementation, resolve open operator policy questions, and tighten the execution sequence.

---

## 1. Executive Verdict

The analytical foundation of this plan is unusually strong. Owning $12$ concrete corrections to prior hypotheses, testing against F9-disjoint games, and converging on a **joint commanding-and-fighting model anchored on match outcomes with own-team damage as a fast prior** solves the core architectural flaw of `vt-stats`: three siloed ladders (`VTSR-T`, `VTSR-C`, and inert $R^W$) holding overlapping information about the same $25\text{--}48$ players without sharing it.

However, while the **statistical diagnosis** is right, the **implementation bridge** contains four concrete modeling traps and two engineering inefficiencies that should be fixed before writing production code:

1. **Todo #2 (`commander-fighting-meter`) risks double-counting fighting skill** inside `elo_commander.py` unless you prove the $+3.5\text{ pp}$ gain is not merely a cold-start prior for low-duel commanders.
2. **Todo #3 (`joint-model-forensic`) has unresolved identifiability, collinearity, and temporal stationarity problems**—and its headline walk-forward gain ($68.3\%$ vs. $63.4\%$, $p = 0.057$) carries multiple-testing optimism from tuning on duels $100\text{--}450$.
3. **Todo #4 (`own-team-scoring`) will break mathematically if tested naively** with per-team $z$-scores or opponent-referenced expected scores, and introduces zero-sum teammate incentives if used outside a result-anchored joint model.
4. **Several todos duplicate work** (polishing standalone Elo variants in Todos #2, #4, and #7 that Todo #3 is meant to supersede) or chase low-ROI / small-$n$ noise (Todos #6 and #8).

---

## 2. What the Plan Gets Decisively Right (Keep & Lock In)

Every one of the following findings is backed by strong internal and cross-corpus evidence and should serve as settled ground truth for the next phase:

* **Resolving the "Weak Thug Signal" Suppressor Effect:** Earlier `validate_elo.py` runs showed team-mean VTSR-T predicting winners at just $56.3\%\text{--}56.4\%$ (AUC $0.51\text{--}0.54$), tempting observers to conclude thugs barely matter. Demonstrating that stronger commanders systematically receive weaker thugs ($r = -0.32$) explains why thug strength was suppressed in univariate tests and why controlling for the commander gap snaps thug strength to $p = 0.0025$.
* **The F9-Disjoint Cross-Validation of `enemy_damage_share`:** Showing that telemetry `enemy_damage_share` correlates at $0.74\text{--}0.89$ with win-derived fighting effects estimated *solely* from F9bomber's $508$ ledger duels (zero overlapping matches) is the strongest validation result in the repository's history. It rules out the hypothesis that v2.14's single axis merely tracks lobby variance or damage-padding habits.
* **Reframing Commander Fighting Drop as Commanding Skill:** Proving that fighting output while commanding correlates at $0.64$ with win-derived commanding impact ($0.69$ on disjoint F9 duels) and is the *only* commander statistic whose historical average predicts the next duel ($z = 2.1$ on $216$ matches) invalidates treating commander combat drop purely as an external tax to be erased per player.
* **Killing Whole-Game Commander Economy Axes:** Showing that three of the four inert `VTSR-C` v2 economy axes (`pool_lead` $0.00$, `upgrade_time` $-0.11$, `non_green_share` $0.20$) carry near-zero signal once win/loss level is controlled—and that detecting any modest economy effect would require $400\text{--}900$ telemetry duels—justifies formally shelving `vtsr-c-v2-composite.md` rather than waiting years for confirmation data.
* **Confirming the $1\text{-Axis}$ Structure for Thugs & the $28:1$ Information Ratio:** Finding that PC1 holds $65\%$ of career stat variance and correlates $0.94$ with win-derived fighting effect—while one match of damage share provides $\sim 28\times$ the information of one team win/loss result ($r = 0.65$ vs. $-0.14$ after $10$ games)—validates both v2.14's simplification and the box-score-prior architecture (TrueSkill 2 / NBA RAPM).
* **Capturing Draft Pick Order (`record-draft`):** In a $25$-player pool, nightly commander drafts are a high-signal expert consensus ranking that captures unmeasured intangibles (comms, target priority, tilt, ship comfort) and is the *only* way to estimate first-pick advantage causally.

---

## 3. Hard Technical Analysis: Traps, Confounds & Required Fixes

### 3.1 Trap 1: Double-Counting & Cold-Start Confounding in Todo #2 (`commander-fighting-meter`)

**The Issue:**  
Todo #2 proposes implementing `cmdr_in_mean` immediately because Validator $\S 14$ improved from $62.3\%$ to $65.8\%$ (log-loss $0.631 \to 0.611$) on $292$ recorded duels and cleared `balonce-meter-t-term.md`. However, `balonce-meter-t-term.md` enforces that `scripts/elo_commander.py` and `js/balonce-meter.js` share the **exact same expected-score function**.

Look at what happens if you feed `cmdr_in_mean` into `elo_commander.py`'s live Elo update loop:

$$
\Delta_{\text{eff}} = (R_{C,1} - R_{C,2}) + \lambda \left(\bar{R}_{T,1}^{\text{(incl. cmdr)}} - \bar{R}_{T,2}^{\text{(incl. cmdr)}}\right)
$$

1. **Semantic Corruption of $R_C$:** Currently, $R_C$ measures a commander's *total* impact on winning (macro economy + build orders + fighting while commanding). Once you insert the commander's own $R_T$ into the handicap term *inside the Elo update*, $R_C$ stops measuring total commanding strength and becomes a **macro residual above fighting skill**. A strong-fighting commander (high $R_T$) faces a permanently inflated expected score $E$ on every duel, suppressing their published $R_C$ leaderboard rank relative to a weaker fighter who wins at the exact same rate with equal thugs.
2. **Likely Cold-Start Mechanism:** Across $34$ commanders, many have low duel counts where $R_C$ has barely moved from $1500$, whereas their $R_T$ (built from dozens of thug games) already reveals their mechanical baseline—and you found $\text{corr}(C, F) \approx 0.6$. Much of the $+3.5\text{ pp}$ gain on $292$ recorded duels may simply be $R_T$ acting as an ad-hoc prior for under-calibrated commanders.
3. **F9 Ledger Asymmetry:** The $508$ F9 ledger duels have no telemetry damage share. For commanders who appear primarily in F9 duels (or before their first telemetry match), `cmdr_in_mean` silently drops their fighting term to `1500` or omits it, creating an inconsistent handicap scale between F9 duels and recorded duels inside the same Elo walk.

**Required Diagnostic Before Implementing Todo #2:**  
Add a 2-bucket breakdown to Todo #1's saved study script:

* Split the $292$ duels into **Low-Experience** ($\min(n_{c_1}, n_{c_2}) < 15$ prior duels) vs. **Established** ($\min(n_{c_1}, n_{c_2}) \ge 20$ prior duels).
* Also test **Prediction-Only** (`cmdr_in_mean` applied to frozen $R_C$ without altering updates) vs. **Coupled Update** (`cmdr_in_mean` fed back into `elo_commander.py` updates).
* **Engineering Verdict:** If the gain lives primarily in low-duel commanders—or if coupling it into updates distorts veteran $R_C$ rankings—**do not ship Todo #2 as a standalone `elo_commander.py` patch.** Let Todo #3's joint model handle it cleanly via the correlated $(C_i, F_i)$ prior. Only ship Todo #2 first if `cmdr_in_mean` adds statistically clear log-loss gains on established commanders ($\ge 20$ duels) *and* you explicitly accept redefining $R_C$ as a macro-only residual.

---

### 3.2 Trap 2: Identifiability, Collinearity & Stationarity in the Joint Model (Todo #3)

The proposed joint model:

$$
\text{logit } P(A \text{ wins}) = (C_{c_A} - C_{c_B}) + w \cdot (\bar{F}_A - \bar{F}_B) + \text{matchup terms}
$$

$$
s_{i,m} \sim (F_i - \bar{F}_{\text{own team}, m}) + \delta_{i, \text{cmdr}} \cdot \mathbb{I}(\text{cmdr}) + \epsilon_{i,m}
$$

is conceptually right, but has **four mathematical and architectural loose ends** that must be nailed down in the decision memo before coding:

#### A. Parameter Identifiability & Collinearity ($C_i$ vs. $F_i$ vs. $\delta_{i, \text{cmdr}}$)
When the commander $c_A$ is included inside $\bar{F}_A$ (at weight $w / n_A$, or $1.5\text{--}2\times$ a thug's weight as noted in Findings), and simultaneously gets a free $C_{c_A}$ parameter *and* a per-player fighting-while-commanding offset $\delta_{i, \text{cmdr}}$, you are asking $15\text{--}18$ dual-role players to identify **three tightly coupled parameters** from noisy binary outcomes.

* **Consequence:** For a frequent commander with few thug games (or vice versa), the likelihood surface becomes flat along the ridge $C_i + \frac{w}{\bar{n}} F_i = \text{const}$. Small data perturbations will cause $C_i$ and $F_i$ to trade mass back and forth, destabilizing both displayed leaderboards.
* **Required Fix:**
  1. **Lock the role-offset hierarchy:** Model the fighting-while-commanding drop as a single hierarchical parameter $\delta_i \sim \mathcal{N}(\mu_{\delta}, \sigma_{\delta}^2)$ **strictly on the damage-share observation equation**, NOT as a separate free parameter inside the win-probability logit. Let $C_i$ absorb the player's entire commanding contribution *above* their baseline $F_i$.
  2. **Use an explicit bivariate Gaussian prior** on every player's latent skill pair:

     $$
     \begin{pmatrix} C_i \\ F_i \end{pmatrix} \sim \mathcal{N}\left(\begin{pmatrix} 0 \\ 0 \end{pmatrix}, \begin{pmatrix} \sigma_C^2 & \rho \sigma_C \sigma_F \\ \rho \sigma_C \sigma_F & \sigma_F^2 \end{pmatrix}\right)
     $$

     With $\rho \approx 0.6$ (frozen via CV on historical data before the confirmation window), a new commander automatically inherits the exact conditional prior $\mathbb{E}[C_i \mid F_i] = \rho \frac{\sigma_C}{\sigma_F} F_i$ without ad-hoc blending rules.
  3. **Clarify the Displayed $C_i$ Definition:** Decide and document whether the published `VTSR-C` ladder displays **Total Commanding Strength** ($C_i^{\text{total}} = C_i^{\text{macro}} + w_{\text{cmdr}} F_i$) or **Pure Macro Skill** ($C_i^{\text{macro}}$). For players, *Total Commanding Strength* is far more intuitive ("who wins more when commanding equal thugs?"), while the internal model decomposes it cleanly into macro + fighting.

#### B. Strict Concavity for Pipeline Determinism
`vt-stats` enforces a strict determinism contract (`DATA_DICTIONARY.md` $\S 11$: re-running `process_stats.py` must yield byte-identical ratings).

* **Engineering Requirement:** Formulate the joint model as a **Maximum A Posteriori (MAP)** penalized log-likelihood (Bradley-Terry logistic loss + Gaussian/Huber damage-share loss + bivariate Gaussian prior). Because the negative log-posterior is **strictly convex** in $(\mathbf{C}, \mathbf{F}, \text{matchup})$, `scipy.optimize.minimize(..., method="L-BFGS-B")` or damped Newton-Raphson converges in $< 0.2\text{s}$ to the **unique global optimum** with zero MCMC sampling noise and exact reproducibility across machines. Approximate posterior uncertainties (for rating deviation / confidence bars) come directly from the inverse Hessian (Laplace approximation) at the MAP mode: $\text{Cov}(\hat{\theta}) \approx H(\hat{\theta})^{-1}$.

#### C. Temporal Stationarity Bias (2025 vs. Late 2026)
A static batch fit across $800$ games assumes every player's skill was constant from January 2025 through November 2026. If a regular improved by $150$ points over $18$ months or returned rusty, a static batch model under-predicts their current form.

* **Required Fix:** Add **exponential time-decay likelihood weights** $w_m = \exp\left(-\frac{t_{\text{now}} - t_m}{\tau}\right)$ (or a lightweight WHR-style piecewise-time random walk, already cited in `VTSR v4` `[12]`). Test $\tau \in \{\infty \text{ (static)}, 365\text{d}, 180\text{d}, 120\text{d}\}$ in the walk-forward study. Exponential time decay preserves strict convexity, takes one line of code, and naturally prevents 2025 F9 ledger duels from anchoring a player's late-2026 rating forever.

#### D. History vs. Current Contract (Preventing UI/Audit Split-Brain)
The plan notes: *"refit on all history each pipeline run and emit walk-forward ratings for the per-match history."*

* **Software Engineering Warning:** If `elo_current.json` holds the full-corpus MAP estimate at $T$ while `elo_history.json` holds causal walk-forward values (each match $m$ using only $1 \dots m-1$), then for Match $T$, `history[-1].after` will equal `current`, **but** `history[m].after` will NOT equal `history[m+1].before` (Wait—in a refit model, `history[m]` refitted at $m$ *does* equal the pre-match rating entering $m+1$, because both condition on matches $1 \dots m$!).
* **Verify this invariant explicitly:** For every match $m$:
  * `before` = MAP estimate fitted on matches $1 \dots m-1$.
  * `after` = MAP estimate fitted on matches $1 \dots m$.
  * `delta` = `after - before`.
  * **Crucial quirk of batch refitting to flag for UI:** When Match $m$ finishes, a batch refit can slightly move the ratings of **players who did not even play in Match $m$** (indirect transitivity through their past opponents). Therefore, `history[m].deltas` must either record only match participants (accepting small drift between `history[m].after` and `history[m+k].before` for that player's next appearance) or explicitly document indirect drift in the tooltip/spec. Flag this before touching the frontend!

#### E. Multiple-Testing Optimism in the $68.3\%$ / $69.1\%$ Headline
Your Limits section honestly notes that model settings were explored on duels $100\text{--}450$ and tested on duels $450\text{--}800$ across many comparisons, yielding $p = 0.057$ on the last $350$ duels (log-loss $0.608$ vs. $0.616$, CI spanning zero). By standard post-selection inference, the true out-of-sample gain is almost certainly smaller than $+4.9\text{ pp}$ (likely $+1.5\text{ to }+3.5\text{ pp}$). That makes a **strictly prospective freeze** non-negotiable for the promote gate.

---

### 3.3 Trap 3: Own-Team-Relative Scoring Pitfalls (Todo #4)

Switching thug damage share from lobby-relative to own-team-relative cleanly eliminates the $23\%$ team-result variance leak (`VTSR v4` $\S 6$). However, implementing Todo #4 (`scripts/vtsr_t_variants.py`) requires three strict mathematical guardrails:

1. **Never Compute Per-Team Standard Deviations ($z$-Scores):**  
   In a $3\text{v}3$, a side has only **$2$ thugs**; in a $4\text{v}4$, only **$3$ thugs**. Dividing by a $2$-player sample standard deviation reproduces the exact $\pm 0.5$ mathematical collapse that forced `vt-stats` to exclude $1\text{v}1$ and $2\text{v}2$ from `VTSR-T` (`VTSR v4` $\S 10$).
   * **Use log-ratio or centered share instead:** For thug $i$ on a team with $k$ thugs and enemy damage values $d_1, \dots, d_k$ (excluding the commander, or including the commander with the role offset):

     $$
     y_{i,m} = \ln\left(\frac{d_{i,m} + \epsilon}{\text{geom\_mean}_{j \in \text{team}}(d_{j,m} + \epsilon)}\right) \quad \text{or} \quad y_{i,m} = \frac{d_{i,m}}{\sum_{j \in \text{team}} d_{j,m}} - \frac{1}{k}
     $$

     Notice that in a log-ratio formulation, $y_{i,m}$ is naturally scale-free across $3\text{v}3$, $4\text{v}4$, and $5\text{v}5$ without dividing by a noisy $2$-player SD!
2. **Fix the Expected Score Reference in Standalone Variants:**  
   If you test own-team scoring inside `scripts/vtsr_t_variants.py` using the existing standalone Elo updater while keeping $E_i$ referenced against the **opponent** median (`VTSR v4` $\S 2$), the math is internally inconsistent: a Tier 1 thug drafted onto a stacked team will earn a smaller share of their own team's damage than a Tier 1 thug carrying three Tier 4 thugs, yet both face the opponent reference. In any standalone own-team variant, $E_i$ **must** compare $R_i$ against the mean pre-match rating of player $i$'s **own teammates** ($\bar{R}_{\text{teammates}, i}$).
3. **Incentive Compatibility Warning (Zero-Sum Teammates):**  
   `VTSR v4` $\S 2$ explicitly cites Elo-MMR's incentive-compatibility guarantee (`[13]`). Pure own-team damage share is **strictly zero-sum among teammates**: if you cover a teammate or let them take a heavy tank so they deal $+20\%$ more damage, your own-team share drops.
   * **Why this is fine inside Todo #3, but dangerous standalone:** Inside the **Joint Model**, winning the game raises every teammate's outcome likelihood, counteracting zero-sum damage competition. As a *standalone* performance ladder (with $\alpha = 0$), own-team share could create perverse teammate incentives. Therefore, test Todo #4 *as an input component of Todo #3*, not as a replacement for standalone `VTSR-T`.

---

### 3.4 Trap 4: Low-ROI Research, Small-$n$ Fragility & Schema Realities (Todos #6 & #8)

* **Todo #6 (`commander-axes-memo`):**  
  The $0.91$ correlation for `AI-army damage` rests on **$n = 11$ commanders** on F9-only effects. With $n = 11$, a single player who mains turret/gun-tower/AI-heavy factions (e.g., Scion/Hadean defensive playstyles) can swing Pearson/Spearman $r$ by $0.30+$. Furthermore, per `DATA_DICTIONARY.md` $\S 2$, `assets.dealt` aggregates *all* `shooter == 0` entities owned by that slot (turrets, scavengers, AI wingmen, wreck explosions), which is heavily confounded by faction and map.
  * **Recommendation:** Write a short **retirement memo** formally closing out `vtsr-c-v2-composite.md`'s whole-game economy axes, and log the 4 shortlisted metrics (`own fighting`, `AI-army damage`, `production rate`, `early 8-min pool lead`) strictly as **descriptive display telemetry** on the Economy/Meta tabs. Do not register a scoring promote rule for commander economy axes until $n \ge 30$ commanders and $n \ge 300$ telemetry duels exist.
* **Todo #8 (`target-judgment-research`):**  
  Before writing raw `.binpb.gz` decoders for per-object-handle target-class damage, account for three facts already in `DATA_DICTIONARY.md` and your own study:
  1. **Schema 33 already exists (`DATA_DICTIONARY.md` $\S 5$):** `personal.enemy_pvp_dealt`, `personal.enemy_pve_dealt`, and `personal.enemy_structure_dealt_late` (last $180\text{s}$ base cleanup) are already computed in every match JSON. Test stripping `enemy_structure_dealt_late` from `enemy_dealt` first—it takes $5$ minutes and directly tests "garbage-time base demolition" without touching protobufs.
  2. **Proto v1 wire limitation:** Per `DATA_DICTIONARY.md` $\S 2$ and $\S 10.3$, legacy v1 `DamageDealt` events do not carry `victim` or `victim_odf`, so raw handle decoding only covers v2+ sessions.
  3. **Assignment Confounding Already Kills Naive Scrap Weighting:** Your own Findings show player-ship kills correlate $+0.88$ with fighting effect while extractor kills correlate $-0.55$ and scavenger kills $-0.54$, because commanders assign weaker thugs to pool duty while elite thugs control space and make selective pool plays. Weighting damage by target scrap cost will up-weight static/economic targets (Scavengers, Extractors, Factories) relative to cheap Scouts—almost certainly performing *worse* than unweighted `enemy_damage_share`. Keep Todo #8 strictly as low-priority exploratory research at the very bottom of the backlog.
* **Note on Bail-Out Hull Losses (`DATA_DICTIONARY.md` $\S 5$, `thug_supply` v19):**  
  `DATA_DICTIONARY.md` documents $659$ `victim == 0` thug-slot hull destructions corpus-wide (ejected/bailed-out ships). Because `enemy_dealt = enemy_pvp_dealt + enemy_pve_dealt`, `enemy_damage_share` is **already immune** to bail-outs (finishing an empty hull simply shifts from `enemy_pvp_dealt` to `enemy_pve_dealt`). However, `thug_supply.thug_ships_lost` *is* slightly attenuated by bail-outs, which may explain a small part of why `ships_lost` correlated $-0.08$ with win impact. Even so, given your finding that ship losses consume only $\sim 25\%$ of team income ($345 / 1240$ scrap), bail-out attribution is valuable for **Economy/Loadout display accuracy**, not a high-priority rating signal.

---

## 4. Recommended Answers to "Decisions That Are Yours"

Below are concrete, justified policy recommendations for the four open operator decisions (plus drift removal), ready to lock into decision memos:

### 4.1 Should displayed `VTSR-T` bands ever move on match results, or only the predictive number?
* **Recommendation:** **Yes—display the Joint Model's fighting skill $F_i$ as the single `VTSR-T` band once it passes its confirmation gate** (do **not** maintain separate "display VTSR-T" and "predictive VTSR-T" thug ratings).
* **Justification:**
  1. **Single source of truth:** Showing a player "Tier 1 $\cdot$ Upper" on the leaderboard while the Balonce Meter silently treats them as "Tier 2 $\cdot$ Lower" erodes community trust.
  2. **Zero whipsaw from single team losses:** Your own study proves one match of damage share carries $\sim 28\times$ the information of one team result. In the joint posterior, a thug's $F_i$ band will still respond rapidly and smoothly to how well they fight, while accumulated wins/losses over $50\text{--}100$ games gently anchor anti-farming and capture unmeasured impact (like target judgment and comms).
  3. **Eliminates the `wins_elo` ($R^W$) dead weight:** Unlike blending $R^W$ (which failed three times because $R^W$ applies an equal rank-$1$ update to all $5$ teammates), the joint model controls for both commanders and all $9$ other players in the lobby when extracting outcome signal for $F_i$.

### 4.2 How should commander games appear in the `VTSR-T` band?
* **Recommendation:** **Keep exactly two displayed ladders (`VTSR-T` and `VTSR-C`). Never add a third band.** Inside the joint model, treat commander games as updating $C_i$ via match outcome and contributing to $F_i$ *only* through the hierarchical role-offset equation (with higher observation variance $\sigma_{\text{dmg, cmdr}}^2 > \sigma_{\text{dmg, thug}}^2$ so commander-game macro stress cannot whipsaw a player's `VTSR-T` band).
* **Justification:**
  1. A $25\text{--}48$ player pool cannot sustain three displayed skill bands without creating sparse, noisy tiers.
  2. Giving commander-row damage a larger observation noise variance ($\sigma_{\text{dmg, cmdr}}^2$) naturally lets a player's thug games anchor their fighting band $F_i$ once they have thug history, while still letting a pure-commander seed their $F_i$ smoothly.

### 4.3 Should we keep the low-tier at-base lift (`v2.8`)?
* **Recommendation:** **Cancel Roadmap Phase 7(c) (all-tier ship-denied lift), and run an ablation in Todo #1 to retire `v2.8` alongside drift removal.**
* **Justification:** Your variance decomposition—**$15\%$ of at-base time variance belongs to the thug vs. only $4\%$ to the commander**—reverses the original premise of `v2.8` and Phase 7(c). If time on foot is nearly $4\times$ more a property of the thug (feeding ships, poor positioning, or being lower priority in the reship queue because of lower impact) than of the commander, then crediting at-base time subsidizes losing ships. Confirm via ablation that removing `v2.8` does not hurt walk-forward log-loss or Spearman $\rho$, then retire it cleanly.

### 4.4 Should we remove drift (`k_loss_aversion = 0.85` and `1000` floor)?
* **Recommendation:** **Yes—remove all loss aversion and floors from the mathematical rating engine; keep psychological cushioning strictly in the display layer.**
* **Justification:**
  1. As `VTSR v4` $\S 6$ and your analysis show, `k_loss_aversion = 0.85` plus the `1000` floor caused pool mean drift from $1532 \to 1622$ (and $1697.5$ among active players) and stretched the VTSR-T standard deviation to $182.4$, distorting both calibration and cross-ladder scaling.
  2. `vt-stats` **already shipped the superior psychological cushion**: `VTSR-T` is never shown as a raw number—only as sticky bands with a $20$-point promotion/demotion hysteresis buffer (`scripts/vtsr_bands.py`, `DATA_DICTIONARY.md` $\S 11$). Keep the underlying math zero-centered and drift-free ($\sum C_i = 0, \sum F_i = 0$, mapped to $1500$ for display) and let the sticky band buffer handle player sentiment.

### 4.5 What should the pre-registered Promote Rule be for the Joint Model?
* **Recommendation:** Freeze all hyperparameters (prior variances $\sigma_C^2, \sigma_F^2$, correlation $\rho$, fighter weight $w$, damage likelihood weight, time-decay $\tau$, and shrinkage) in a committed memo **before** counting confirmation duels. Evaluate strictly on **$N \ge 60$ prospective, non-void, decided duels** dated after the freeze date.
* **All four criteria must pass to promote:**
  1. **Primary Metric — Paired Out-of-Sample Log-Loss:** Strictly lower mean log-loss than the canonical VTSR-C + Balonce formula by at least $\Delta \text{LL} \le -0.010$, **and** the one-sided paired bootstrap $95\%$ CI on $\text{LL}_{\text{joint}} - \text{LL}_{\text{canon}}$ lies below $0$ (or at least $90\%$ of paired bootstrap resamples favor the joint model, acknowledging $n = 60$ power limits).
  2. **Headline Accuracy Guardrail:** Winner-call accuracy on the $N \ge 60$ confirmation duels is $\ge$ canonical accuracy (no trading away correct picks for extreme-confidence calibration).
  3. **Calibration Guardrail:** Expected Calibration Error (ECE) or Brier Score on the confirmation duels is strictly better than or within $+0.005$ of canonical.
  4. **Subgroup Integrity:** Evaluate **recorded telemetry duels** separately from **F9 ledger duels** (if any new F9 drops arrive); the joint model must not degrade log-loss on recorded telemetry duels.

---

## 5. Additional Engineering & Governance Items Missing from the Plan

1. **Close Out the Open Phase 6 Faction Gate First:**  
   In `VTSR v4` (`2026-10-22`), Phase 6 (`critique/decisions/phase-6-faction-advantage-term.md`) sat at $31$ of $60$ confirmation non-mirror duels after `2026-10-04`. Your `2026-11-18` corpus added $\sim 44$ rated matches since Oct 22—meaning **Phase 6 may already be at or past its $60$-duel trigger!** Score and close Phase 6 (PROMOTE or DISCARD) in Todo #1 so you know whether a global Hadean faction term enters the joint model's `matchup terms` as a validated baseline or stays out.
2. **Cross-Language Parity Test (`Python` $\leftrightarrow$ `JS`):**  
   `js/balonce-meter.js` and `scripts/elo_commander.py` must compute identical win probabilities (`DATA_DICTIONARY.md` $\S 11$). Add a deterministic golden-vector unit test (e.g., `_investigation/check_balonce_parity.mjs` reading $20$ fixture lobbies exported by Python) asserting $|\hat{P}_{\text{py}} - \hat{P}_{\text{js}}| < 10^{-6}$ on every pipeline run.
3. **Zero-Friction Draft Capture Schema (`record-draft`):**  
   Never make draft-order entry a mandatory blocking step in `process_stats.py` (unlike outcome adjudication, missing draft data should never block publishing a match). Store optional draft records in a committed sidecar `data/match_drafts.json` keyed by `match_id`:

   ```json
   {
     "schema_version": 1,
     "drafts": {
       "2026-11-20T02-15-00": {
         "coin_flip_winner_team": 1,
         "first_pick_team": 1,
         "commanders": { "1": "7656...", "2": "7656..." },
         "picks": [
           { "pick_num": 1, "team": 1, "steam64": "7656..." },
           { "pick_num": 2, "team": 2, "steam64": "7656..." }
         ],
         "source": "tools_ui"
       }
     }
   }
   ```

   Provide a one-click "Copy draft JSON" / "Save draft" workflow directly inside `Tools` $\to$ `Team Balonce` where teams are already being arranged before the lobby launches.

---

## 6. Revised Order of Work (Consolidated & De-Duplicated)

Instead of executing the 8 original todos sequentially—which risks shipping standalone Elo patches (Todos #2, #4, #7) right before replacing them with the joint model (Todo #3)—re-sequence as follows:

1. **Step 1 — Reproducibility & Housekeeping (Merge Todo #1 + Phase 6 Closure):**
   * Commit all read-only study scripts from this session beside `scripts/validate_elo.py` and verify every figure reproduces from `data/processed/` and `data/external/f9_ledger.json`.
   * Check whether `critique/decisions/phase-6-faction-advantage-term.md` has reached $60$ post-`2026-10-04` non-mirror duels and record its verdict.
   * Run the **low-duel vs. veteran-commander** stratification on `cmdr_in_mean` AND the **`v2.8` low-tier lift ablation** inside the same study script.
2. **Step 2 — Start Data Capture Immediately (Move Todo #5 Up):**
   * Ship optional coin-flip & pick-order capture (`data/match_drafts.json` + Tools page helper) *now*. Every match night that passes without recording pick order is permanently lost data, whereas models can always be refitted retroactively.
3. **Step 3 — Conditional Gate on Todo #2 (`commander-fighting-meter`):**
   * *Only* implement `cmdr_in_mean` in `elo_commander.py` / `balonce-meter.js` if Step 1 proves it improves established-commander ($\ge 20$ duels) log-loss without corrupting veteran $R_C$ rankings. Otherwise, mark Todo #2 as **superseded by the Joint Model** so you don't churn the production schema twice.
4. **Step 4 — Joint Model Forensic Alt Mode (Merge Todos #3, #4, and #7):**
   * Fold **own-team log-ratio damage scoring** (Todo #4) and **zero-centered drift-free MAP estimation with exponential time decay** (Todo #7) directly into one clean decision memo (`critique/decisions/joint-skill-model.md`).
   * Implement as a strictly convex MAP solver (`scipy.optimize.minimize`, deterministic Laplace uncertainty) emitting forensic `elo_joint_current.json` / `elo_joint_history.json` alongside canonical outputs.
   * Freeze hyperparameters and start the $60$-duel prospective confirmation clock.
5. **Step 5 — Cleanup Memo & Backlog (Todos #6 and #8):**
   * Write a brief closure memo retiring the whole-game `VTSR-C` v2 economy axes and keeping `own fighting`, `AI-army damage`, `production rate`, and `8-min pool lead` as display-only telemetry.
   * Keep raw-handle target-class decoding (Todo #8) at the bottom of the backlog; run the cheap Schema 33 `enemy_structure_dealt_late` ablation first before touching raw protobufs.