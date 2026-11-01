/*
 * VT Stats — shared Highlights renderer (window.VTHighlights).
 *
 * The Match Highlights (per-match, `mode = 'match'`) and Career
 * Highlights (`mode = 'career'`) tile grids, extracted from js/app.js so
 * the dashboard and the Players hub render the same cards from one copy
 * table. Data comes from match_data.highlights (scripts/process_stats.py
 * compute_highlights) or the aggregator's career_highlights. Cards whose
 * data gates failed are simply absent. Match-global + always-unfiltered.
 *
 * Player links go through window.vtPlayerLinkHtml when the dashboard
 * defines it, else window.VTPlayer.playerHref on /player/ pages, else
 * plain text. Containers default to the dashboard ids and can be
 * overridden through opts.cardId / opts.gridId.
 */
(function (global) {
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function vtPlayerLinkHtml(name, steam64) {
  if (typeof global.vtPlayerLinkHtml === 'function') return global.vtPlayerLinkHtml(name, steam64);
  if (global.VTPlayer && typeof global.VTPlayer.playerHref === 'function' && steam64) {
    return `<a href="${esc(global.VTPlayer.playerHref(steam64))}" class="vt-player-link">${esc(name)}</a>`;
  }
  return esc(name);
}

// ===========================================================================
// Match Highlights — fixed-slate award catalog (12 cards, always-on).
// Data comes from match_data.highlights (built by scripts/process_stats.py
// compute_highlights). Cards whose data gates failed are simply absent.
// Match-global + always-unfiltered: filterState is intentionally ignored.
// ===========================================================================

// Three short variants per (category, narrative) bucket. Selected
// deterministically (seeded by match id + category) so the same match
// always shows the same line.
const HIGHLIGHT_COPY = {
  the_bully: {
    dominant: [
      '{name} ran the table on {top_victim} — {top_victim_damage} of {value} PvP.',
      '{name} bullied the lobby into next week — most on {top_victim}.',
      '{name} dropped {value} PvP dmg and nobody was close.',
    ],
    clear: [
      '{name} led the field on PvP damage at {value}.',
      '{name} took the damage crown — most on {top_victim}.',
      '{name} out-damaged the pack at {value}.',
    ],
    close: [
      '{name} edged the field on PvP damage.',
      '{name} squeaked out the damage lead.',
      '{name} barely held the damage crown.',
    ],
  },
  the_grim_reaper: {
    dominant: [
      '{name} reaped {value} kills — {top_victim_count} of them on {top_victim}.',
      '{name} farmed the lobby for {value} kills.',
      '{name} put a tag on every name in the kill feed.',
    ],
    clear: [
      '{name} led the kill feed with {value}.',
      '{name} topped the kill chart at {value}.',
      '{name} closed out {value} kills.',
    ],
    close: [
      '{name} edged the kill race with {value}.',
      '{name} barely held the kill lead.',
      '{name} squeaked the kill crown.',
    ],
  },
  bullet_sponge: {
    dominant: [
      '{name} ate {value} PvP damage — most of it from {top_tormentor}.',
      '{name} soaked {value} from humans and kept rolling.',
      '{name} was a magnet for incoming fire — {top_tormentor} kept finding them.',
    ],
    clear: [
      '{name} took the most PvP damage — {value}.',
      '{name} caught {value} on the chin.',
      '{name} absorbed {value} from humans.',
    ],
    close: [
      '{name} just barely took the most punishment.',
      '{name} edged the field on PvP damage taken.',
      '{name} narrowly led in damage absorbed.',
    ],
  },
  the_hustler: {
    dominant: [
      '{name} traded {kills} kills for {deaths} deaths — efficiency clinic.',
      '{name} posted a {value} K/D and made it look easy.',
      '{name} ran {kills}K / {deaths}D — nobody else came close.',
    ],
    clear: [
      '{name} led K/D at {value} ({kills}/{deaths}).',
      '{name} closed out the best trade ratio at {value}.',
      '{name} topped K/D at {value}.',
    ],
    close: [
      '{name} edged the K/D lead at {value}.',
      '{name} squeaked the best trade ratio.',
      '{name} barely held the top K/D.',
    ],
  },
  sharpshooter: {
    dominant: [
      '{name} hit {shots_hit} of {shots_fired} shots — a laser.',
      '{name} sniped at {value} accuracy.',
      '{name} aimed like the rest were spraying.',
    ],
    clear: [
      '{name} led accuracy at {value} ({shots_hit}/{shots_fired}).',
      '{name} put rounds on target at {value}.',
      '{name} topped the accuracy table.',
    ],
    close: [
      '{name} edged the accuracy lead.',
      '{name} barely won the accuracy crown.',
      '{name} squeaked top accuracy.',
    ],
  },
  gunner: {
    dominant: [
      '{name} sent {value} rounds downrange — and kept going.',
      '{name} held the trigger for {value} shots.',
      '{name} could not stop firing — {value} shots.',
    ],
    clear: [
      '{name} fired the most rounds — {value}.',
      '{name} put {value} rounds in the air.',
      '{name} led shots fired at {value}.',
    ],
    close: [
      '{name} edged the trigger-pull race.',
      '{name} barely fired more than the next.',
      '{name} squeaked the shots-fired lead.',
    ],
  },
  puppeteer: {
    dominant: [
      '{name}\u2019s scavs and turrets did {value} damage on their own.',
      '{name} let the AI cook — {value} asset damage.',
      '{name} commanded a small army for {value} damage.',
    ],
    clear: [
      '{name} got {value} damage from owned assets.',
      '{name} pulled strings for {value} asset damage.',
      '{name} had the busiest turrets and scavs.',
    ],
    close: [
      '{name} edged the asset-damage race.',
      '{name} barely led on owned-AI damage.',
      '{name} squeaked the puppeteer crown.',
    ],
  },
  frenemies: {
    dominant: [
      '{a} and {b} would not stop trading shots — {value} dmg between them.',
      '{a} and {b} ran their own private war.',
      '{a} vs {b} accounted for the loudest pocket of the lobby.',
    ],
    clear: [
      '{a} and {b} traded {value} damage.',
      '{a} and {b} kept finding each other for {value} damage.',
      '{a} vs {b} was the headline matchup.',
    ],
    close: [
      '{a} and {b} kept brushing past each other for {value} damage.',
      '{a} vs {b} stayed neck-and-neck.',
      '{a} and {b} matched blow for blow.',
    ],
  },
  roadrunner: {
    dominant: [
      '{name} covered the map — activity score {value}.',
      '{name} would not stand still. Score: {value}.',
      '{name} roamed everywhere — {value}/100 activity.',
    ],
    clear: [
      '{name} led the map in activity at {value}/100.',
      '{name} clocked the most ground covered.',
      '{name} stayed on the move all match.',
    ],
    close: [
      '{name} edged the activity board.',
      '{name} barely led on map coverage.',
      '{name} squeaked the most-active crown.',
    ],
  },
  crate_pod_goblin: {
    dominant: [
      '{name} scooped {pickups} crates and trashed {destructions} more.',
      '{name} ran the powerup economy — {pickups} pickups, {destructions} denials.',
      '{name} would not let a crate live — {pickups}/{destructions}.',
    ],
    clear: [
      '{name} grabbed {pickups} crates and shot {destructions} more.',
      '{name} owned the powerup map: {pickups} pickups + {destructions} kills.',
      '{name} ran the crate route ({pickups}+{destructions}).',
    ],
    close: [
      '{name} edged the crate hustle ({pickups}+{destructions}).',
      '{name} barely led the powerup tally.',
      '{name} squeaked the crate crown.',
    ],
  },
  chris_kyle: {
    dominant: [
      '{name} put a scope on everyone — {value} pilot snipes ({top_victim_count} on {top_victim}).',
      '{name} sniped {value} pilots out of their seats.',
      '{name} hunted cockpits all match — {value} snipes.',
    ],
    clear: [
      '{name} led pilot snipes at {value}.',
      '{name} popped {value} pilots clean.',
      '{name} took {value} cockpit kills.',
    ],
    close: [
      '{name} edged the snipe race at {value}.',
      '{name} squeaked the snipe crown.',
      '{name} barely led pilot snipes.',
    ],
  },
  the_locksmith: {
    dominant: [
      '{name} dominated T-key usage — target lock active ~{seconds_locked}s of {total_seconds}s.',
      '{name} ran target mode for {value} of the match.',
      '{name} owned the target-lock board at {value}.',
    ],
    clear: [
      '{name} had a target locked {value} of the time.',
      '{name} led T-key usage at {value}.',
      '{name} ran target mode for {value} of the match.',
    ],
    close: [
      '{name} edged the target-lock board at {value}.',
      '{name} squeaked the locksmith title.',
      '{name} barely led on T-key usage.',
    ],
  },
  the_tycoon: {
    dominant: [
      '{name} generated {value} scrap — the enemy economy never stood a chance.',
      '{name} ran a printing press: {value} scrap, {income_loose} collected as loose.',
      '{name} out-earned the other commander by a mile.',
    ],
    clear: [
      '{name} led scrap generation at {value}.',
      '{name} won the economy war — {value} scrap generated.',
      '{name} kept the scrap flowing at {value}.',
    ],
    close: [
      '{name} edged the economy race at {value} scrap.',
      '{name} narrowly out-earned the enemy commander.',
      '{name} squeaked the Elon Musk title.',
    ],
  },
  loose_collector: {
    dominant: [
      '{name} hauled in {value} loose — the field was stripped clean.',
      '{name} vacuumed the map: {value} loose collected.',
      '{name} out-scavenged the other commander by a mile.',
    ],
    clear: [
      '{name} won the loose race at {value}.',
      '{name} led loose collection at {value}.',
      '{name} hauled the most loose off the field.',
    ],
    close: [
      '{name} edged the loose race at {value}.',
      '{name} narrowly out-collected the enemy scavs.',
      '{name} squeaked the Loose Collector title.',
    ],
  },
  war_machine: {
    dominant: [
      '{name} fielded {value} scrap of combat ships — an assembly line at war.',
      '{name} converted the bank into {ships_built} warships.',
      '{name} out-produced the enemy line by a mile.',
    ],
    clear: [
      '{name} led combat production — {ships_built} ships, {value} scrap fielded.',
      '{name} kept the conveyor belt turning at {value} scrap of ships.',
      '{name} won the production race.',
    ],
    close: [
      '{name} edged combat production at {value} scrap.',
      '{name} narrowly out-produced the enemy commander.',
      '{name} squeaked the conveyor-belt crown.',
    ],
  },
  first_upgrade: {
    dominant: [
      '{name} dropped the first upgraded pool at {value}.',
      '{name} had a {upgrade_name} up at {value} — the other side was still planting.',
      '{name} won the upgrade race by a mile.',
    ],
    clear: [
      '{name} won the upgrade race at {value}.',
      '{name} got the first upgraded pool live at {value}.',
      '{name} beat the other commander to the first {upgrade_name}.',
    ],
    close: [
      '{name} nipped the first upgrade at {value}.',
      '{name} won the upgrade race by a few seconds.',
      '{name} squeaked the first-upgrade crown.',
    ],
  },
};

// Soft FNV-1a-ish hash — small, deterministic, no need for crypto.
// Used to pick a copy variant per (matchId, category) so the same match
// always shows the same line, but two matches don't echo each other.
function _hlHash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// Highlight integers always use a US thousands separator. The page-wide
// fmt() stays locale-aware; highlight headlines, breakdowns, and flavor
// sentences share this helper so a European browser cannot print 44.271
// on one line and 44,271 on another.
function formatHighlightInt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

function formatHighlightValue(value, format) {
  if (value == null) return '—';
  switch (format) {
    case 'damage':   return formatHighlightInt(value);
    case 'distance': return formatHighlightInt(value);
    case 'count':    return formatHighlightInt(value);
    case 'score':    return formatHighlightInt(value);
    case 'scrap':    return formatHighlightInt(value);
    case 'duration': {
      const s = Math.max(0, Math.round(Number(value) || 0));
      return `${Math.floor(s / 60)}m:${s % 60}s`;
    }
    case 'ratio':    return Number(value).toFixed(2);
    case 'kd':       return Number(value).toFixed(2);
    case 'percent':
    case 'accuracy': return (Number(value) * 100).toFixed(1) + '%';
    default:         return String(value);
  }
}

// Per-category unit suffix appended to the headline value (and runner-up).
// Empty string for cards whose value_format already self-labels (`accuracy`
// / `percent` produce e.g. "27.4%") or whose breakdown line already supplies
// the context (Pod Goblin shows "X grabbed · Y denied"). Pure
// presentation; not part of the JSON payload. Adding a new card requires
// adding an entry here.
const HIGHLIGHT_UNITS = {
  the_bully:        'dmg',
  the_grim_reaper:  'kills',
  bullet_sponge:    'dmg',
  the_hustler:      'K/D',
  sharpshooter:     '',
  gunner:           'shots',
  puppeteer:        'dmg',
  frenemies:        'dmg',
  roadrunner:       'mvnt',
  crate_pod_goblin: '',
  chris_kyle:       'snipes',
  the_locksmith:    '',
  // v17 (proto v4) commander-economy cards.
  the_tycoon:       'scrap',
  loose_collector:  'loose',
  war_machine:      'scrap',
  first_upgrade:    'upgrade',
};

// Presentation-only overrides for the tile heading. The pipeline emits a
// canonical `card.label` ("Gunner", etc.); this map lets us rebrand a card
// in the UI without rewriting historical processed JSON.
const HIGHLIGHT_LABEL_OVERRIDES = {
  gunner: 'Trigger Happy',
  the_tycoon: 'Elon Musk',
  war_machine: 'Conveyor Belt',
};

// ---- Career Highlights (built client-side by the aggregator) ----
// Three flavor lines per (category, narrative) bucket. Selected
// deterministically by hash(matchId='all-matches' + category) so the
// same All Matches view always shows the same line; the Per-match
// and Career grids render their own copy tables independently.
const CAREER_HIGHLIGHT_COPY = {
  career_the_bully: {
    dominant: [
      '{name} has spent {value} dmg on humans across the corpus — most on {top_victim}.',
      '{name} bullied the league for {value} PvP dmg.',
      '{name} farms PvP like a job — {value} lifetime.',
    ],
    clear: [
      '{name} leads career PvP damage at {value}.',
      '{name} tops the lifetime PvP charts with {value}.',
      '{name} owns the long-haul PvP crown.',
    ],
    close: [
      '{name} narrowly leads career PvP damage.',
      '{name} edges the lifetime PvP race.',
      '{name} squeaks the all-time PvP crown.',
    ],
  },
  career_the_grim_reaper: {
    dominant: ['{name} has reaped {value} kills league-wide.', '{name} owns the all-time kill column.', '{name} has tagged the corpus {value} times.'],
    clear:    ['{name} leads career kills at {value}.',        '{name} tops the lifetime kill chart.',  '{name} closes out the most kills.'],
    close:    ['{name} narrowly leads career kills.',          '{name} edges the lifetime kill race.',  '{name} squeaks the all-time kill crown.'],
  },
  career_bullet_sponge: {
    dominant: ['{name} has absorbed {value} dmg lifetime — a magnet.', '{name} soaks more incoming than anyone — {value} all-time.', '{name} won\u2019t stop catching rounds — {value} lifetime.'],
    clear:    ['{name} leads career damage taken at {value}.',         '{name} has eaten the most lifetime damage.',                 '{name} tops the all-time absorbed-dmg column.'],
    close:    ['{name} edges career absorbed damage.',                 '{name} narrowly leads lifetime damage taken.',               '{name} squeaks the long-haul sponge crown.'],
  },
  career_the_hustler: {
    dominant: ['{name}\u2019s career K/D of {value} ({kills}/{deaths}) is a clinic.', '{name} runs a {value} lifetime trade ratio.', '{name} owns the K/D column at {value}.'],
    clear:    ['{name} leads career K/D at {value} ({kills}/{deaths}).',              '{name} tops the lifetime trade ratio at {value}.', '{name} holds the best long-run K/D.'],
    close:    ['{name} edges career K/D at {value}.',                                 '{name} narrowly leads the lifetime trade ratio.',  '{name} squeaks the all-time K/D crown.'],
  },
  career_sharpshooter: {
    dominant: ['{name} hits {value} of shots fired ({shots_hit}/{shots_fired}). Laser.', '{name} is a sniper — {value} career accuracy.', '{name}\u2019s {value} accuracy across {shots_fired} shots is wild.'],
    clear:    ['{name} leads career accuracy at {value}.',                               '{name} tops the lifetime accuracy column.',     '{name} owns the long-run sharpshooter crown.'],
    close:    ['{name} edges career accuracy at {value}.',                               '{name} narrowly leads lifetime accuracy.',      '{name} squeaks the all-time accuracy crown.'],
  },
  career_trigger_happy: {
    dominant: ['{name} has fired {value} rounds league-wide. Get this person an ammo subscription.', '{name} held the trigger for {value} shots across the corpus.', '{name}\u2019s {value} lifetime shots is hard to fathom.'],
    clear:    ['{name} fired the most rounds — {value} lifetime.',                                  '{name} leads lifetime shots at {value}.',                       '{name} tops the all-time trigger column.'],
    close:    ['{name} edges lifetime shots at {value}.',                                           '{name} narrowly leads career shots fired.',                     '{name} squeaks the all-time trigger crown.'],
  },
  career_puppeteer: {
    dominant: ['{name}\u2019s scavs and turrets have done {value} dmg lifetime.', '{name} commands a small army — {value} asset dmg.',  '{name} owns the lifetime puppeteer column at {value}.'],
    clear:    ['{name} leads career asset dmg at {value}.',                       '{name} pulled the most strings overall.',            '{name} tops the all-time puppeteer chart.'],
    close:    ['{name} edges career asset dmg at {value}.',                       '{name} narrowly leads lifetime asset dmg.',          '{name} squeaks the long-run puppeteer crown.'],
  },
  career_frenemies: {
    dominant: ['{a} and {b} have traded {value} dmg over the years.', '{a} and {b} are each other\u2019s favorite enemy.', '{a} vs {b} is the corpus\u2019s headline matchup.'],
    clear:    ['{a} and {b} traded {value} dmg.',                     '{a} and {b} have the corpus\u2019s top rivalry.',   '{a} vs {b} leads career rivalries.'],
    close:    ['{a} and {b} narrowly lead career rivalries.',         '{a} vs {b} squeaks the all-time pair crown.',       '{a} and {b} edge the lifetime pair race.'],
  },
  career_roadrunner: {
    dominant: ['{name} averages {value}/100 activity across {matches_with_positioning}+ matches.', '{name} won\u2019t sit still — {value} mean.', '{name} covers more map than anyone — {value} avg.'],
    clear:    ['{name} leads career mobility at {value}/100.',                                    '{name} tops average activity across the corpus.', '{name} owns the long-run mobility crown.'],
    close:    ['{name} edges career mobility at {value}.',                                        '{name} narrowly leads lifetime activity.',        '{name} squeaks the all-time mobility crown.'],
  },
  career_pod_goblin: {
    dominant: ['{name} has scooped {pickups} crates and trashed {destructions} more.', '{name} runs the corpus pickup economy.',         '{name} owns the lifetime crate column at {value}.'],
    clear:    ['{name} grabbed {pickups} + denied {destructions} crates lifetime.',     '{name} leads career powerup activity at {value}.', '{name} tops the all-time crate chart.'],
    close:    ['{name} edges career crate activity at {value}.',                        '{name} narrowly leads lifetime pickups + denials.', '{name} squeaks the long-run pod-goblin crown.'],
  },
  career_chris_kyle: {
    dominant: ['{name} has sniped {value} pilots out of their cockpits.', '{name} hunts cockpits for sport — {value} lifetime.', '{name} owns the snipe column at {value}.'],
    clear:    ['{name} leads career snipes at {value}.',                  '{name} tops lifetime pilot snipes at {value}.',         '{name} holds the all-time snipe crown.'],
    close:    ['{name} edges career snipes at {value}.',                  '{name} narrowly leads lifetime snipes.',                '{name} squeaks the all-time snipe crown.'],
  },
  career_the_locksmith: {
    dominant: ['{name} averages {value} target lock — basically welded to the T key.', '{name} runs target mode for {value} of every match.', '{name} dominates lifetime T-key usage.'],
    clear:    ['{name} averages {value} target lock across rated matches.',            '{name} leads career T-key usage at {value}.',          '{name} tops the all-time locksmith column.'],
    close:    ['{name} edges career T-key usage at {value}.',                          '{name} narrowly leads lifetime target lock.',          '{name} squeaks the long-run locksmith crown.'],
  },
  career_tycoon: {
    dominant: ['{name} has generated {value} scrap across {econ_matches} recorded v4 games.', '{name} leads recorded v4 scrap income at {value}.', '{name} out-earns other commanders on v4 telemetry.'],
    clear:    ['{name} leads recorded v4 scrap generation at {value}.', '{name} tops v4 commander income ({avg_income_per_min}/min over {econ_matches} games).', '{name} holds the v4 Elon Musk mark.'],
    close:    ['{name} edges recorded v4 scrap generation at {value}.', '{name} narrowly leads v4 commander income.', '{name} squeaks the v4 Elon Musk mark.'],
  },
  career_loose_collector: {
    dominant: ['{name} has hauled in {value} loose across {econ_matches} recorded v4 games.', '{name} leads recorded v4 loose at {value}.', '{name} out-collects other commanders on v4 telemetry.'],
    clear:    ['{name} leads recorded v4 loose collection at {value}.', '{name} tops loose hauled off the field in {econ_matches} v4 games.', '{name} holds the v4 Loose Collector mark.'],
    close:    ['{name} edges recorded v4 loose collection at {value}.', '{name} narrowly leads v4 loose collected.', '{name} squeaks the v4 Loose Collector mark.'],
  },
  career_war_machine: {
    dominant: ['{name} has fielded {value} scrap of combat ships across {build_matches} recorded v4 games.', '{name} built {ships_built} warships across {build_matches} v4 games.', '{name} out-produces other commanders on v4 telemetry.'],
    clear:    ['{name} leads recorded v4 combat production at {value} scrap.', '{name} tops v4 warship output — {ships_built} ships over {build_matches} games.', '{name} holds the v4 conveyor-belt mark.'],
    close:    ['{name} edges recorded v4 combat production at {value} scrap.', '{name} narrowly leads v4 warship output.', '{name} squeaks the v4 conveyor-belt mark.'],
  },
  the_veteran: {
    dominant: ['{name} has been to {value} matches and counting.', '{name} is the all-time leader in showing up.',       '{name} has the most miles on the odometer.'],
    clear:    ['{name} has played the most matches — {value}.',    '{name} leads career match count at {value}.',         '{name} owns the all-time appearance column.'],
    close:    ['{name} narrowly leads matches played at {value}.', '{name} edges the lifetime attendance race.',          '{name} squeaks the most-matches-played crown.'],
  },
  the_workhorse: {
    dominant: ['{name} has commanded {value} matches league-wide.', '{name} is the corpus\u2019s favorite commander.',     '{name} owns the lifetime command column at {value}.'],
    clear:    ['{name} leads matches as commander at {value}.',     '{name} tops career command appearances.',             '{name} holds the all-time workhorse crown.'],
    close:    ['{name} edges career commander matches at {value}.', '{name} narrowly leads lifetime command count.',       '{name} squeaks the workhorse crown.'],
  },
  the_carry: {
    dominant: ['{name} wins {value} of commanded matches — pure carry energy.', '{name} carries every game they command.',          '{name} owns the commander win-rate column at {value}.'],
    clear:    ['{name} leads commander win % at {value}.',                      '{name} tops career commander wins at {value}.',     '{name} holds the all-time carry crown.'],
    close:    ['{name} edges commander win % at {value}.',                      '{name} narrowly leads commander wins.',             '{name} squeaks the carry crown.'],
  },
  the_anchor: {
    dominant: ['{name} wins {value} of matches as a thug — the anchor that never breaks.', '{name} is a wall on the back line.',     '{name} owns the thug win-rate column at {value}.'],
    clear:    ['{name} leads thug win % at {value}.',                                       '{name} tops career thug wins at {value}.', '{name} holds the all-time anchor crown.'],
    close:    ['{name} edges thug win % at {value}.',                                       '{name} narrowly leads thug wins.',         '{name} squeaks the anchor crown.'],
  },
  isdf_loyalist: {
    dominant: ['{name} has played ISDF in {value} matches — true believer.', '{name} bleeds ISDF cyan.',                       '{name} is the league\u2019s ISDF poster child.'],
    clear:    ['{name} leads ISDF appearances at {value}.',                  '{name} has the most ISDF matches — {value}.',     '{name} tops the all-time ISDF column.'],
    close:    ['{name} edges ISDF appearances at {value}.',                  '{name} narrowly leads ISDF matches.',             '{name} squeaks the ISDF loyalist crown.'],
  },
  hadean_loyalist: {
    dominant: ['{name} has played Hadean in {value} matches — true believer.', '{name} bleeds Hadean red.',                     '{name} is the league\u2019s Hadean poster child.'],
    clear:    ['{name} leads Hadean appearances at {value}.',                   '{name} has the most Hadean matches — {value}.', '{name} tops the all-time Hadean column.'],
    close:    ['{name} edges Hadean appearances at {value}.',                   '{name} narrowly leads Hadean matches.',         '{name} squeaks the Hadean loyalist crown.'],
  },
  scion_loyalist: {
    dominant: ['{name} has played Scion in {value} matches — true believer.',  '{name} bleeds Scion green.',                    '{name} is the league\u2019s Scion poster child.'],
    clear:    ['{name} leads Scion appearances at {value}.',                    '{name} has the most Scion matches — {value}.',  '{name} tops the all-time Scion column.'],
    close:    ['{name} edges Scion appearances at {value}.',                    '{name} narrowly leads Scion matches.',          '{name} squeaks the Scion loyalist crown.'],
  },
  the_diplomat: {
    dominant: ['{name} has shared a team with {value} different players. Friend to all.', '{name} is everyone\u2019s teammate — {value} distinct.', '{name} owns the diplomacy column at {value}.'],
    clear:    ['{name} leads distinct teammates at {value}.',                              '{name} has played alongside the most people.',           '{name} holds the corpus diplomat crown.'],
    close:    ['{name} edges distinct teammates at {value}.',                              '{name} narrowly leads career teammate variety.',         '{name} squeaks the diplomat crown.'],
  },
  map_master: {
    dominant: ['{name} wins {value} of matches on {map_name} ({kills}-{deaths}). Owns it.', '{name} owns {map_name} — {value} W%.',    '{name} is the king of {map_name} at {value}.'],
    clear:    ['{name} leads {map_name} with {value} W% ({kills}-{deaths}).',              '{name} tops the win % on {map_name}.',     '{name} holds the {map_name} crown.'],
    close:    ['{name} edges {map_name} W% at {value}.',                                   '{name} narrowly leads {map_name}.',        '{name} squeaks the {map_name} crown.'],
  },
  streak_king: {
    dominant: ['{name} is on a {value}-match win streak. Untouchable right now.', '{name} hasn\u2019t lost in {value} matches.',  '{name} is on a tear — {value} wins running.'],
    clear:    ['{name} leads active streaks at {value} wins.',                    '{name} has the longest current win streak.',   '{name} holds the streak crown at {value}.'],
    close:    ['{name} edges active streaks at {value} wins.',                    '{name} narrowly leads current streaks.',       '{name} squeaks the streak crown.'],
  },
  the_polymath: {
    dominant: ['{name} has fired {value} different weapons across the corpus. Renaissance pilot.', '{name} has touched every weapon in the game.', '{name} owns the all-time variety column at {value}.'],
    clear:    ['{name} leads career weapon variety at {value}.',                                   '{name} tops the lifetime polymath column.',     '{name} holds the all-time variety crown.'],
    close:    ['{name} edges career weapon variety at {value}.',                                   '{name} narrowly leads lifetime weapon count.',  '{name} squeaks the polymath crown.'],
  },
};

const CAREER_HIGHLIGHT_UNITS = {
  career_the_bully:        'dmg',
  career_the_grim_reaper:  'kills',
  career_bullet_sponge:    'dmg',
  career_the_hustler:      'K/D',
  career_sharpshooter:     '',
  career_trigger_happy:    'shots',
  career_puppeteer:        'dmg',
  career_frenemies:        'dmg',
  career_roadrunner:       'mvnt',
  career_pod_goblin:       '',
  career_chris_kyle:       'snipes',
  career_the_locksmith:    '',
  career_tycoon:           'scrap',
  career_loose_collector:  'loose',
  career_war_machine:      'scrap',
  the_veteran:             'matches',
  the_workhorse:           'commands',
  the_carry:               '',
  the_anchor:              '',
  isdf_loyalist:           'matches',
  hadean_loyalist:         'matches',
  scion_loyalist:          'matches',
  the_diplomat:            'teammates',
  map_master:              '',
  streak_king:             'wins',
  the_polymath:            'wpns',
};

// No career-mode label overrides — labels come straight from the
// aggregator's CAREER_HIGHLIGHT_LABELS table.
const CAREER_HIGHLIGHT_LABEL_OVERRIDES = {};

// Schema v2 breakdown line: pre-computed per-category context that gives the
// headline number meaning ("4.00" -> "12K / 3D (4.00)", "27.4%" -> "482 / 1,758").
// Expects card.value_breakdown to carry the keys produced by compute_highlights()
// in scripts/process_stats.py. Returns '' when no breakdown data is available
// so the line is skipped cleanly.
function formatHighlightBreakdown(card) {
  const b = card.value_breakdown || {};
  switch (card.category) {
    case 'the_bully':
      return b.top_victim
        ? `most on ${esc(b.top_victim)}: ${formatHighlightInt(b.top_victim_damage)} dmg`
        : '';
    case 'the_grim_reaper':
      return b.top_victim
        ? `${b.top_victim_count} kills on ${esc(b.top_victim)}`
        : '';
    case 'bullet_sponge':
      return b.top_tormentor
        ? `most from ${esc(b.top_tormentor)}: ${formatHighlightInt(b.top_tormentor_damage)} dmg`
        : '';
    case 'the_hustler': {
      if (b.kills == null && b.deaths == null) return '';
      const ratio = (b.deaths === 0 && b.kills > 0) ? 'perfect' : Number(card.value).toFixed(2);
      return `${b.kills}K / ${b.deaths}D (${ratio})`;
    }
    case 'sharpshooter':
      if (b.shots_hit == null || b.shots_fired == null) return '';
      return `${formatHighlightInt(b.shots_hit)} / ${formatHighlightInt(b.shots_fired)} shots${b.estimated ? ' (est.)' : ''}`;
    case 'gunner':
      if (b.accuracy == null) return '';
      return `@ ${(Number(b.accuracy) * 100).toFixed(1)}% accuracy${b.estimated ? ' (est.)' : ''}`;
    case 'puppeteer':
      if (b.personal_dealt == null) return '';
      return `vs ${formatHighlightInt(b.personal_dealt)} personal dmg`;
    case 'frenemies':
      if (b.a_to_b == null || b.b_to_a == null) return '';
      return `${esc(card.winner.a)} ${formatHighlightInt(b.a_to_b)} \u2194 ${esc(card.winner.b)} ${formatHighlightInt(b.b_to_a)}`;
    case 'roadrunner': {
      const parts = [];
      if (b.movement_band) parts.push(esc(b.movement_band));
      if (b.path_length != null) parts.push(`${formatHighlightInt(b.path_length)}u path`);
      return parts.join(' \u00b7 ');
    }
    case 'crate_pod_goblin':
      if (b.pickups == null && b.destructions == null) return '';
      return `${formatHighlightInt(b.pickups || 0)} grabbed \u00b7 ${formatHighlightInt(b.destructions || 0)} denied`;
    case 'chris_kyle':
      return b.top_victim
        ? `${b.top_victim_count} snipes on ${esc(b.top_victim)}`
        : '';
    case 'the_locksmith':
      if (b.seconds_locked == null || b.total_seconds == null) return '';
      return `~${formatHighlightInt(b.seconds_locked)}s of ${formatHighlightInt(b.total_seconds)}s`;
    // ---- Career Highlights ----
    case 'career_the_bully':
      return b.top_victim
        ? `most on ${esc(b.top_victim)}: ${formatHighlightInt(b.top_victim_damage)} dmg`
        : '';
    case 'career_the_hustler': {
      if (b.kills == null && b.deaths == null) return '';
      return `${formatHighlightInt(b.kills)}K / ${formatHighlightInt(b.deaths)}D career`;
    }
    case 'career_sharpshooter':
      if (b.shots_hit == null || b.shots_fired == null) return '';
      return `${formatHighlightInt(b.shots_hit)} / ${formatHighlightInt(b.shots_fired)} shots career`;
    case 'career_frenemies':
      if (b.a_to_b == null || b.b_to_a == null) return '';
      return `${esc(card.winner.a)} ${formatHighlightInt(b.a_to_b)} \u2194 ${esc(card.winner.b)} ${formatHighlightInt(b.b_to_a)}`;
    case 'career_roadrunner': {
      const parts = [];
      if (b.movement_band) parts.push(esc(b.movement_band));
      if (b.path_length != null) parts.push(`${formatHighlightInt(b.path_length)}u path`);
      return parts.join(' \u00b7 ');
    }
    case 'career_pod_goblin':
      if (b.pickups == null && b.destructions == null) return '';
      return `${formatHighlightInt(b.pickups || 0)} grabbed \u00b7 ${formatHighlightInt(b.destructions || 0)} denied`;
    case 'the_carry':
      if (b.kills == null && b.deaths == null) return '';
      return `${b.kills}W / ${b.deaths}L commanding · recorded matches`;
    case 'the_anchor':
      return 'recorded matches';
    case 'map_master':
      if (!b.map_name) return '';
      return `${esc(b.map_name)} (${b.kills}-${b.deaths}) · recorded matches`;
    case 'streak_king':
      return 'recorded matches';
    // v17 commander-economy cards (Elon Musk / Loose Collector / Conveyor Belt / First Upgrade).
    case 'the_tycoon': {
      if (b.income_regen == null && b.income_loose == null) return '';
      const parts = [];
      if (b.income_regen != null) parts.push(`${formatHighlightInt(b.income_regen)} scrap`);
      // Amount-first loose display ("N loose" = scrap amount, per the
      // player-terminology contract).
      if (b.income_loose != null) parts.push(`${formatHighlightInt(b.income_loose)} loose`);
      return parts.join(' · ');
    }
    case 'war_machine':
      if (b.ships_built == null) return '';
      return `${formatHighlightInt(b.ships_built)} combat ships${b.builds_per_min != null ? ` · ${b.builds_per_min}/min` : ''}`;
    case 'first_upgrade':
      return b.upgrade_name ? esc(b.upgrade_name) : '';
    // v17 career commander-economy siblings.
    case 'career_tycoon': {
      if (b.econ_matches == null) return '';
      const parts = [`${formatHighlightInt(b.econ_matches)} v4 games`];
      if (b.avg_income_per_min != null) parts.push(`${formatHighlightInt(b.avg_income_per_min)}/min`);
      if (b.income_loose != null) parts.push(`${formatHighlightInt(b.income_loose)} loose`);
      return parts.join(' · ');
    }
    case 'career_loose_collector': {
      if (b.econ_matches == null) return '';
      const parts = [`${formatHighlightInt(b.econ_matches)} v4 games`];
      if (b.loose_share != null) parts.push(`${(Number(b.loose_share) * 100).toFixed(0)}% of income`);
      return parts.join(' · ');
    }
    case 'career_war_machine': {
      if (b.ships_built == null && b.build_matches == null) return '';
      const parts = [];
      if (b.build_matches != null) parts.push(`${formatHighlightInt(b.build_matches)} v4 games`);
      if (b.ships_built != null) parts.push(`${formatHighlightInt(b.ships_built)} combat ships`);
      if (b.avg_ships_per_min != null) parts.push(`${b.avg_ships_per_min}/min`);
      return parts.join(' · ');
    }
    default:
      return '';
  }
}

function _hlFormatDeltaPct(delta) {
  if (delta == null) return '';
  return Math.round(delta * 100) + '%';
}

function _hlInterp(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = ctx[key];
    return v == null ? '' : String(v);
  });
}

// True when every {token} in `template` resolves to a non-empty value in ctx.
// Used by _hlPickCopy below to skip templates that would interpolate empties
// (e.g. a `{top_victim}`-flavored line on a legacy match with no kill data).
function _hlTemplateSatisfied(template, ctx) {
  const matches = template.match(/\{(\w+)\}/g) || [];
  for (const m of matches) {
    const key = m.slice(1, -1);
    const v = ctx[key];
    if (v === '' || v == null) return false;
  }
  return true;
}

function _hlPickCopy(category, narrative, matchId, ctx, copyTable) {
  const table = copyTable || HIGHLIGHT_COPY;
  const bucket = (table[category] || {})[narrative]
    || (table[category] || {})['clear']
    || [];
  if (!bucket.length) return '';
  const seed = _hlHash(`${matchId || ''}|${category}`);
  // Prefer the deterministic pick when its tokens are all satisfied; otherwise
  // walk the bucket from the seeded index forward and use the first viable
  // variant. As a last resort, return the original deterministic pick (will
  // render with empty interp slots) so we never emit nothing.
  const start = seed % bucket.length;
  for (let i = 0; i < bucket.length; i++) {
    const candidate = bucket[(start + i) % bucket.length];
    if (_hlTemplateSatisfied(candidate, ctx)) return candidate;
  }
  return bucket[start];
}

// Render a Match Highlights or Career Highlights grid. `mode` selects
// the lookup tables AND the DOM containers:
//   'match'  → #section-highlights         + #highlights-grid
//   'career' → #section-career-highlights + #career-highlights-grid
// matchInfo carries the seeding key used to pick deterministic copy
// variants (per-match: match.id; career: a stable string like 'all-matches').
function renderHighlights(highlights, matchInfo, mode, opts) {
  const isCareer = mode === 'career';
  const cardId = (opts && opts.cardId) || (isCareer ? 'section-career-highlights' : 'section-highlights');
  const gridId = (opts && opts.gridId) || (isCareer ? 'career-highlights-grid'    : 'highlights-grid');
  const copyTable     = isCareer ? CAREER_HIGHLIGHT_COPY            : HIGHLIGHT_COPY;
  const unitsTable    = isCareer ? CAREER_HIGHLIGHT_UNITS           : HIGHLIGHT_UNITS;
  const overridesTable = isCareer ? CAREER_HIGHLIGHT_LABEL_OVERRIDES : HIGHLIGHT_LABEL_OVERRIDES;
  const card = document.getElementById(cardId);
  const grid = document.getElementById(gridId);
  if (!card || !grid) return;

  const cards = (highlights && Array.isArray(highlights.cards)) ? highlights.cards : [];
  if (!cards.length) {
    card.classList.add('d-none');
    grid.innerHTML = '';
    return;
  }
  card.classList.remove('d-none');

  const matchId = (matchInfo && matchInfo.id) || '';

  grid.innerHTML = cards.map(c => {
    const isPair = c.winner && c.winner.type === 'pair';
    // Phase 8: when the winner is a single named player, link them
    // through to the canonical profile. Pair cards (Frenemies-style
    // a-vs-b) wrap both names. Falls through to plain text when the
    // pipeline didn't emit a steam64 (or the slug map is missing).
    const w = c.winner || {};
    const winnerName = isPair
      ? `${vtPlayerLinkHtml(w.a, w.a_steam64)} <span class="vt-highlight-tile-vs">vs</span> ${vtPlayerLinkHtml(w.b, w.b_steam64)}`
      : vtPlayerLinkHtml(w.name, w.steam64);
    const valueStr = formatHighlightValue(c.value, c.value_format);
    const breakdown = c.value_breakdown || {};
    // Interpolation context: every documented token from the v2 spec, with
    // sensible fallbacks ('' for missing fields). Integer fields go through
    // formatHighlightInt() so flavor copy matches the US-grouped headline.
    const ctx = {
      name: (c.winner && c.winner.name) || '',
      a: (c.winner && c.winner.a) || '',
      b: (c.winner && c.winner.b) || '',
      value: valueStr,
      delta_pct: _hlFormatDeltaPct(c.delta_pct),
      top_victim: breakdown.top_victim || '',
      top_victim_damage: breakdown.top_victim_damage != null ? formatHighlightInt(breakdown.top_victim_damage) : '',
      top_victim_count: breakdown.top_victim_count != null ? formatHighlightInt(breakdown.top_victim_count) : '',
      top_tormentor: breakdown.top_tormentor || '',
      top_tormentor_damage: breakdown.top_tormentor_damage != null ? formatHighlightInt(breakdown.top_tormentor_damage) : '',
      kills: breakdown.kills != null ? formatHighlightInt(breakdown.kills) : '',
      deaths: breakdown.deaths != null ? formatHighlightInt(breakdown.deaths) : '',
      shots_hit: breakdown.shots_hit != null ? formatHighlightInt(breakdown.shots_hit) : '',
      shots_fired: breakdown.shots_fired != null ? formatHighlightInt(breakdown.shots_fired) : '',
      accuracy: breakdown.accuracy != null ? (Number(breakdown.accuracy) * 100).toFixed(1) + '%' : '',
      personal_dealt: breakdown.personal_dealt != null ? formatHighlightInt(breakdown.personal_dealt) : '',
      a_to_b: breakdown.a_to_b != null ? formatHighlightInt(breakdown.a_to_b) : '',
      b_to_a: breakdown.b_to_a != null ? formatHighlightInt(breakdown.b_to_a) : '',
      movement_band: breakdown.movement_band || '',
      path_length: breakdown.path_length != null ? formatHighlightInt(breakdown.path_length) : '',
      seconds_locked: breakdown.seconds_locked != null ? formatHighlightInt(breakdown.seconds_locked) : '',
      total_seconds: breakdown.total_seconds != null ? formatHighlightInt(breakdown.total_seconds) : '',
      pickups: breakdown.pickups != null ? formatHighlightInt(breakdown.pickups) : '',
      destructions: breakdown.destructions != null ? formatHighlightInt(breakdown.destructions) : '',
      // Career-mode tokens (no-op for per-match cards).
      matches_played: breakdown.matches_played != null ? formatHighlightInt(breakdown.matches_played) : '',
      peak_vtsr:      breakdown.peak_vtsr != null ? formatHighlightInt(breakdown.peak_vtsr) : '',
      map_name:       breakdown.map_name || '',
      matches_with_positioning: breakdown.matches_with_positioning != null ? formatHighlightInt(breakdown.matches_with_positioning) : '',
      // v17 commander-economy tokens (Elon Musk / Loose Collector / Conveyor Belt / First Upgrade + career siblings).
      // Amount-first loose contract: {income_loose} is the scrap amount.
      income_loose: breakdown.income_loose != null ? formatHighlightInt(breakdown.income_loose) : '',
      loose_share:  breakdown.loose_share != null ? (Number(breakdown.loose_share) * 100).toFixed(0) + '%' : '',
      ships_built:   breakdown.ships_built != null ? formatHighlightInt(breakdown.ships_built) : '',
      econ_matches:  breakdown.econ_matches != null ? formatHighlightInt(breakdown.econ_matches) : '',
      build_matches: breakdown.build_matches != null ? formatHighlightInt(breakdown.build_matches) : '',
      avg_income_per_min: breakdown.avg_income_per_min != null ? formatHighlightInt(breakdown.avg_income_per_min) + ' scrap' : '',
      upgrade_name: breakdown.upgrade_name || '',
    };
    const flavor = _hlInterp(_hlPickCopy(c.category, c.narrative, matchId, ctx, copyTable), ctx);
    const breakdownLine = formatHighlightBreakdown(c);
    // Per-category unit suffix (presentation only). Empty string falls back
    // to bare value display for cards whose value_format already self-labels.
    const unit = unitsTable[c.category] || '';
    const unitHtml = unit ? ` <span class="vt-highlight-tile-value-unit">${esc(unit)}</span>` : '';
    const runner = c.runner_up;
    let runnerLine = '';
    if (runner && runner.name) {
      const runnerNum = formatHighlightValue(runner.value, c.value_format);
      const runnerStr = unit ? `${runnerNum} ${unit}` : runnerNum;
      runnerLine = `<div class="vt-highlight-tile-runner">vs ${esc(runner.name)} <span class="vt-highlight-tile-runner-val">${esc(runnerStr)}</span></div>`;
    } else {
      runnerLine = '<div class="vt-highlight-tile-runner vt-highlight-tile-runner--solo">solo standout</div>';
    }
    const dominantClass = c.narrative === 'dominant' ? ' vt-highlight-tile--dominant' : '';
    const tipAttr = flavor
      ? ` data-bs-toggle="tooltip" data-bs-placement="top" title="${esc(flavor)}"`
      : '';
    return `
      <div class="col" data-vt-stagger-child>
        <div class="vt-highlight-tile${dominantClass}"${tipAttr} data-highlight-category="${esc(c.category)}">
          <div class="vt-highlight-tile-head">
            <i class="bi ${esc(c.icon || 'bi-trophy-fill')} vt-highlight-tile-icon"></i>
            <span class="vt-highlight-tile-label">${esc(overridesTable[c.category] || c.label)}</span>
          </div>
          <div class="vt-highlight-tile-winner">${winnerName}</div>
          <div class="vt-highlight-tile-value">${valueStr}${unitHtml}</div>
          ${breakdownLine ? `<div class="vt-highlight-tile-breakdown">${breakdownLine}</div>` : ''}
          ${flavor ? `<div class="vt-highlight-tile-copy">${esc(flavor)}</div>` : ''}
          ${runnerLine}
        </div>
      </div>
    `;
  }).join('');
}

global.VTHighlights = {
  render: renderHighlights,
  formatHighlightValue,
  formatHighlightInt,
  formatHighlightBreakdown,
  HIGHLIGHT_COPY,
  CAREER_HIGHLIGHT_COPY,
  HIGHLIGHT_UNITS,
  CAREER_HIGHLIGHT_UNITS,
  HIGHLIGHT_LABEL_OVERRIDES,
  CAREER_HIGHLIGHT_LABEL_OVERRIDES,
};
})(typeof window !== 'undefined' ? window : globalThis);
