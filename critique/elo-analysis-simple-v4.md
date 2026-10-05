# VTSR Analysis v4 — Plain Edition

> The plain-language version of `elo-analysis-v4.md`. Same parts, same numbers, same source list, fewer equations. Where the in-depth edition cites validator sections and code, this one explains what the numbers mean in ordinary words. Citation keys like `[9]` point to the Sources list at the end, which is identical to the in-depth edition's Part IX so you can cross-reference the two.
>
> **How this was made.** Drafted with an AI assistant, like the three before it. Every number here comes from one command, `python scripts/validate_elo.py`, run against the committed data on 2026-10-04, and anyone with the repository can regenerate all of them. Every change to how ratings are computed is governed by a rule written down before the data that judges it existed. Several ideas the tooling itself proposed have been tested under those rules and lost; Part 2 lists them.

## TL;DR

- **Twice the data since v3.** 228 recorded matches (193 rated), 45 rated players, plus F9bomber's 505 community games on the commander ladder — 675 commander duels in total.
- **The system got more accurate as the data grew.** Pre-match rating predicts in-match performance a bit better (0.46 → 0.50 correlation), a player's composite is very stable across their career (0.89 split-half), predictions are calibrated to within one percentage point, and the ladder now calls the winner of a match from team mean rating 58.6% of the time (it was 43% on a tiny sample in v3). The commander ladder calls its duels 65.4% of the time over 675 games.
- **The "brutal raw performance meter" complaint is real and now has numbers.** The performance rating and the win/loss ladder only weakly agree (0.38 correlation). Your team's result explains about a fifth of your per-match score. A strong thug on a losing team drops rating three times out of four — even though they usually still out-performed the lobby. Time spent on foot at base waiting for a ship tracks rating loss step for step. And two of the eight axes, worth 31% of the rating, actually point *against* winning.
- **Hadean is winning more than its players' ratings explain.** After accounting for both commanders and both squads, a Hadean side plays as if its commander were about 62 points stronger. Scion and ISDF are even. This is the one place v4 proposes a change — a faction term in the commander ladder's expected score — and it is only allowed to go live if games played *after* this document confirm it.
- **Splitting ratings by faction, by role, or by ship is not the fix.** Each is argued both ways below, with what the big studios actually did: Blizzard added per-race MMR to a 1v1 ladder with millions of players; Valve split Dota 2 ratings by role and merged them back seven months later; Riot tried positional ranks and cancelled them; Overwatch kept per-role ratings because you pick your role before the match. For 45 players, where the commander picks the faction and the ship picks your job, the things that survive are a faction term for the commander ladder, a better-calibrated commander adjustment, and faction and ship profiles for display.
- **Matchmaking matters more than rating math.** Commanders sit in the middle of their lobby by rating; four people do 37% of the commanding; the two most frequent commanders have the two lowest commander ratings. No formula fixes a volunteer shortage.
- **"Count all games regardless of size" is half right.** The 23 excluded 1v1/2v2 games are real games that play differently (a third more fighting per player, longer, more structure damage), and the better-rated side still wins 10 of the 15 with known results. But the thug rating literally cannot score a two- or four-player room, and every big game that faced this put the small format on a separate ladder. Don't discard them; don't mix them; record them separately first.
- **One change proposed, none shipped.**

## Reading guide

Part 1 is where things stand (including a map of where every piece of the system comes from). Part 2 is the validation record and how a change gets made here. Part 3 is the complaint with numbers. Part 4 is the case for the current design. Part 5 is the proposals, both sides. Part 6 is matchmaking. Part 7 is what makes this genre different. Part 8 is the roadmap. Part 9 is a FAQ in the community's own questions. Part 10 is the sources. Part 11 is the author's view.

---

## Part 1 — Where things stand

### 1.1 The two ratings, in one paragraph each

**VTSR-T (thug rating).** Every player has a number starting at 1500. After each rated match it moves based on how they did *relative to everyone in that lobby* on eight measurements — net damage share, kills per minute, kill efficiency, accuracy, share of damage done to enemy structures and AI, mobility, snipes, and T-key target-lock use (the last two at a token 0.5% each). Those are weighted into one performance score, compared against what a player of that rating was expected to do against that lobby, and the difference moves the rating. New players move fast (K ≈ 52), veterans slowly (K = 12), returning players a little faster again. Losses are softened by 15% and taper to zero near a 1000 floor. Commanders get a per-axis adjustment so they are measured against a commander baseline rather than a thug one. Camera-pod spectators, people who were only present for part of the match, and people who did no damage are left out of the rating entirely rather than penalized. A second, win/loss-only ladder (R^W) runs alongside on the 170 matches with a known winner, but it is blended into the published number at weight zero.

**VTSR-C (commander rating).** A classic chess-style Elo between the two commanders of every rated match with a known winner: win and you take points from the other commander, lose and you give them. Before the match it predicts the result from the commander gap *plus* a handicap for how strong each side's thugs are (mean thug VTSR-T), so a commander handed a weaker squad is expected to lose and is not punished much for it. F9bomber's hand-kept ledger of 505 community games is rated on the same ladder with full weight. Economy telemetry (how fast you get to three pools, how much of your opening income goes into combat ships, how much time you spend in the fast-regen band) is recorded on every duel that has it but currently scored at weight zero until it earns its way in.

### 1.2 What changed since v3

Shipped, all through the gate described in Part 2: the win/loss ladder machinery (inert); the F9bomber import and the 50 match outcomes that were settled mechanically from it; the commander economy composite (inert); the ranked-ladder display rules (25 matches to hold a numbered rank; 90 days idle drops you to Unranked; 3 games to come back); the Balonce Meter, which shows the commander ladder's own win-probability formula on the Tools page and the per-match Outcome card; four small input corrections (none moved a rating more than about one point); and validator sections §10–§19.

Tested and **not** shipped since v3: blending the win/loss ladder into the published rating (held — twice); rank-based instead of z-score lobby scoring (held — three times); converged whole-history re-rating (stopped); scoring the commander economy composite (held); putting the commander's own thug rating into the handicap, or using softmax / max instead of mean for the thug handicap (held / discarded — softmax got worse the more max-like it got).

### 1.3 Where every piece comes from

None of the machinery in VTSR is new. The only things invented here are the eight axis definitions and their weights — and those are exactly what Parts 2 and 3 test.

| What VTSR does | Who else does it |
|---|---|
| Rating around 1500, difference = win odds | Chess Elo [1]; the Bradley–Terry model underneath it [2] |
| K that falls with games and rises with inactivity | Glicko / Glicko-2's rating deviation, used by Lichess and US Chess [4][5][7] |
| Rate from in-match stats, not just the W/L | TrueSkill 2 at Microsoft (Halo 5 prediction 52% → 68% by adding kills, deaths, quits, squads) [9]; HLTV Rating 2.0, the Counter-Strike standard [23]; PandaSkill for pro League [27] |
| Measure everyone against the room they played in | Elo-MMR for massive multiplayer contests [13]; PandaSkill's free-for-all update [27] |
| Separate commander and thug ratings | AllegSkill on Microsoft Research's Allegiance ("separate skill ratings for commanders and pilots") [50]; Natural Selection 2's Hive Skill 3.0 [58] |
| Adjust the commander's axes to a commander baseline | Baseball WAR's positional adjustment (a catcher and a first baseman on one scale) [19][20] |
| A team-strength handicap in the expected score | The Bradley–Terry "order effect" — home advantage, white's first move [3]; Aligulac's matchup ratings for StarCraft II [48] |
| Leave spectators, quitters and idlers out of the math | TrueSkill 2's quit modelling [9]; Hive 2.0's team-switch handling [60] |
| Check the rating by predicting matches it hasn't seen | The Cambridge CS:GO benchmark [31]; TrueSkill 2's own test [9]; WHR's evaluation [12] |
| Write the pass/fail rule before looking at the data | Registered Reports in science [74][75] |
| Never reward a player for underperforming | Elo-MMR's monotonicity guarantee [13] |

---

## Part 2 — Validation

### 2.1 The numbers, v3 → v4

| What it checks | v3 (100 matches) | v4 (193 matches) |
|---|---|---|
| Does pre-match rating predict in-match performance? (Spearman) | 0.462 | **0.495** |
| Is a player's composite stable across their career? (split-half) | 0.804 | **0.888** |
| Are predictions calibrated? (mean error) | 0.018 | **0.009** |
| Is the leaderboard stable under resampling? (top-20 overlap / ± per rating) | 0.83 / ±27 | 0.83 / ±33 |
| Does "higher team performance" match the actual winner? | 93.3% (n=30) | **94.1%** (n=169) |
| Does team mean rating predict the winner? | 43.3% (n=30) | **58.6%** (n=169) |
| Does team *max* rating predict better? | 53.3% | 55.0% — no longer |
| Commander ladder duel prediction | ~56% (n≈70) | **65.4%** (n=675) |

In plain terms: everything that should have improved with more data did. The commander ladder's handicap weight (λ = 1.0) was tested against 0, 0.5 and 1.5 and is the most accurate. The industry benchmark for win/loss-only systems on professional CS:GO is 60–64% [31]; this system sits in that range with a fraction of the data, and above it on the commander ladder.

### 2.2 What still can't be checked

Only four rated matches had a big (>100 point) rating gap between the teams — all four were called correctly, which is encouraging and statistically meaningless. The win/loss ladder is still blended at zero, so the published number can't be scored as a win predictor except through the forensic test files. Economy telemetry exists for 100 of 228 matches.

### 2.3 How a number becomes a rule here

Hypothesis → a rule written in a memo before any number exists → a forensic "what-if" rating file produced alongside the real one → the validator scores both → the memo gets a PROMOTE / HOLD / DISCARD → only PROMOTE changes a published rating.

Scoreboard since v2: **shipped** — inactivity K-boost, the exclusion gates, the win/loss ladder machinery, the F9 import, the commander economy machinery, the display gates, the Balonce formula. **Held** — win/loss blend (twice), rank scoring (three times), commander economy scoring, commander-rating-in-the-handicap, and this document's faction term (not yet testable). **Refuted** — max-rating as the opponent reference (it inflated everyone by 500 points and halved predictive power), softmax reference, unlocking the commander priors (effect below noise), converged re-rating, softmax/max thug handicap (got worse the more max-like it got).

Several of the held and refuted ideas were drafted by automated reviewers — the v2 critique's max-reference and unlock-the-priors ideas, the June review's rank scoring, and this document's own faction fit. They went through the same gate as anything from the developer. The data has overruled the tooling more often than it has agreed with it.

### 2.4 The professionals haven't settled this either

Valve split Dota 2 into Core and Support MMR in August 2019 [38] and replaced it with one rating plus per-role handicaps in March 2020 [40]. Riot built positional ranks, previewed them in two regions, and ended the preview when satisfaction fell 20–30 points [42]. Blizzard kept per-role ratings in Overwatch because you lock your role before the match [44], and added per-race MMR to StarCraft II six years after launch for a 1v1 ladder [36]. Natural Selection 2's community developers said in 2016 that separate team and commander skills were "scrapped because there is no good way to implement any of it" [61] — and shipped exactly that in 2020 [58]. People who do this for a living change their minds on evidence. So does this document.

---

## Part 3 — The complaint, with numbers

### 3.1 Performance and winning disagree

Across the 24 players with 20+ matches, the performance rating and the win/loss ladder correlate at only 0.38. The biggest gaps: Domakus is rated 258 points higher by performance than by wins (he is 37–37), VTrider +242, Cloaket +237 (16–34), Snake +181, Muffin +178. At the other end, judgeguns (40–38), Totokomo and dd are 60–70 points *lower* by performance than by wins.

Both readings are partly true: a strong player on balanced teams *should* go 37–37 — that is the balancer working — and the composite *does* under-credit something the winners-who-don't-"perform" are doing. Part 3.4 shows what. Commanding is not the cause: a player's commander share barely correlates with their gap (0.16).

This is basketball's PER-versus-plus-minus argument [18][16]: box-score composites credit what you did, impact measures credit the result and can't separate you from your teammates [17]. The field uses both; so do we.

### 3.2 Your team's result moves your rating

Across 1,084 thug-matches with a known winner: thugs on the winning side average +7.6, thugs on the losing side −5.6. Only 27% of winning thugs lose rating; only 24% of losing thugs gain it. Win/loss alone explains 21% of the variance in a thug's per-match score.

The sharp part: thugs rated 1650+ on a *losing* team still out-perform their lobby on average (score +0.10) and still lose rating 76% of the time (−6.5 on average), because a 1650 player is expected to out-perform by more than that. That is the "brutal" feeling, precisely: you are not fined for losing, you are fined for not beating the room by as much as your rating said you would — and a lost game makes that bar hard to clear.

### 3.3 Time on foot at base costs rating

Positioning data gives each thug's share of the match spent on foot inside their own base — in practice, waiting for a ship.

| Share of match on foot at base | thug-matches | average rating change | team win share |
|---|---|---|---|
| under 5% | 248 | **+9.0** | 79% |
| 5–15% | 459 | +2.5 | 55% |
| 15–30% | 298 | −4.5 | 29% |
| 30% or more | 79 | **−11.4** | 13% |

The gradient holds even among losers (−2.0 at under 5% vs −12.7 at 30%+). The confound is obvious and stated: you are on foot at base because your ship died and wasn't replaced, which happens more when your team is losing. But the complaint — that ship denial costs rating — is simply true, and the existing low-tier lift only applies below 1460, while the average rating in the worst band is 1499.

### 3.4 Two axes point the wrong way

For every match with a known winner, does the winning team have the higher team-average on each axis?

| Axis | weight | winner higher this often |
|---|---|---|
| net damage share | 20% | **88%** |
| mobility | 8% | **88%** |
| kills per minute | 20% | 86% |
| PvE share (structures / AI) | 12% | 79% |
| T-key lock | 0.5% | 42% |
| kill efficiency | 16% | **39%** |
| accuracy | 15% | **39%** |
| snipes | 0.5% | 22% |

Winning teams have *lower* lobby-relative efficiency and accuracy than losing teams, and those two axes carry 31% of the rating. Plausible reasons: winners shoot structures and AI (which dilutes accuracy), losers get more kills per damage because they are fighting through repairs. Whatever the cause, this is the honest version of the "utility vs hunter" debate: PvE work is already rewarded (79% agreement); the axes rewarding *clean* fighting over *effective* fighting are the ones that disagree with winning.

### 3.5 Who commands, and what it does to a rating

Commanders sit at the 48th percentile of their own lobby by rating (median 44th) — the middle, not the bottom — and are below their own team's thug average 52% of the time. The job is concentrated: 33 people have commanded, four of them (Sev 42, Lithium 36, F9bomber 34, Darkvale 32 rated matches) account for 37% of all commander-matches.

The commander adjustment over-corrects for strong fighters and under-corrects for weaker ones. Commander-matches gain +2.1 on average versus +0.9 for thug-matches. Muffin averages +14.5 a game as commander, blue +11.3, Snake +8.4, Domakus +7.1, Cloaket +6.8; Lithium −4.0 and DraconisMarch −5.6. The adjustment is set to the *average* commander's shortfall on each axis, so a strong fighter clears it easily and a weaker one still bleeds. Baseball's positional adjustment has exactly this known weakness [19][21]. Fixing it is a Part 8 item, and it should happen before anyone talks about a separate role ladder.

### 3.6 Hadean wins more than its players explain

Head to head, Hadean beats ISDF 65% of the time (79–43) and Scion 58% (62–45); Scion vs ISDF is a coin flip (87–90). After controlling for both commanders' ratings and both squads' mean thug rating, a Hadean side still wins more than expected — the equivalent of about **62 commander-rating points**; Scion vs ISDF is zero. The effect is statistically significant (z 2.3, p 0.02) and shows up in both the telemetry games and F9's ledger with the same sign.

Two warnings. Commanders who pick Hadean are slightly higher rated (1513 vs 1489 / 1487) — already accounted for, but it shows selection is real. And Hadean's share of team-sides has gone from about 10% in late 2025 to 37–38% in the last two months: the community has noticed, and a community that believes a faction is strong will produce a win rate for it that is partly belief. That is why the number above is treated as a *discovery* and the proposed +60 term is judged only on games played after 2026-10-04 (Part 8).

---

## Part 4 — Why the current design is defensible

- **It measures something real.** 0.89 split-half stability means your composite in one half of your career predicts the other half. Noise doesn't do that. Rating from match statistics rather than only win/loss is the exact move that took Halo 5 prediction from 52% to 68% [9].
- **It's calibrated.** When it says you should out-perform your lobby by X, you do, within one percentage point.
- **It predicts, and got better with data.** 58.6% on winner prediction from team mean rating on a corpus with almost no lopsided games; the professional CS:GO benchmark's best is 64.1% on ten thousand matches [31]. The commander ladder's 65.4% over 675 duels is above that.
- **Two ratings is the genre's own answer.** Allegiance's AllegSkill and Natural Selection 2's Hive both separate commander from field player [50][58]. Hive 3.0's FAQ says it directly: a high-ranked player in the command chair "will no longer be expected to carry to avoid losing skill."
- **The handicap is tested, not assumed.** λ = 1.0 is the best of four values tried.
- **The exclusion gates work.** Spectators, partial-presence rows and idlers are left out, not penalized — TrueSkill 2's instinct too [9].
- **The wrong-way axes are visible *because* the system measures them.** A win/loss-only ladder would never have shown that accuracy anti-correlates with winning.
- **The process says no to its authors.** The refuted list is longer than the shipped list.

---

## Part 5 — The proposals, both sides

### 5.1 Faction-based rating

**For:** faction imbalance is real here (3.6); skill is partly faction-specific; StarCraft II did it — Blizzard added per-race MMR in 2016 because "many people want to experience the ladder as other races without affecting the rank and MMR of their 'main' race," seeding each off-race from the main race with high uncertainty [36]; Aligulac rates pro SC2 per matchup [48]; NS2 did per-team skill for marines vs aliens [58].

**Against:** SC2 is 1v1, you pick your own race, and the population is millions. Here the commander picks the faction for the whole team and there are 45 rated players. Split three ways that is 111 player-faction cells with a *median of 8 matches*; only 26 cells reach the 25-match ranked bar and only 11 players have 10+ matches on all three factions. Three ladders would be provisional for most people most of the time. And the thug rating is lobby-relative — both teams' faction effects sit in the same lobby and cancel — so a faction axis in VTSR-T would measure nothing and would charge thugs for a commander's choice.

**What survives, ranked:** (1) three per-player ladders — no; (2) a per-player faction *offset* on one rating (the NS2 "average skill + team bias" trick [58][62]) — maybe later, display first; (3) **a single faction term in the commander ladder's expected score** — yes, pre-registered: the chess "white moves first" device [3], frozen at +60 Hadean / 0 Scion / 0 ISDF and judged only on 60+ future games; (4) a faction axis in VTSR-T — no. Both sides agree the faction matchup table and the Hadean pick-share trend belong on the Meta tab regardless.

### 5.2 Role-based rating

**For:** thugs do different jobs, and a kills-and-damage composite rates the hunter above the utility player even when the utility player wins more. Dota 2, League and Overwatch all built role-aware ratings [38][41][44]; PandaSkill models each League role separately [27]; our own commander adjustment is a role adjustment and 3.5 shows it is miscalibrated.

**Against:** every role rating that lasted had the role *declared and locked before the match*. Overwatch's survived because you queue as tank/damage/support and can't switch [44]. Dota 2's Core/Support split lasted seven months before Valve "replace[d] the Core/Support separation with a single rank" with handicaps [40]. Riot's positional ranks lasted one preview: players were "frustrated with the grindiness, low satisfaction of off-position games, and teammates not taking off-position games seriously enough," satisfaction fell 20–30%, and the feature was cancelled [42]. In BZCC your role is whatever ship and weapon the commander handed you, and it changes mid-match — a Xypos with a burst gun should be on pools, the same Xypos with a slicer should hunt [80]. A role the system has to *guess* from your stats is a role you can pick to flatter your rating, and a rating you can game stops measuring [70][71][73]. The data also says the premise is half right: PvE work is already rewarded (79%); what's over-rewarded is clean fighting (3.4), and that is a weights fix, not a ladder.

**What survives:** fix the commander adjustment to measure a commander against *their own* thug baseline rather than the average commander's; re-weight away from the two wrong-way axes; extend the ship-denied-time correction to all tiers; add a display-only playstyle label. All as forensic what-if modes with written rules first.

### 5.3 By-ship rating

**For:** ships are where skill shows; hero-specific skill mattered in League [28]. **Against:** it added little in Dota 2 [28]; here the commander builds your ship, it changes several times a match, and the per-player-ship data is far thinner than per-faction. Accuracy is already weapon-normalized. **Verdict:** display-only ship profile (it already exists on the Loadout tab); never a ladder.

### 5.4 Include all games regardless of size

Today a match only counts if it has at least six real players and lasts four minutes — in practice 3v3 and up. Someone asked why not count everything. The author's own view is that 1v1 and 2v2 are a different game. Both can be checked, and validator §20 checks them.

**What's being left out.** 23 small-format games (1v1 ×12, 2v2 ×7, four lopsided 2v1s), 15 of them with a known winner. Fourteen of the 23 were played in the three weeks before this was written — the format is growing, which is why the question came up.

**The games really are different.** Compared with the 193 rated matches, small-format games (four minutes or longer) run longer (median 1295 s vs 968 s), have a third more kills per player-minute (0.42 vs 0.31), a quarter more damage per player-minute (2754 vs 2206), and more of that damage goes into structures and AI (68% vs 60%). Deaths per minute and pool counts are the same. So the author's premise holds — and the things that change are exactly the things the rating weights most.

**But the ratings still carry over, partly.** Rebuilding everyone's rating as it stood before each small game: the side with the higher average thug rating won **10 of 15** — about the same hit rate the rating gets on big games (58.6%). The side with the higher-rated *commander* won only **8 of 15**. A 1v1 is a shooting duel much more than a commanding duel, which is the opposite of what you might guess.

**The thing that actually decides it is math, not taste.** The thug rating scores you against the room you played in. With two people in the room every axis comes out at exactly ±0.5 no matter what happened; with four, the spread it divides by is noise. That's why the gate counts real players — a 1v1 with a gallery of spectators used to slip through and produce nonsense. The thug composite simply cannot score a 1v1 or 2v2. The win/loss ladder and the commander ladder can; they don't care about team size.

**For including:** +12% more matches and 15 more known results in a corpus that needs them; real, long, combat-heavy games; the players in them (HappyOtter, DraconisMarch, Maverick, sponge appear in nine of the fifteen) are the same mid- and low-tier regulars who already have the fewest rated games, so excluding them widens the gap the 25-match ranked bar already makes; TrueSkill-style systems rate any team size without complaint [8][10].

**Against mixing:** the composite is undefined at that size; the game changes in the measured axes; the commander ladder's prediction assumes a squad behind each commander; and every big game that faced this question answered "separate ladder", not "mix": StarCraft II places you separately in 1v1, 2v2, 3v3 and 4v4 [83][84]; chess split rapid and blitz from classical in 2012 because "players have different levels of play depending on the speed of the game" [85]; TrueSkill 2 treats other game modes as related but distinct skills [9]; Overwatch 2 keeps Open Queue and Role Queue on separate ranks [47]; Counter-Strike 2 keeps 2v2 Wingman on its own rank [86]. F9bomber's ledger import dropped the 1v1/2v2 rows too [79].

**What survives, ranked:** (1) rate everything in the thug composite — no, math; (2) let small games move the win/loss ladder — mechanically fine, invisible while that ladder is blended at zero, cheap to try as a what-if; (3) count 1v1s as commander duels — hold, because 8/15 says the commander ladder would learn the wrong skill from them; (4) **a separate small-format record, then a small-format ladder** once there are 30+ known results — the StarCraft/chess/Wingman pattern and the right design if the format sticks; (5) the TrueSkill-2 version of (4): seed the small-format rating from the main one and let them update together.

**Where the author's argument lands:** "too different" is supported as *different enough to rate separately*, not as *too different to count*. The games carry real information about the same people. Don't throw them away; don't pour them into a rating built for six-to-ten-player rooms; record them on their own first.

---

## Part 6 — Matchmaking

Twenty to twenty-five active players, commanders volunteer, teams are split by hand [80]. Commanders are mid-lobby by rating, the job is concentrated, and the two most frequent commanders hold the two lowest commander ratings (Lithium 1289 over 135 duels; F9bomber's own ledger has him 26–77 as commander). Whether that is skill or the cost of commanding every time nobody else will, a win/loss ladder cannot tell — which is the argument for showing the burden (games commanded, share of the team's commander games) next to the rating.

The research says fairness is not even the only goal: equal-skill matching is a special case of engagement optimization that "rarely holds in reality" [65]; being matched against slightly *weaker* opponents reduces churn more than fair matches do [67]. And paying people to take the unpopular role fades fast: Overwatch's director wrote that the Priority Pass "had a positive effect for several weeks, but its influence quickly faded," and loot boxes for tanking couldn't "put a dent in the demand for playing DPS" [47]. The right tools here are the ones that already exist: the Balonce Meter for building teams, an honest handicap, the faction term once confirmed, and credit for the people who command.

---

## Part 7 — Why this genre is hard

Battlezone (1998) mixed a tank sim, a shooter and an RTS [56]; Battlezone II (1999, remastered 2018) kept it [57]. The line runs through Allegiance (Microsoft Research, 2000), Natural Selection (2002), Savage (2003), Nuclear Dawn (2011), NS2 (2012), Eximius and Silica [52]–[64]. Only two of them shipped a public skill rating — AllegSkill and Hive — and both separate commander from field player.

The hard part isn't two jobs, it's that the jobs are *coupled*: your measurable output depends on what your commander gives you, and their win depends on your fighting. Every thug is on a team whose coach controls their equipment mid-game. That is why the box-score-vs-plus-minus debate maps so cleanly onto VTSR-T vs the win ladder. Thug skill is shooter skill and is measurable per match — the same stats TrueSkill 2 and HLTV built on [9][23]. Commander skill is RTS skill and shows up in outcomes and economy telemetry — Thompson et al. showed RTS expertise is detectable from telemetry [32], and adding a macro-economy feature lifted StarCraft II league prediction from 47% to 62% [33]. That is the long-run case for the commander economy axes, which stay recorded-not-scored until future games confirm them.

---

## Part 8 — Roadmap

1. **Faction term in the commander ladder** (memo written, validator scoring it every run; needs 60+ non-mirror games after 2026-10-04).
2. **Re-run the win/loss blend sweep** — the memo asked for about double the 39 matches it had; there are 170 now.
3. **Commander adjustment relative to the player's own thug baseline** (what-if mode + rule).
4. **Re-weight away from the two wrong-way axes** (what-if mode + rule, judged on future matches).
5. **Ship-denied time correction for all tiers** (what-if mode + rule).
6. **Small formats:** a what-if mode that lets 1v1/2v2 results move the win/loss ladder only; a display-only small-format record on the player page; a separate small-format ladder (rule written first) once 30+ small games have known winners.
7. **Display:** faction matchup table and pick-share trend; faction and playstyle profiles; commander burden beside VTSR-C.

**Not doing:** mixing 1v1/2v2 games into the thug composite; three faction ladders; guessed-role ladders; ship ladders; a faction axis in VTSR-T; max/softmax anywhere it was refuted; refitting a frozen number on the games meant to judge it.

---

## Part 9 — Community FAQ

**Why did my rating drop when my commander fed?**
Because the rating compares you to the whole lobby, including the enemy team, and a stomped team scores below the room on almost every axis. Your team's result explains about a fifth of your per-match score (3.2). If you were on foot at base for a third of the match waiting for a ship, that alone averages −11 (3.3). The system is not fining you for the loss; it is fining you for not beating the room by as much as your rating said you would — and that is hard to do from the pad. v4 proposes extending the ship-denied-time correction to everyone (Part 8, item 5).

**Why not SC2-style faction MMR?**
SC2 is 1v1, you pick your own race, and there are millions of players. Here the commander picks the faction and there are 45 of us; three ladders would leave most people provisional forever (median 8 matches per player-faction). What *does* transfer is the idea that the matchup itself carries an edge — so v4 proposes one faction term in the commander ladder's prediction, the same device chess uses for white's first move, to be confirmed on future games (5.1).

**Why isn't there a support/utility rating?**
Because no system that guessed your role from your stats has survived — Riot's lasted one preview — and the ones that did survive lock the role before the match, which this game doesn't do (5.2). Also, PvE work *is* rewarded already (79% of the time the winning team has more of it); what's over-rewarded is clean fighting (accuracy, efficiency), and that's a weights fix on the roadmap.

**Does commanding punish my rating?**
On average, the opposite: commander-matches gain +2.1 versus +0.9 for thug-matches, because the commander adjustment lowers the bar. Strong fighters harvest that (Muffin +14.5 a game as commander); a few commanders still bleed (Lithium −4.0). The adjustment should be relative to *your own* thug numbers, not the average commander's — roadmap item 3 (3.5).

**Is Hadean OP?**
Hadean wins more than its commanders' and thugs' ratings explain — about 62 commander-rating points' worth — and Hadean picks have tripled in a year. That is strong enough to pre-register a correction and not strong enough to ship one: it is judged on games played after this document (3.6).

**Why don't 1v1s and 2v2s count?**
Because the thug rating scores you against the room, and a room of two or four is too small to score — two players come out at exactly ±0.5 on every axis no matter what happened (5.4). The games aren't worthless: the better-rated side wins them 10 times in 15, so they carry real information. They just can't go into a rating built for six-to-ten-player rooms, and every big game that hit this problem (StarCraft II, chess, Counter-Strike's Wingman) put the small format on its own ladder instead. That's the roadmap here too: a separate small-format record first, a small-format ladder once there are enough results.

**Why does VTSR-T disagree with who wins?**
Because it is a performance rating, not a win rating, and the two have always disagreed — box score vs plus-minus in basketball, HLTV rating vs trophies in Counter-Strike. The win/loss ladder exists (R^W) and has been tested as a blend twice; both times it was held because it did not improve prediction yet. It will be re-tested now that the determined-match count has quadrupled (3.1, Part 8).

**Is any of this based on real statistics, or on what an AI said?**
Every mechanism in the system is in use somewhere that pays people to get it right — the table in 1.3 names them: Elo, Glicko, TrueSkill 2, HLTV, PandaSkill, AllegSkill, Hive, baseball WAR, Bradley–Terry. The AI drafted documents and proposals; the proposals went through the same written-in-advance test as everyone else's, and the ones it drafted have mostly lost (2.3). Nothing changes a published rating without passing a rule written before the data existed.

**How can I verify any of this myself?**
Clone the repository and run `python scripts/validate_elo.py`. It writes `_validation/report.md`; sections §15–§19 are the numbers in Part 3, §20 is the small-format section (5.4), §1–§9 are Part 2, §10 is the commander ladder, §11 is the axis table. The decision memos are in `critique/decisions/`.

---

## Part 10 — Sources

The numbering is shared with `elo-analysis-v4.md` Part IX, which carries full citation fields and a "used for" note on each entry; this list is the short form.

**A. Rating-system foundations.** [1] Elo 1978, *The Rating of Chessplayers, Past and Present* (Arco). [2] Bradley & Terry 1952, *Biometrika* 39. [3] Davidson & Beaver 1977, *Biometrics* 33 (order effects). [4] Glickman 1999, *Applied Statistics* 48 (Glicko). [5] Glickman 2001, *J. Applied Statistics* 28 (Glicko-2). [6] Glickman & Jones 1999, *Chance* 12 (rating the rating system). [7] US Chess Ratings Committee report 2019 + Chess Life interview (glicko.net). [8] Herbrich, Minka & Graepel 2006, TrueSkill (NIPS 19). [9] Minka, Cleven & Zaykov 2018, TrueSkill 2 (MSR-TR-2018-8). [10] Weng & Lin 2011, *JMLR* 12. [11] Joshy 2024, OpenSkill (*JOSS*). [12] Coulom 2008, Whole-History Rating (CG 2008). [13] Ebtekar & Liu 2021, Elo-MMR (WWW '21). [14] Bodwin & Zhang 2023, Opponent indifference / Sonas (ITCS). [15] Rosenbaum 2004, adjusted plus-minus (82games). [16] Sill 2010, RAPM (Sloan). [17] Ghimire, Ehrlich & Sanders 2020, *PLOS ONE* 15(8). [18] Hollinger 2002, PER. [19] FanGraphs Library, Positional Adjustment / WAR. [20] Cameron, *Position Adjustments* (FanGraphs). [21] FanGraphs, *The Issue of Positional Inequality*. [22] Tango, Lichtman & Dolphin 2007, *The Book*.

**B. Rating from in-match performance.** [23] HLTV 2017, *Introducing Rating 2.0*. [24] HLTV 2024, *Introducing Rating 2.1*. [25] dave, reverse-engineering Rating 2.0. [26] Sardegna, problems with CS rating systems. [27] De Bois et al. 2025, PandaSkill (arXiv 2501.10049). [28] Chen, Sun, Seif El-Nasr & Nguyen 2016/2017, MOBA skill decomposition. [29] Dehpanah et al. 2021, team skill aggregation (CoG). [30] Dehpanah et al. 2021, rating-system evaluation in battle royale (arXiv 2105.14069). [31] Bober-Irizar, Dua & McGuinness 2024, *Skill Issues* (arXiv 2410.02831). [32] Thompson, Blair, Chen & Henrey 2013, *PLOS ONE* 8(9). [33] Chen, Aitchison & Sweetser 2020, SC2 league prediction (AI 2020). [34] Huang et al. 2013, Halo skill (CHI). [35] Lewis, Trinh & Kirsh 2011, Brood War corpus (CogSci).

**C. Role and faction ratings in shipped games.** [36] Blizzard 2016, *Patch 3.7: Separate MMR Per Race*. [37] Blizzard 2016, LotV 3.7.0 patch notes. [38] Valve 2019-08, Dota 2 *Matchmaking Update*. [39] Valve 2020-01-16, Dota 2 update. [40] Valve 2020-03-02, *Ranked Roles Update*. [41] Riot 2018-08, */dev: Position Ranks in 2019*. [42] Riot 2019-03, */dev: State of Ranked*. [43] Riot DevRel 2019-04, positional ranking deprecation. [44] Blizzard 2019, *Introducing Role Queue*. [45] Overwatch forums 2019, *Role Queue Update*. [46] Dexerto 2019, Kaplan on role SR. [47] Mercer & Kaplan 2020, Priority Pass; Keller 2024, Director's Take on 5v5/6v6. [48] Aligulac FAQ. [49] Aligulac database status.

**D. FPS+RTS hybrids.** [50] FreeAllegiance Wiki, *AllegSkill*. [51] FreeAllegiance Wiki, *Stack rating*. [52] Wikipedia, *Allegiance (video game)*. [53] Wikipedia, *Natural Selection (video game)*. [54] Wikipedia, *Savage: The Battle for Newerth*. [55] Wikipedia, *Nuclear Dawn*. [56] Wikipedia, *Battlezone (1998 video game)*. [57] Wikipedia, *Battlezone II: Combat Commander*. [58] Unknown Worlds 2020-10-16, *Introducing Hiveskill 3.0*. [59] Unknown Worlds 2020-10-28, *Update 335*. [60] Unknown Worlds 2016, *Build 310* (Hive 2.0). [61] Unknown Worlds forums 2016, *So what about hive 2.0?*. [62] Moultano 2014, NS2 skill ranking design post. [63] Steam, *Silica*. [64] Steam, *Eximius: Seize the Frontline*.

**E. Matchmaking, engagement, incentives.** [65] Chen et al. 2017, EOMM (WWW). [66] Chen, Elmachtoub & Lei 2024, *Management Science*. [67] Kang, Suh & Kim 2024, *Heliyon* 10(3). [68] Jaffe et al. 2012, restricted-play balance (AIIDE). [69] Diekmann 1985, volunteer's dilemma (*JCR* 29). [70] Strathern 1997, 'Improving ratings' (*European Review* 5). [71] Campbell 1979, planned social change (*EPP* 2). [72] Hardt et al. 2016, strategic classification (ITCS). [73] Kleinberg & Raghavan 2020, strategic effort (*ACM TEAC* 8). [74] Nosek & Lakens 2014, Registered Reports (*Social Psychology* 45). [75] Chambers 2013, Registered Reports at *Cortex*.

**F. Internal provenance.** [76] `data/processed/*.json` as of 2026-10-04 + `data/external/f9_*.json`. [77] `scripts/elo.py`, `scripts/elo_commander.py`, `scripts/validate_elo.py` v1.8 (§15–§19 are the regeneration path for Part 3; §20 for section 5.4). [78] Prior reviews v1–v3, the June 2026 review, the external critique. [79] Decision memos in `critique/decisions/`, including the new `phase-6-faction-advantage-term.md`. [80] Operator answers recorded in the v4 planning thread. [81] `ideas.txt` §4. [82] `DEVELOPER_GUIDE.md` §13, `docs/DATA_DICTIONARY.md` §11.

**G. Added in the format-gate addendum.** [83] Blizzard, *Leagues and Ladders FAQ* (StarCraft II: placement per mode, random-team rank per mode, arranged-team ratings). [84] Liquipedia, *Battle.net Leagues*. [85] Chess.com / FIDE / Kosteniuk, 2012: the first separate rapid and blitz rating lists (1 July 2012). [86] CSDB.gg, *How CS2 ranking works* — Wingman 2v2 on its own skill group (third-party guide; Valve publishes no Wingman documentation).

---

## Part 11 — Author's perspective

I built this, I command more than anyone in the data, and I am rated by it exactly like you are. My own rows are in the tables above: +3.3 a game across 42 commander matches, −0.7 across 68 thug matches, a thug rating 98 points above my win ladder, a commander rating in the middle of the pack. I can't change those numbers except by playing.

The complaint is right about the thing it describes and wrong about the cause. VTSR-T is a performance rating. It was built as one and it behaves as one — stable, calibrated, and disagreeing with winning the way performance ratings always have. When a strong thug loses rating on a lost game while out-performing the lobby, that's the rating saying the bar was higher than what got delivered. Whether that's the number the community wants on the front page is a fair product question. It isn't evidence the math is wrong.

What the complaint gets right is that two axes reward the wrong thing and that time on the pad is charged to the wrong account. Those are the two things I'd fix first, and both came from looking at the data, not from the argument.

On factions I was skeptical and the data surprised me. A sixty-point Hadean effect that survives controlling for everyone's ratings, with the same sign in two independent record sets, isn't noise. So: freeze a number, wait for games nobody has played yet, let them decide. If they say I'm wrong, the memo says so too.

On roles and ships: no — not because people are seeing things, but because every role rating that worked anywhere had the role declared before the match, and ours is a ship someone else built. Fix the commander adjustment first.

Every mechanism in this system is used somewhere that pays people to get it right, and the two parts that are local inventions are the ones under test. Where the professionals disagree with each other — and on roles and factions they've reversed themselves inside a year — the only defensible move is to run the experiment with the rule written first. The memos have told me no more often than yes, and some of what they said no to was drafted by the tooling I'm told I trust too much. The tooling doesn't get a vote. The validator does.

`python scripts/validate_elo.py`. Everything above is in the report it writes.

---

*v4 drafted 2026-10-04. In-depth edition: `elo-analysis-v4.md`. Decision memos: `critique/decisions/`. Earlier editions: `critique/analysis-archive/`.*
