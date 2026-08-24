# FTP Advisor

Single-file Tampermonkey userscript: `ftp-advisor_user.js` (~10.6k lines, one IIFE). Tactical/scouting advisor for fromthepavilion.org (cricket sim). Team auto-detected per install (`getTeamId()`). Public repo: github.com/Jadax/ftp-advisor. No build step, no test suite, no headless access to the live game. Detailed per-version history: `git log` (CLAUDE.md records only current, load-bearing constraints).

## Active rules
- Modular; never duplicate a helper — grep for an existing function before adding one.
- Everything lives in `ftp-advisor_user.js` — no new files unless explicitly asked.
- Comments: only non-obvious WHY (hidden constraint, workaround, magic-number source). Never WHAT.
- After any edit: `node --check "ftp-advisor_user.js"`, plus the relevant harness (see Harnesses).
- No extensive prose in responses; code/diffs directly, short summary.

## Ship workflow
Public repo, installed by others. After a change is verified:
1. Bump `@version` (top of file).
2. `git add -A && git commit -m "vX.Y: <what and why>"`.
3. `git push` (origin configured).
Every shipped change, unless told otherwise.

## File map (grep these, don't re-read the file)
- Constants: top of file — `SKILL_MAP`, `FATIGUE_MAP`, `SKILL_LABELS`, `PITCH_EFFECTS`, `WEATHER_EFFECTS`, `AGE_SCOUT_THRESHOLDS`, `YOUTH_DEV_CURVE`, `AGE_TRAINING_MULTIPLIER`, `ACADEMY_SPEED`, `TRAINING_BASE_RATES`, `MAX_OVERS_PER_BOWLER`
- Age model: `parseGameAge`, `formatAgeDisplay`, `ageYears`, `ageFraction`, `isYouthAge`, `interpAgeTableValue`, `interpAgeSteps`, `weeksToAge`, `weeksToAge20`
- Player ratings: `computePlayerValueSkillSum`, `computePlayerValuePerK`, `computeSpareRating`, `computeOverallRating`, `computePlayerCeiling`, `classifyProjectedPrimary`
- Market pricing: `loadPriceHistory`, `recordPlayerPrice`, `anchorPriceForPlayer`, `computeFairPrice`, `fairPriceLine`
- Cache/routing: `_saveCache`, `_loadCacheWithAge`, `_loadCacheRaw`, `savePlayerCache`, `loadPlayerCache`, `isStale`, `detectPageType`, `fetchAllData`, `cleanupOpponentCache`
- Squad parsing: `parsePlayerRow` (own, grid view squadViewId=2), `parseOpponentPlayerRow` (opponent, reduced columns), `parseSummaryViewBlock`/`scrapeSummaryView`/`fetchSquadSummaryView` (squadViewId=1, ONLY view with Talents), `mergeTalentsIntoPlayers`, `scrapePlayerDetailPage`
- Transfer scouting: `checkScoutBenchmark`, `evaluateTransferTarget`, `evaluateYouthDevelopment`, `calculateRank`, `getPrimarySkillInfo`, `keeperBattingMin`, `isTalentRoleAligned`, `countAlignedTalents`, `comparePlayerToSquadPeers`, `logSquadGapDiagnostic`, `assessSquadVariety`, `computeSquadStats`
- Squad plan: `buildSquadPlan`, `buildSeniorSellRanking`, `buildYouthSellRanking`, `computeRoleSurplus`, `seniorTalentProtection`, `youthTalentProtection`
- Tactics: `calculateBattingScore`, `calculateBowlingScore`, `recommendLineup`, `recommendBattingOrder`, `allocateBowlingSpells`, `expandSpellOvers`, `validateSpellCoverage`, `recommendTossDecision`, `analyzeOpposition`, `dedupePlayers`, `displayBattingOrder`, `displayBowling`
- Training: `estimateWeeklyTrainingGain`, `weeksToNextLevel`, `weeksToTrainSkill`, `recommendTraining`, `_recommendYouthTraining`, `_recommendSeniorTraining`, `_recommendAgingTraining`, `simulateTrainingPlan`, `simulateAdaptiveTrainingPlan`, `academySpeedAtWeek`, `getAcademySpeedForPlayer`, `getAgeTrainingMultiplier`
- Match data feed: `parseMatchScorecard`, `parseMatchChunk`, `parseBattingRow`, `parseBowlingRow`, `parseScorecardFromHTMLDoc`, `parseInningsDivFromHTML`, `saveMatchesToHistory`, `loadMatchHistory`, `getPlayerHistoryStats`, `getTeamHistoryStats`, `getPitchHistoryStats`, `buildPastedScoutingHtml`, `createMatchPasteUI`, `fetchUpcomingFixtures`
- UI: `createPanel`, `addCommonStyles`, `makeDraggable`, `computeConfidence`, `renderConfidenceBadge`, `escapeHtml`, per-page `createXUI`/`updateXAdvisor` pairs
- init: `init()` (page scrape → background fetch → per-page advisor; re-render allowlist includes 'transfer' and 'player')

## Invariants (each exists because breaking it caused a real reported bug)
- **Age parsing**: every age scrape goes through `parseGameAge` (handles "25.05" tables and "25y5w" panels; week is 1-BASED within the age-year, so "20.14" = 20.93, still 20). Per-year table lookups use `ageYears` (floor = the displayed year), NEVER `Math.round` (zero such sites — keep it zero). Simulations advance age `(week-1)/14` per week — 14 weeks per age-year, never 52. `weeksToAge` has a `-1e-9` guard before `ceil` (float drift at exact boundaries).
- **Role detection**: one canonical `getPrimarySkillInfo()` (keeping counts as primary at >=4 and best; 0/0 defaults to batting — a no-data player must not read as a bowler). No ad hoc `Math.max(batting,bowling)` anywhere.
- **Hard filters gate on "known"**: transfer-list rows have `wage: 0, experience: 0, rating: 0` until the per-player fetch. Any min-check on a post-fetch-only field must be gated `known: (v||0) > 0`, or every candidate silently fails and results go empty.
- **Squad cache self-heal**: `fetchAllData` force-refetches when the cache is null, empty, all-zeroed, single-row-zeroed, or one-role-group-missing (youth-only/senior-only); the merge keeps last-known-good per group when a fresh fetch returns 0 for that group. Don't weaken these — an empty cache once stuck permanently and produced weeks of "no current SENIOR X" false gaps.
- **Security**: ALL scraped/pasted names+talents are `escapeHtml()`'d AT THE PARSER (5 name parsers, 3 talent parsers, ground scrape, both scorecard paths). Names are chosen by other users; this script interpolates them into innerHTML at ~80 sites — unescaped = script execution in the authenticated page origin. Add escaping to any NEW scrape point; never rely on render-site escaping. Match-history TEAM names stay raw deliberately (matched against raw page text, never rendered raw).
- **Bowling allocator**: FTP ends ALTERNATE overs — a spell "1st Over: 16, # 3" covers 16,18,20. All expansion goes through `expandSpellOvers` (start + 2i); `validateSpellCoverage` must pass (every over exactly once, nothing past the innings end) — the game rejects otherwise. Per-bowler caps `MAX_OVERS_PER_BOWLER = {OD:10, YOD:8, T20:4, YT20:4}` (manual-confirmed; the 10-overs U20 match was a World Cup game, not a contradiction). Min spell 2 OD / 1 T20; no consecutive overs; drinks-break split merges a bowler's same-end spells BEFORE deciding candidacy (max 2 pieces/bowler); allocator is deterministic — zero `Math.random` anywhere, keep it zero (non-determinism = recommendations flapping between visits).
- **Determinism**: same inputs must always produce the same recommendation (see above).
- **Expensive sims**: `simulateAdaptiveTrainingPlan` re-runs `recommendTraining` per simulated week — any new loop caller passes `{ skipProjection: true }`. `computePlayerCeiling`/`computeOverallRating` results are precomputed once per candidate per render pass and stored on the player object (`_ceilingResult`, `_dynastyCeiling`, `_overallRating`) — read them back, don't re-run.
- **One horizon, one scale**: Dynasty chip, Player Advisor Dynasty line, and Overall Rating all consume `computePlayerCeiling(..., 25)` — the same projection, so they can't disagree. Near-term horizon (to-20 youth / 2yr senior / 1yr 30+) feeds the Training Potential panel and "Projected at 20". Projections ramp academy speed toward Deluxe over `ACADEMY_RAMP_YEARS` (tunable assumption, no game source). Academy speed always from the Academy page DOM parse (24h cache), never hardcoded.
- **Verdict words**: transfer-card verdict derives from `_overallRating.label` (can't contradict the ★ badge); legacy `evaluateTransferTarget` verdict drives only the `isWorthShowing` filter and sort. Peer comparison (`comparePlayerToSquadPeers`) runs for EVERY age vs senior-squad same-role peers.
- **Youth curve is time-aware**: `evaluateYouthDevelopment` marks a below-target trainable stat `behind` only if it can't reach the target before the displayed age increments; reachable = `catching-up`. Weeks-to-close summed across all below-target trainable stats vs weeks left (2+ behind is naturally infeasible). Experience is flat-behind (grows by playing).
- **Scout base**: `AGE_SCOUT_THRESHOLDS` is a hard filter (verbatim user data — don't loosen without new user data). Universal 25k rating floor every age 16-27. `YOUTH_DEV_CURVE` minimums are user-specified (20 = Expert/Expert/Accomplished + Ordinary End/Exp).
- **Talents**: source of truth is `rules.htm?rulespage=playerother` — re-quote before changing talent logic. Prodigy youth-only; Seam/Spin Specialist are BATTING matchup talents (gated to batting primary + opponent's bowling mix); triggered delivery talents are real but unquantified (conservative flat bonuses); mismatched role talents contribute nothing AND warn.
- **Match Data paste box**: only on `teamfixtures.htm` (`pageType === 'matches'`). Deliberately NO on-screen match report — the paste only feeds history for Match Orders/Ground evidence (user explicitly removed the report; don't re-add without being asked).
- **Squad page**: only the grid view (squadViewId=2) has skills; the default summary view scrapes all-zero stats. `init()` skips saving a skill-less scrape and force-refetches. Opponent pages have reduced columns — `fetchSquadFromPage` auto-picks the parser per row.

## Harnesses (in %TEMP%\opencode, run with node; ephemeral — recreate if wiped)
- `spellcoveragetest.js` — MANDATORY after ANY `allocateBowlingSpells` change: all 4 formats × 4 squad sizes assert perfect tiling/caps/per-end parity; the reported bad sheet fails validation. (67 assertions)
- `nabeel_repro.js` — rating/verdict/peer-compare + youth-curve time-aware boundaries + 25k rating floor. (17)
- `matchreviewtest.js` — scorecard parsing (teams/scores/seam-spin split/collapse).
- `v862_agetest.js` (60), `dynastyaudit.js` (31), `rectest.js` (bowling caps/rest/coverage, 5), `squadplantest.js` (9), `buyratingtest.js` (14), `v861_test.js`/`v861_formats.js` (24+24), `v860_labeltest.js` (15).
Pattern: stub `document`/`GM_*`, `vm.runInContext` the IIFE, call pure functions directly, assert. If a harness is missing, recreate it before touching the code it guards.

## Known gotchas (current)
- Youth-match eligibility: prefer the game's own `isYouth === true` flag over derived age at the 20/21 boundary (both agree since the 1-based parse, but the flag wins).
- `scrapePlayerDetailPage` (player.htm) was written without a live HTML sample — self-checks (`hasFullSkills`, 5+ labels) and warns instead of false verdicts. If it misbehaves, ask for raw HTML before guessing selectors.
- No headless/authenticated access to the game — for markup-dependent fixes, ask for a raw HTML snippet, never guess selectors.
- Tampermonkey doesn't hot-reload; a mid-session "still broken" report may be the old version still running (ask them to check the version / reload).
- `@description` must stay short (~200 chars) — a full changelog in metadata is too large for Tampermonkey.

## Known tech debt (diagnosed, deliberately open)
- `FTP_Training 5.2.xlsx` (`G:\My Drive\FTP_Training 5.2.xlsx`): `TRAINING_BASE_RATES` (Refs!I26:Q37), `ACADEMY_SPEED` (DB!AK598:AL608), `TRAINING_TALENT_BONUS` (×1.2) are extracted and verified. NOT extracted: `DB!$DB$6:$GL$15` grid and the multi-week "Player 1/2/3" planner tabs — don't blind-port; validate against the sheet's cached values first.
- Age 30+ active skill DECLINE (workbook-confirmed, rate unknown) is not modeled — long senior projections overstate; flagged in UI.
- Rec-card markup still duplicated across ~4 render sites (training, youth recruit, transfer, opponent scouting) — consolidation needs live-browser verification; don't do it blind.
- Fatigue is not dynamically modeled in multi-week sims (week 1 real, then healthy baseline) — documented in UI, no match schedule to drive it.

## Recent notes (append-only; move into Invariants above once settled)
- v8.92 (2026-08): full-code audit completed — tab-scorecard parsers now escape names at parse (was the one gap: pasted-name innerHTML hole + escaped-vs-raw matching mismatch); `parseOpponentPlayerRow` age via `parseGameAge` (last integer-age scrape). Spells table is the single entry reference (per-end summary cards removed per user); `validateSpellCoverage` banner is the hard gate. Audit verified clean: no dead code, no duplicate decls, zero Math.round(age)//52 sites, self-heal guards intact, role buckets exclusive, dedupe at all lineup entries, variety wired both branches + advisor self-exclusion, tactic scales internally consistent.
- v8.91 (2026-08): spell-plan coverage hard guarantee after a real "Over 20 has not been assigned" rejection (valid plan, mis-transcribed into wrong end slots).
