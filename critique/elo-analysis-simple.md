# VTSR-T vs. The Cambridge CS:GO Paper — Plain Edition

> The same comparison as `elo-analysis.md`, written for someone who doesn't want to wade through equations. Same conclusions, fewer Greek letters.

## TL;DR

- **What we got right:** rating each *player* (not each team), giving new players bigger rating swings, using a soft floor so players don't get permanently stuck, and adjusting commanders so they aren't unfairly punished for not racking up kills.
- **Our biggest blind spot:** we never check whether our rating actually predicts anything. The paper makes prediction accuracy the entire point of a rating system; we don't even measure ours.
- **Important caveat:** we don't have reliable "who won the match" data yet. The paper had it for every match (10,000 of them); we only have it definitively for a small subset of matches where one team got fully wiped without rebuilding. **But that's not an excuse to skip validation** — we have something the paper didn't have: a per-player performance score for every player in every match, and we can validate against *that* today, no winner data required.
- **The paper's biggest message:** rating algorithms differ less than people think. The fanciest one beats the simplest one by only 3-4 percentage points. So we shouldn't burn months copying Glicko or TrueSkill if we can't measure what we already have.

---

## 1. What's the paper, in one paragraph?

Three Cambridge researchers grabbed about 10,000 professional CS:GO matches and tested five popular rating systems against each other: a naïve "just track win rates" baseline, classic Elo (the chess one), Glicko2, TrueSkill, and a per-player version of TrueSkill. They asked one question: given two teams' ratings before a match, can the system pick the winner? Random gets 50%. Win-rate alone gets ~60%. The best system they tested gets ~64%. They also tested how the rating system interacts with matchmaking — i.e. picking which match to learn from next.

That's it. Five systems, one question, one dataset.

## 2. What's their #1 finding?

**Per-player ratings beat per-team ratings.** Tracking each individual's skill — and updating all 10 players at once when a match ends — works better than rating teams as units. The reason is intuitive: in real life, players move between teams. If you rate teams, a star player switching squads makes both team ratings wrong. If you rate individuals, the rating moves with the player.

This is huge for us. We don't have stable teams at all — we have pickups where every Friday night is a fresh split. So per-player was always the right answer, and we already do it.

## 3. What's our system, in plain English?

Every player has a single number called VTSR-T, starting at 1500. After each match, the number goes up or down based on how the player did **relative to everyone else in that lobby**, on eight different measurements:

1. How much damage they dealt minus how much they took
2. How many kills per minute they got
3. How accurate they were (compared to what other people achieved with the same weapons)
4. How efficiently their damage translated to kills
5. How much they hit enemy buildings/AI
6. How much of the map they covered (movement)
7. How many sniper shots they landed
8. How much they used the T-key target lock

We weight these eight scores, sum them, and that becomes the player's "performance" for the match. Then we compare that performance to what we'd expect from a player at their current rating, and the rating moves toward whichever direction the difference points.

Two extra rules:
- New players get bigger rating swings (high "K-factor"); experienced players get smaller ones.
- Losses near the rating floor of 1000 hurt less and less — eventually approaching zero — so nobody gets locked at the bottom.

We also exclude two kinds of rows entirely: people who spent most of the match in a camera pod (spectating), and people who clearly came in late or left early. Their rating just doesn't change for that match.

There's also a special adjustment for commanders, because the data showed they naturally have lower kills, less movement, etc. — so we built a system that gives them a fair handicap on those specific axes.

## 4. Where we did the right thing

**We picked per-player rating.** This is the paper's loudest finding. Done.

**We use the median opponent rating, not the average.** Tiny detail, big effect: if one ringer with rating 2200 shows up in a 1500-rated lobby, the *average* opponent rating jumps a lot, which would make everyone else look like they're underperforming. The *median* doesn't get pulled around by one outlier. We chose right.

**We have a soft floor.** The paper's introduction calls out "elo hell" — players feeling permanently stuck at low ratings — as a major community gripe in CS:GO. None of the systems they evaluated do anything about it. We do: as you approach 1000, losses shrink toward zero. You can't be locked at the bottom by bad luck.

**We use game-specific signal.** Microsoft's TrueSkill 2 (mentioned but not evaluated by the paper) made a big leap in Halo 5 prediction accuracy — from 52% to 68% — by including game-specific stats like individual performance and quit tendency. Our 8-axis composite is exactly that idea, scaled to BZCC's measurement set.

**We have a Bayesian-flavored commander adjustment.** The way commanders are "given a handicap" mixes a hand-tuned starting value with what we actually observe over time. Early on the hand-tune dominates; as we collect more commander data, the live data takes over. This is the right shape.

**We exclude bad rows cleanly.** Spectators and ghost-players don't get rated. Other rating systems either count them at full weight or apply some half-fix. Ours just says "the match didn't happen for this player," counts how often each gate fired, and moves on. Clean and auditable.

**Our K-factor decay is the right idea.** New players have high uncertainty, so their ratings swing harder; veterans have lower uncertainty, so their ratings move less. This is roughly what Glicko2 does with its "rating deviation" parameter, but achieved with simpler math.

## 5. Where the paper exposes problems we should actually fix

Listed in order of how much they matter.

### 5.1. We never check whether our rating actually predicts anything

The Cambridge paper exists to answer one question: does the rating predict the winner? We never ask the equivalent. We don't know if a player rated 1700 actually outperforms a player rated 1500 in their next match.

This is the **single biggest gap.** Everything else in this list is either a guess about what would help, or impossible to evaluate without this measurement.

#### Important caveat: we don't have reliable winner data — and it doesn't matter

The natural reaction is "but we can't run the paper's test because we don't know who won most matches yet." That's true: our `match.winner` field is inferred from the kill feed, and only the small subset of matches where one team got fully wiped without rebuilding (the `clean_win` rows) is reliable enough to use as ground truth.

**But the paper used winner data because it was all they had.** We have something better: a per-player performance score (we call it `P_i`) for every player in every rated match. The reframed question becomes:

> Given a player's rating before a match, does it predict where they'll land in the lobby's performance ranking after the match?

That's actually a *stronger* test than "did the team with higher average rating win," because each match gives us 10 ranks worth of data instead of one team-level outcome.

#### Five things we can validate today, no winner data required

These all run on data we already have:

1. **"Does pre-match rating predict in-game performance rank?"** For each match, see if the players with higher pre-match ratings actually scored higher on the composite. Average the rank correlation across all matches. If it's near zero, our rating is uncorrelated with how players actually do — that would be a five-alarm fire. This is the single most important measurement.
2. **"Are our predictions calibrated?"** When the system says "this player is rated 200 points above lobby median, expect them to outperform by X amount," does that prediction match what actually happens on average? Group player-matches by their pre-match rating gap and plot the average actual performance for each group. Compare against what the rating predicts. If the curves don't line up, we know exactly which range is over- or under-confident.
3. **"Does past performance predict future performance?"** Take each player's first half of matches, compute their average performance score. Does that predict their second-half average? This sets a *ceiling* for any rating system: if past performance doesn't predict future performance, no rating built on top can predict either, and we'd need to fix the eight axes themselves before chasing better rating math.
4. **"How stable is the leaderboard?"** Re-run the rating computation on random 80% subsets of matches, do this 100 times, and see how much the leaderboard order shuffles. If the top 10 is rock solid every time, ratings are meaningful. If it shuffles wildly, we're overfitting to specific matches. As a bonus, the spread we see across 100 runs *is* a real confidence band — we could finally show "1742 ± 23" next to each player's rating.
5. **"On the matches where we DO know the winner, does our rating predict it?"** Even with only ~50–100 reliable `clean_win` matches, we can ask whether the team with higher average pre-match rating actually won. The confidence interval will be wide, but it'll tell us if we're at random (50%), at the paper's WinRate baseline (~60%), or doing genuinely well (70%+). And here's the clever part: we can also create a "fake winner" by saying "the team with higher average performance won." If that fake winner agrees with the real winner on the reliable subset 85%+ of the time, we can use the fake winner as a proxy on the *full* corpus, sidestepping the small-sample problem entirely.

#### Stability checks that don't need any prediction at all

Even before checking predictions, we can ask whether the system is robust:

- **Drop one match at a time, re-run, see if the leaderboard barely budges** (it should). If a single match swings rankings, we're undertrained.
- **Wobble the eight axis weights by 10-20% randomly, re-run, see if rankings stay stable.** Tells us whether we're tuning on a knife edge.
- **Drop one axis at a time, see if rankings change.** An axis whose removal barely matters is probably dead weight.
- **Compute how correlated the eight axes are with each other.** If two are 0.8+ correlated, we're double-counting the underlying signal.

#### What this could look like as a deliverable

A single new script that walks the matches in order and outputs a JSON report covering: rank-correlation accuracy, calibration, self-consistency, bootstrap stability, axis ablation, and the `clean_win`-subset winner accuracy. One file, one run, complete picture.

### 5.2. We throw away win/loss data entirely (which we'll fix later)

We have a `match.winner` field. We don't use it for ratings at all. The paper's dumbest possible system (just count wins and losses) gets ~60% prediction accuracy. It would be reasonable to blend a small amount of win/loss signal into our rating — the system was actually designed to do this; there's a parameter called `α` set to zero.

**But we can't tune it yet.** To know how much win/loss signal to mix in, we need reliable winner data to validate against, and that's exactly what we don't have. If we tuned `α` against unreliable inferred winners, we'd be optimizing against noise — actively making things worse.

The right sequence is:

1. Build the validator from §5.1.
2. As the corpus grows and we accumulate more `clean_win` matches, we'll eventually have enough to tune `α` reliably (probably around the 200-clean-win mark).
3. If the "fake winner from average performance" proxy from §5.1 validates well against the reliable subset, we can use it to tune `α` on the full corpus instead of waiting.

The intent doesn't change. The prerequisite is the validation framework, not different schema.

### 5.3. Returning players are mishandled

If a player goes inactive for 8 months and comes back, our system treats them exactly like a player who played yesterday. Glicko2's whole reason for existing is that this is wrong: a long-inactive player is *uncertain*, and rating updates should be larger to re-locate them in the league.

Our K-factor only knows about *career* matches played, not *recency*. The fix is to bump K up when a player has been gone for a while.

### 5.4. We have no idea how stable our rating is to small parameter changes

We've got a *lot* of dials: 8 axis weights that sum to 1, 6 commander adjustment values, learning-rate constants, the floor taper width, the loss-aversion factor, etc. None of these have been rigorously tested. If we nudged the axis weights by 10-20%, would the leaderboard order shift dramatically? We don't know.

The paper does this exact analysis on TrueSkill (their Figure 2) and finds the defaults are nearly optimal — but they had to test it to know. We haven't tested ours. The fix is a Monte Carlo perturbation: randomly wobble the weights a hundred times, see how much the leaderboard shuffles, report the result.

### 5.5. We don't measure how *confident* our predictions are

This is a more advanced point. Saying "Player A is 51% likely to outperform Player B" and "Player A is 95% likely to outperform Player B" are very different statements, but a simple right/wrong accuracy can't tell them apart. A proper validation would also report calibration — when the system says 70%, does the right outcome actually happen 70% of the time?

This becomes especially important if we ever surface predicted win probability anywhere (the Tools page's Team Balonce hints at it).

### 5.6. Our 8 axes aren't really independent

Movement and kill rate correlate. Damage share and efficiency overlap. Kills and net damage share both reflect "how aggressive you are." Treating them as eight independent measurements probably double-counts the underlying signal in some directions.

The fix is to compute the correlation matrix between the axes and either trim redundant ones or reweight. Not urgent — but worth a one-evening exercise after we have #5.1 measuring outcomes.

### 5.7. Our axis weights were chosen by judgment, not data

We picked the weights by feel. Once #5.1 gives us a way to score one set of weights against another, those weights become an optimization problem instead of a design choice. We can ask the data what weights produce the best predictions and use those.

But — see the next section — the paper shows defaults usually aren't far from optimal, so don't expect huge gains from this.

## 6. Where the paper doesn't apply to us as cleanly as it sounds

Three honest things in our favor.

**Their dataset is professional CS:GO with stable rosters.** Their teams train together for months and have identities that survive across matches. None of their findings about per-team systems are relevant to us — we have no teams that persist across matches. So when they compare Elo vs Glicko2 vs TrueSkill (all team-rating systems by default), most of those comparisons don't apply.

**Their data is win/loss only.** They literally don't have per-player kill counts, accuracy, or anything else. The richer data we have is something they couldn't even use if they wanted to. The "best" system in their paper is operating on much less information than we feed our system. So their headline accuracy numbers are an upper bound for *what's possible with win/loss alone*, not a ceiling for what's possible with our richer data.

**Their effect sizes are small.** The gap between their best and worst rating systems (after thousands of matches) is only about 3-4 percentage points of accuracy. They literally write that with limited data, two systems can swap ranks by chance on any single run. So we shouldn't burn months porting their approaches chasing tiny gains.

## 7. Recommended action list

| # | What to do | Hard? | Worth it? | Needs winner data? |
|---|---|---|---|---|
| 1 | Build a validator using the per-player performance scores we already have. Outputs rank correlation, calibration, stability, axis ablation, and the small reliable-winner-subset check. | Medium | The most worth-it thing on the list | No |
| 2 | Stress-test the system by randomly wobbling the axis weights and dropping random matches. See if the leaderboard order stays stable. | Medium | Decent | No |
| 3 | Look at how correlated our 8 axes really are; trim or rebalance if any pair is too redundant. Also drop axes one at a time to see if any is dead weight. | Easy | Small to decent | No |
| 4 | Bump up the rating volatility for returning players who've been inactive. | Easy | Decent | No |
| 5 | Show a `±X` confidence band next to each player's rating in the UI (computable as a side effect of #1's bootstrap step). | Medium | Mostly UX clarity | No |
| 6 | Validate the "fake winner from average performance" proxy against the reliable winner subset. If it agrees ~85%+, we can use it as a proxy everywhere. | Tiny once #1 exists | High — unlocks #7 | Partially |
| 7 | Once #1 + #6 are in place, blend in some win/loss signal (`α > 0`). Try a few values, pick whichever lifts predictive accuracy. | Easy | Big (when unblocked) | **Yes — needs reliable winner data or the validated proxy from #6** |
| 8 | Auto-tune the axis weights to maximize the predictive metric from #1. | Hard | Probably small | No |

**Sequencing notes:** items #1–#5 don't need winner data and can ship immediately. Item #6 unlocks #7 by giving us a validated stand-in for winner data. Item #7 is the only one explicitly waiting on either reliable winner data or successful proxy validation. Item #8 is downstream polish.

Everything depends on #1. Do #1 first; everything else gets a lot easier (and a lot more justified) once it exists.

## 8. The bottom line

The Cambridge paper studies rating systems for one specific game with one specific kind of data — pro CS:GO, win/loss only — and finds that algorithm choice matters less than most people think, that per-player ratings beat per-team ratings, and that game-specific signals (which they didn't have access to but Microsoft did with TrueSkill 2) are the real frontier.

VTSR-T was built for a different setup: 25 rotating players in pickup matches with much richer signal. Most of what we built — the 8 axes, the commander adjustment, the soft floor — is exactly the kind of game-specific tuning the paper says is the next frontier.

What we're missing is the *measurement discipline* the paper exemplifies. They proved their system worked. We never proved ours does. That's the one thing we should fix.
