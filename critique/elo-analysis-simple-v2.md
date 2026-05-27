# VTSR-T Analysis v2 — Plain Edition

> The same synthesis as `elo-analysis-v2.md`, written for someone who doesn't want to wade through equations. This combines two critiques: the original Cambridge-paper-grounded read (in `elo-analysis.md`) and a deep-research follow-up benchmarking VTSR-T against shipping production systems (in the `.docx` file and its companion `web/index.html` visualization). Where they agree, we treat it as load-bearing. Where they disagree, we settle it with measurement.

## TL;DR

- **What we got right (still right after the second critique):** rating each *player* (not each team), giving new players bigger rating swings, using a soft floor so people don't get permanently stuck, and adjusting commanders so they aren't unfairly punished for not racking up kills. Both critiques leave these alone.
- **The single biggest gap, both critiques agree:** we have never measured whether VTSR-T predicts anything. Until we ship a validator, every other fix is a guess.
- **Three new structural critiques that v1 missed:**
  1. **Median vs MAX baseline** — there's a paper (Dehpanah 2021, 100k+ matches across PUBG, LoL, and CS:GO) showing that in tactical shooters, team threat is dominated by the *highest-rated* member, not the average or median. We use the median. The honest answer: median is right for some questions, MAX is right for others, and we can ship both and let the validator decide.
  2. **Locked priors on commander adjustment** — for two of the eight axes, we've manually overridden the empirical data with hand-picked values. The harder reading calls this "behavioral conditioning"; I'd call it "documented design intent." Either way, we've never tested whether the locks actually help. One-line ablation, easy to settle.
  3. **The rating economy is inflationary** — the soft floor and loss-aversion multiplier together mean total rating across all players drifts upward over time, even at static skill. Counter-Strike 2 ships a dual-track architecture (pure hidden MMR for matchmaking + inflationary display rating for community) that resolves this without abandoning the soft-floor protections.
- **Where the harder framings overstate:** the §1b reading wants to deprecate match-count K-factor entirely in favor of full Glicko-2; I think a smaller fix (just bump K when players are inactive) gets 80% of the benefit at 5% of the cost. It uses harsh language ("behavioral conditioning tool") for what's really a documented design choice. And it overstates the median-vs-MAX critique — both have valid uses.
- **The combined "what we can do today" list is ten items.** Six need no winner data and could ship in weeks. The biggest single recommendation: build the validator first.

---

## 0. What the validator actually told us (Phase 1 + 2A — done)

This section was added after the doc was first written. We built the validator (the "single biggest recommendation" above) and ran it on 100 matches, 35 players, 30 confirmed clean wins. Here's what it found, in plain English.

### Things that worked

- **Past performance does predict future performance.** When you split each player's matches in half and check whether their first-half average score predicts their second-half average, the agreement is very strong (0.80 out of 1.0). This means the eight axes are doing real work — the system is measuring something real about each player, not noise. **If this number had been low, no rating math could fix it.** It wasn't low.
- **Pre-match rating predicts how you'll do in the next match.** Across 884 player-matches, the rank correlation between "your rating going in" and "your composite score that match" is 0.46. Not perfect, but well above noise. Higher-rated players really do score better.
- **The leaderboard is stable.** When we randomly resample 80% of matches and re-run the rating 100 times, the top 20 stays mostly the same (83% overlap). Per-player rating jitter under resampling is about ±27 points — that's a real confidence band we could show on the dashboard.
- **The system isn't tuned on a knife edge.** Wobble the eight axis weights randomly and the rankings barely budge. Drop entire axes one at a time and almost nothing changes for `snipe_bonus` (those points are basically dead weight) or `target_lock_pct` (small but measurable). The most load-bearing axis is `net_damage_share` — drop it and rankings shuffle visibly.

### Things that broke in interesting ways

- **The synthetic-winner proxy passed.** When we declare "the team with higher average composite performance won" as a fake winner and check it against the 30 matches where we *know* the real winner, the fake winner agrees 93% of the time. That's well above the 85% threshold we set. **The huge consequence:** we no longer need reliable winner data to ship a `α > 0` blend (item #8 on the list). The fake winner is good enough to test against the full corpus.
- **The system is *worse than chance* at predicting team wins from team average rating.** This was the big finding. Across the 30 clean-win matches, "team with higher mean rating" picks the actual winner only 43% of the time. Random would be 50%. Cambridge's CS:GO results were 60–64%. We were below the floor.
- **Phase 2A then ran a follow-up experiment that explained the 43%.** Instead of using each team's *average* rating, try the *highest* rating on each team — Dehpanah's 2021 paper said the top player matters most in tactical shooters. Result: accuracy jumped to 53% (+10 percentage points). This is "directionally confirmed" — the sample size is small (30 matches) so the confidence intervals overlap, but the lift is in exactly the direction the paper predicted. **This is what makes Phase 2C the magnum opus.**
- **The commander breakout was dead on arrival.** We wanted to compare prediction accuracy on matches *with* a commander vs matches with *no* commanders. Out of 30 clean-win matches, all 30 had at least one commander. We can't run that comparison until we have either (a) more matches, or (b) a different ground-truth subset.
- **The rating-gap breakout reframed the headline.** We wanted to check: does the rating predict better when one team is clearly stronger? Out of 30 clean-win matches, *zero* had a rating gap of more than 100 points between the two teams. This means the 43% number is being measured *only on tightly balanced matches* — exactly the matches where the rating shouldn't be expected to do well. The rating's true predictive ceiling on lopsided matches remains untested.

### What this changes about the plan

The validator (item #1) and the sensitivity suite (item #4) and the synthetic-winner proxy (item #6) are all done. The MAX-vs-mean experiment (item #3) is now the highest-priority active item — Phase 2A told us where the broken thing is, and item #3 is the fix. The locked-priors ablation (item #2) and inactivity K-boost (item #5) are also active, alongside item #3, in the next week or two.

The Hidden MMR / dual-track / α > 0 / Glicko-2 items (7, 8, 9, 10) are deferred. None of them have empirical urgency from the Phase 2A data — and #8 specifically depends on item #3 landing first (we want the right team-aggregation math before we start blending winners against it).

> **In one sentence:** the eight axes work, the per-player rating is well-calibrated, and the team-aggregation math is the thing we got wrong — exactly what §6.1 hypothesized.

---

## 1. The two critiques in one paragraph each

**The Cambridge paper** (`csgo-rating-paper.pdf`) tested five rating systems on 10,000 professional CS:GO matches and asked one question: can the system predict the winner before a match starts? Random gets 50%, the dumbest baseline gets ~60%, the best system tested gets 64.1%. Their key finding: rating each individual player works better than rating each team. Their key blind spot: their dataset is win/loss only, so they couldn't evaluate any system that uses richer per-player performance data — which is exactly what we use.

**The §1b production-systems reading** approached VTSR-T from a different angle: it benchmarks the system against modern *production* rating systems used in shipping games today, not against academic datasets. It cites five outside sources: the Cambridge paper, a paper on team aggregation methods (Dehpanah 2021), Microsoft's TrueSkill 2 from Halo 5, a 2025 League of Legends production system called PandaSkill, and a stack of papers on "Engagement Optimized Matchmaking" (EOMM). Its thesis: VTSR-T sacrifices mathematical zero-sum integrity in favor of EOMM principles. That's a fair claim and it deserves a direct answer (which is in §6.3).

---

## 2. What our system does, in plain English (recap)

Every player has a single number called VTSR-T, starting at 1500. After each match, the number goes up or down based on how the player did **relative to everyone else in that lobby**, on eight different measurements: damage dealt minus damage taken, kills per minute, accuracy (compared to lobby weapon norms), efficiency, PvE share, mobility, snipe count, and T-key target lock dwell. We weight these eight, sum them into a single performance score for the match, and compare that to what we'd expect from a player at their current rating.

Two extra mechanics: new players get bigger rating swings (high "K-factor"); experienced players get smaller ones. And losses near the rating floor of 1000 hurt less and less.

We exclude two kinds of rows entirely: spectators (people in camera pods more than 25% of the match) and people who clearly came in late or left early. There's also a special adjustment for commanders, because the data showed they naturally have lower kills, less movement, and so on — so we built a system that gives them a fair handicap on those specific axes.

---

## 3. Three-way side-by-side

| What it tracks | Cambridge's best (TrueSkillPlayers) | Production-systems target | VTSR-T (current) |
|---|---|---|---|
| Per-player or per-team? | per-player | per-player | per-player ✓ |
| What goes in? | only "did your team win?" | win/loss + composite performance | only composite performance |
| Confidence parameter | yes (grows with time) | yes, time-decaying | only a binary "Provisional" flag |
| Who do we compare each player to? | each opponent individually | the *highest-rated* opponent | the *median* opponent |
| Soft floor / loss aversion? | none | none for matchmaking; OK for display | yes, on both |
| Special handling for inactive players? | yes (uncertainty grows) | yes (Glicko-2 RD) | no |
| Dropouts / late joiners? | none | not addressed | yes, we exclude them cleanly |
| Has anyone ever measured if it works? | yes | yes | **no** |

---

## 4. What we got right (both critiques leave these alone)

These six things hold up under both critiques. Carry forward unchanged from v1.

**Per-player rating.** Cambridge's #1 finding. Uncontested by either critique. With our roster churn this was unambiguously correct.

**Soft floor + loss aversion** (with one caveat). The §1b reading calls these "EOMM" and says they create rating inflation. v1 defended them as community-trust mechanisms. Both are right. The fix isn't to remove them — it's the dual-track in §6.3.

**Eight game-specific axes.** Microsoft's TrueSkill 2 made its big lift (52% → 68% Halo 5 prediction accuracy) by adding in-match performance signals — exactly what we did. Neither critique disputes the axes themselves; the harder reading's critique is about how those axis values get *adjusted* per role.

**Bayesian-style commander adjustment** (for the four audit-derived axes). The math is structurally identical to a conjugate Bayesian prior — the same family underlying Glicko/TrueSkill. As we collect more commander data, the live data takes over the seed. The locked-prior critique applies to two of the eight axes, not to the shrinkage mechanic itself.

**Pure-omission exclusion gates** (campod, low-activity, optional commander toggle). These don't penalize affected players; the match just didn't happen for them, with audit counters logging when each gate fired. Cambridge's systems handle none of this; the §1b reading doesn't mention it.

**K-factor decay shape** (the *match-count* part). New players get high K, veterans get low K. This is roughly what Glicko's "rating deviation" does, just with simpler math. What's missing is the *time* component (§5.2 + §7.1).

---

## 5. Where the critiques converge (highest priority, both critiques agree)

### 5.1. We never check whether our rating actually predicts anything

This is the single biggest gap. Both critiques land here. Until we have a validator, every other fix is a guess.

**Important caveat: we don't have reliable winner data — and it doesn't matter.** Our `match.winner` field is inferred from the kill feed, and only the small subset of matches where one team got fully wiped without rebuilding (the `clean_win` rows) is reliable. But we have something the paper didn't have: a per-player performance score for every player in every match. We can validate against that today.

**Six things we can validate now, no winner data required.** All run on data we already have:

1. **"Does pre-match rating predict in-game performance rank?"** For each match, do players with higher pre-match ratings actually score higher on the composite? Average the rank correlation across all matches. Single most important number.
2. **"Are our predictions calibrated?"** When the system says "this player should outperform their lobby by X amount," does that prediction match what actually happens on average? Group player-matches by their pre-match rating gap and plot the actual average performance for each group.
3. **"Does past performance predict future performance?"** Take each player's first half of matches, compute their average performance score. Does that predict their second-half average? This sets a *ceiling* for any rating system: if past P_i doesn't predict future P_i, no rating built on top can predict either.
4. **"How stable is the leaderboard?"** Re-run the rating computation on random 80% subsets of matches, do this 100 times, see how much the leaderboard order shuffles. As a bonus, the spread we see across 100 runs *is* a real confidence band — we could finally show "1742 ± 23" next to each player's rating.
5. **"On the matches where we DO know the winner, does our rating predict it?"** Even with only ~50–100 reliable `clean_win` matches, ask whether the team with higher average pre-match rating actually won. Wide confidence interval, but anchors us to skillbench-style numbers.
6. **"Synthetic winner from average performance"** — declare "the team with higher average composite performance won" as a fake winner. If that fake winner agrees with the real winner on the reliable subset 85%+ of the time, we use the fake winner as a proxy on the *full* corpus, sidestepping the small-sample problem entirely.

**Plus log-loss / calibration.** Both critiques flag that simple top-1 accuracy isn't enough — saying "Player A is 51% likely to outperform Player B" and "95% likely to outperform Player B" are different statements, but right/wrong accuracy can't tell them apart. Adding log-loss is one extra column in the validator output.

**Plus stability checks** that don't even need predictions:
- Drop one match at a time, re-run, see if the leaderboard barely budges.
- Wobble the eight axis weights by 10-20% randomly, re-run, see if rankings stay stable.
- Drop one axis at a time, see if rankings change (axes whose removal barely matters are dead weight).
- Compute the correlation matrix between the eight axes (if two are 0.8+ correlated, we're double-counting).

**The deliverable:** one new script (`scripts/validate_elo.py`) that walks the matches in order and outputs a JSON report covering all of the above.

### 5.2. Returning players are mishandled

Both critiques flag this. If a player goes inactive for 8 months and comes back, our system treats them like a player who played yesterday. Glicko-2's whole reason for existing is that this is wrong: a long-inactive player is *uncertain*, and rating updates should be larger to re-locate them in the league. Our K-factor only knows about *career* matches played, not *recency*. The fix: bump K up when a player has been gone for a while.

(The §1b reading wants the full Glicko-2 RD migration here. I think the smaller fix is enough until proven otherwise — see §7.1.)

### 5.3. We have no idea how stable our rating is to small parameter changes

We've got a *lot* of dials: 8 axis weights, 6 commander adjustment values, learning-rate constants, the floor taper width, the loss-aversion factor, etc. None has been rigorously tested. The Cambridge paper does this analysis on TrueSkill (Figure 2) and finds the defaults are nearly optimal — but they had to test it to know.

The fix: random-perturbation testing. Goes into the same validator script.

---

## 6. New things the §1b reading surfaces

Three real critiques that v1 missed.

### 6.1. Median vs MAX — both have a use

**The claim:** Dehpanah et al. 2021 (100k matches across PUBG, LoL, CS:GO) showed that in tactical shooters, team threat is dominated by the *highest-rated* member. We use the median. Therefore (the harder reading argues) we're miscalibrating.

**My honest take:** the critique is partially right. The claim mixes up two different uses:

- **For "what should I expect from this individual player?":** the median is right. It's robust to one ringer warping the lobby norm.
- **For "which team is favored to win?":** the MAX matters more. The carry's lethality dominates outcomes.

We currently use the median for the first job, but the *applications* of VTSR-T (matchmaking, future win/loss blending) implicitly depend on the second. Same rating, two jobs, different math.

**The fix:** ship a parallel MAX-weighted version *alongside* the median version. Run the validator with both. Three possible outcomes: median wins for one job, MAX wins for the other (most likely); MAX wins for both (the harder critique is right); median wins for both (v1 was right and the finding doesn't transfer to BZCC). Empirically settle-able in days.

**Phase 2A update (validator preview, completed):** the validator now scores three different ways to combine team ratings on the 30 clean-win matches:

| How we combine team ratings | Picked the right winner |
|---|---|
| Average of all rated players (current) | 43% |
| **Highest single player on each team** | **53%** |
| Smoothed-highest (favors top players, doesn't ignore the rest) | 47% |

The Dehpanah paper said "the highest-rated player dominates in tactical shooters." The validator says, on our data, hard MAX gives a +10 percentage-point lift over our current mean approach. The sample is small (30 matches), so the confidence intervals overlap and we can't yet say "decisive" — but the direction is the one the paper predicted. **Phase 2C is now the highest-priority active item:** ship MAX (and a smoothed version) as parallel rating files, do the *full* corpus re-rate (not just this validator preview, which is a post-processing reweight), and let the validator pick the winner.

### 6.2. Locked priors — descriptive vs normative

**The claim:** for two of the eight axes (`pve_share` and `target_lock_pct`), we've manually locked override values that contradict the empirical data. Specifically:
- `pve_share`: empirical data says commanders do 0.111 *more* PvE than thugs (above lobby norm). Our locked override turns this into a +0.05 *reward shift* per commander match.
- `target_lock_pct`: empirical data says commanders use the T-key 0.466 *less* than thugs. Our locked override only docks them by 0.10 (a small cushion, not full pardon).

PandaSkill (a 2025 League of Legends production system) is cited as a modern alternative that handles role asymmetry without any hand-tuned overrides — it just lets the empirical role data adapt freely. Therefore (the harder reading argues) we're a "behavioral conditioning tool, not a skill evaluator."

**My honest take:** the math discrepancy is real and measurable. Net effect: each commander match gets ~0.6 ELO of "credit" from the locks at K=12, accumulating to ~30 ELO across a 50-match commander career. That's not nothing.

But the framing is a values question, not a math question. Our locked priors implement an explicit **normative** design choice: "commanders *should* do PvE work, so we reward it; commanders shouldn't fully escape their target-lock obligations, so we don't fully pardon them." The code comments document this verbatim. Calling it "corruption" prejudges the question.

**The fix:** the empirical tiebreaker. Set `COMMANDER_BASELINE_LOCKED_AXES = set()` (one-line change), re-rate the corpus, compare. Three possible outcomes:
1. Leaderboards barely move → locks aren't doing useful work, drop them.
2. Commanders systematically drop → values question, decide explicitly.
3. Some axis interaction breaks → revisit.

Run the §5.1 validator with both versions. If the unlocked version *predicts better*, ship it. If the locked version predicts better, the normative design is paying for itself empirically. Either way, no more hand-waving.

### 6.3. The rating economy is inflationary — and CS2 has the fix

**The claim:** soft floor (1000) + 0.85 loss aversion together break Elo's zero-sum property. Total rating across the corpus drifts upward over time, even at static skill. Backed by three EOMM citations (Chen 2017, Elmachtoub 2024, Kang 2024). Counter-Strike 2 ships a dual-track architecture (pure Hidden MMR + inflationary Display Rating) that resolves this without dropping the EOMM mechanics.

**My honest take:** the math is correct. Pure Elo has every match summing to zero ΔR. Ours has every match summing to *more than zero* (winners gain a full delta, losers lose 0.85 of one). Sustained over hundreds of matches, this is meaningful upward drift independent of skill.

**Why this matters specifically:** if Lobby Tools' Team Balonce reads VTSR-T as a skill estimate, but VTSR-T is partly a participation reward, then "balanced lobbies" are actually balanced for *participation history*, not skill. That's a real bug in matchmaking.

**The fix: dual-track, the CS2 model.**

| Track | Used for | Mechanics |
|---|---|---|
| **Display Rating** (current VTSR-T) | Leaderboard, profiles, social comparison | All current EOMM mechanics retained |
| **Hidden MMR** (new pure version) | Lobby Tools' Team Balonce, the validator, future win/loss blending | Strict zero-sum: no soft floor, no loss aversion, no taper. Same axes, same K shape. |

Implementation cost is moderate. We literally just run the rating computation twice with different parameters and emit two parallel JSON files. The thug-only mode (already shipped in v2.7) established this exact pattern with parallel JSON pairs.

**Open question for the validator:** does Hidden MMR predict better than Display Rating? If yes, the dual-track is justified. If they predict identically, the EOMM mechanics aren't doing measurable harm and the dual-track is over-engineering. We can settle this empirically.

---

## 7. Where the harder framings overstate

Three places where I disagree with the §1b reading's framing or specific recommendation.

### 7.1. Full Glicko-2 migration is overkill

**The §1b position:** deprecate match-count K-factor entirely, port to Glicko-2 with a time-decaying confidence parameter.

**My counter:** match-count K decay is *real signal*. A 1-match player has more uncertainty than a 100-match player, even at the same elapsed time. Glicko-2's parameter happens to encode both (matches-played and time-since-played) together, but you don't need a full port to capture the time-decay benefit. The smaller fix:

```
inactivity_K_boost = min(20, 0.05 * days_inactive)
K_i = base_K(matches_played) + inactivity_K_boost
```

This adds inactivity-driven uncertainty growth to our existing K-factor without changing anything else. 80% of Glicko-2's benefit at 5% of the engineering cost. **When to revisit:** if the validator shows returning players (>180 days inactive) systematically miscalibrate by >50 ELO even *with* the boost, that's the signal to do the full Glicko-2 port.

### 7.2. "Behavioral conditioning tool" is hyperbole

The §1b prose calls VTSR-T "a behavioral conditioning tool rather than an objective skill evaluator." That's rhetorically punchy but it elides a real point: every rating system embeds design intent.

- Pure win/loss Elo "conditions" players to value winning above all (including, say, feeding the carry instead of maximizing personal stats).
- TrueSkill 2's quit-tendency penalty "conditions" players to stay in losing matches.
- PandaSkill's role-independence "conditions" players to stay in their assigned role.

There is no value-neutral rating system. The honest framing is "what intent are we encoding, is it the intent we want, and does it cost us empirically?" — which §6.2's ablation answers. Calling it "conditioning" rhetorically prejudges the question. That said: the *underlying* observation — we've never tested whether the locks are doing useful work — is correct, and the fix is the ablation.

### 7.3. MAX-only ignores the lobby-calibration use case

Already covered in §6.1. Median is right for one job, MAX is right for another, and "ship both and let the validator pick" beats "deprecate median."

---

## 8. What the v1 measurement framework uniquely contributes

These items came from the Cambridge-grounded v1 reading and the §1b reading didn't surface them. Carry forward in v2:

1. **Bootstrap leaderboard stability** — re-run the rating on random 80% subsets 100 times, see how much the leaderboard shuffles. As a bonus, the spread across runs *is* a real ±N confidence band per player.
2. **Self-consistency check** — does past P_i predict future P_i? Sets the *ceiling* for any rating system reading from the composite. If past doesn't predict future, no clever rating math can fix that, and we'd need to revisit the eight axes themselves.
3. **Synthetic-winner proxy** — declare "the team with higher mean P_i won," validate against the small reliable winner subset. If 85%+ agreement, we use the proxy on the full corpus and sidestep the small-sample winner problem entirely.
4. **Axis correlation matrix** — test whether the 8 axes double-count signal (mobility correlates with kill rate, efficiency overlaps with damage share, etc.).
5. **Random-weight perturbation** — Dirichlet sampling around the current axis weights, see how stable the ranking is. Detects whether we're tuning on a knife edge.
6. **Single-axis ablation** — drop each axis one at a time, see which removal barely changes the ranking. Those are dead weight.
7. **Log-loss / calibration** — distinct from top-1 accuracy. The Cambridge paper itself admits they punted on this; it's one extra column in the validator output.

---

## 9. Combined "what we can do today" list, ranked

Source codes: **C** = Cambridge / v1, **A** = §1b production-systems reading, **B** = both critiques.

| # | What to do | Source | Hard? | Worth it? | Needs winner data? |
|---|---|---|---|---|---|
| 1 | **Build the validator** (rank correlation, calibration, bootstrap stability, axis ablation, log-loss, clean-win anchor, synthetic-winner proxy). One JSON report. Gates everything else. | B | Medium (1 week) | The most worth-it thing on the list | No |
| 2 | **One-line locked-priors ablation** — set `COMMANDER_BASELINE_LOCKED_AXES = set()`, re-rate, compare leaderboards via #1. Decide. | A | Trivial | Medium-High | No |
| 3 | **Parallel MAX-weighted expected-performance** — ship alongside the median version, run validator with both, decide. | A | Low (1 day) | High if MAX wins | No |
| 4 | **Stability suite** — random-weight perturbation + jackknife match-dropout + axis correlation matrix + axis ablation. Bundles into validator output. | C | Medium | Medium-High (de-risks every other change) | No |
| 5 | **Inactivity-driven K-boost** — small additive bump for returning players. | B | Easy | Medium-High | No |
| 6 | **Validate the "fake winner from average performance" proxy** against the reliable winner subset. If ≥85% agreement, unlocks #8. | C | Trivial after #1 | High | Partial |
| 7 | **Parallel Hidden MMR (`vtsr_t_pure`)** — second rating pass with no soft floor, no loss aversion. Compare predictive accuracy via #1. Foundation for full dual-track. | A | Medium (2-3 days) | Medium-High | No |
| 8 | **Blend in win/loss signal (`α > 0`)** — sweep a few values, pick whichever lifts predictive accuracy. | B | Easy | Big (when unblocked) | **Yes — needs reliable winner data or the proxy from #6** |
| 9 | **Promote Hidden MMR to full dual-track** — Lobby Tools reads from Hidden MMR for matchmaking, dashboard shows Display Rating. Mirrors CS2. | A | Medium (1-2 weeks) | High (matchmaking integrity) | No |
| 10 | **Optional: full Glicko-2 RD migration** — only if #5 proves insufficient. | A | Hard | Probably small per Cambridge's own findings | No |

**Sequencing notes:**
- Items #1–#5 ship in any order, none gated on winner data. Do #1 first; everything else gets easier and more justified after.
- #6 unlocks #8.
- #7 is the prerequisite for #9. Ship #7 as a parallel JSON file first (low risk, easy revert), promote to full dual-track once #1 confirms it predicts at least as well as Display Rating.
- #10 is optional — Cambridge's Figure 2 showed defaults are usually near-optimal, and chasing 1-2% predictive lift we can't yet measure is bad ROI until #5 proves insufficient.

The whole list **was** gated on **#1**. **#1 has shipped.** The gate is open.

> **Phase 1 + 2A status overlay** (added post-empirical-findings — see §0 above for context):
> - Item #1 (validator): ✅ **shipped** as `scripts/validate_elo.py` v1.1
> - Item #4 (stability suite): ✅ **shipped** (Dirichlet wobble + axis ablation built into the validator)
> - Item #6 (fake-winner proxy): ✅ **passed at 93%** — unblocks #8 against the full corpus
> - Items #2 + #5: 🔵 **active in Phase 2B** (locked-priors ablation as alt mode + inactivity K-boost)
> - Item #3: 🔵 **active in Phase 2C, the magnum opus** — Phase 2A confirmed the direction
> - Item #8: ⏸ Phase 3 (data-unblocked, but waiting on Phase 2C to land first so we have the right team math to blend against)
> - Items #7, #9 (Hidden MMR + dual-track): ⏸ Phase 3+ (no urgency from Phase 2A)
> - Item #10 (full Glicko-2): ⚪ probably never

---

## 10. The bottom line

Two critiques, one synthesis.

The Cambridge paper said: per-player rating beats per-team rating, defaults are usually near-optimal, and prediction accuracy is the gold standard. We already had per-player. We never had prediction accuracy.

The §1b production-systems reading said: VTSR-T sacrifices zero-sum integrity for engagement-optimized matchmaking, the locked priors corrupt empirical integrity, and the median baseline misunderstands tactical shooter dynamics. Two of those are real critiques with real fixes (the dual-track, the median-vs-MAX split). The third is a values question rather than a math question, and the empirical ablation is the right way to settle it.

What both critiques are missing is the *measurement framework itself*: the validator design, bootstrap stability, synthetic-winner proxy, axis correlation audit. Those are the tools that turn every disagreement above into an empirical question instead of a debate.

**The combined v2 path forward:**

1. Build the validator (#1).
2. Use it to settle every disagreement empirically (#2 locked priors, #3 MAX vs median, #7 dual-track).
3. Layer in the time-decay fixes (#5).
4. Once we have winner data or a validated proxy (#6), blend in win/loss (#8).
5. Promote the Hidden MMR to full dual-track (#9).
6. Reserve full Glicko-2 (#10) for if and only if the additive K-boost proves insufficient.

The single most important thing both critiques agree on: **build the validator.** Everything else flows from there. We've been arguing about the rating system for two years; we can settle most of those arguments in two weeks with a single validation script.

