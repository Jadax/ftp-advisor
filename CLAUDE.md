# FTP Advisor

Single-file Tampermonkey userscript: `ftp-advisor_user.js` (~6100 lines, one IIFE). Tactical/scouting advisor for fromthepavilion.org (cricket sim). Team is auto-detected per install (`getTeamId()`) — not hardcoded to any one team/user. No build step, no test suite, no other source files. Public repo: github.com/Jadax/ftp-advisor.

## Active Rules
- Keep the script modular; never duplicate a helper — grep for existing functions before adding one.
- No extensive explanatory prose in responses; output code/diffs directly, short summary only.
- Everything lives in `ftp-advisor_user.js` — don't create new files unless explicitly asked.
- Comments: only non-obvious WHY (hidden constraint, workaround, source of a magic number). Never WHAT.
- After any edit, verify with `node --check "ftp-advisor_user.js"` — the only available sanity check (no test suite, no build step, no headless access to the live game).
- Don't re-read the whole file to get oriented — grep/Glob the sections below by name.

## Ship workflow
Public repo, installed by other people. After a change is verified:
1. Bump `@version` in the metadata block (top of file).
2. `git add -A && git commit -m "vX.Y: <what changed and why>"`.
3. `git push` (origin already configured).
Do this for every shipped change unless told otherwise — there's no separate release process.

## Map (grep these, don't re-read the file)
- Lookup tables / constants: top of file — `SKILL_MAP`, `FATIGUE_MAP`, `PITCH_EFFECTS`, `AGE_SCOUT_THRESHOLDS`
- Team config (auto-detected): `getTeamId()`, `detectMyTeamIdFromPage()`
- Pro-tier scaffold — **exists but unwired, gates no feature**: `isProUser()`, `validateLicense()`
- AI-recommendations scaffold — **exists but unwired**: `buildAIContextSnapshot()`, `getAICentralRecommendation()`, `promptForAIKey()`. Key-storage approach is decided (user's own key, one-time prompt); `AI_ENDPOINT_URL` provider/endpoint is still a placeholder — needs that decision before wiring a UI trigger.
- Form/Experience multiplier curves (real game data, from `FTP_Training 5.2.xlsx`'s Form-Exp tab) — **reference only, not wired into scoring yet**: `FORM_MULTIPLIER`, `EXPERIENCE_MULTIPLIER`
- Training weekly-gain estimate (real data from the same workbook's "Base Level Training" table, combined with the pre-existing `ACADEMY_SPEED`/age/talent/slowdown multipliers) — **live**, shown as "~Nwk to next level" + a "📅 12wk outlook" line on Training page recs: `TRAINING_BASE_RATES`, `estimateWeeklyTrainingGain()`, `weeksToNextLevel()`, `simulateTrainingPlan()` (single fixed program, age now advances week-by-week — fixed in v8.3, was frozen at the start age before), `formatTrainingOutlook()`. Does NOT read the workbook's own precomputed `DB!$DB$6:$GL$15` grid, so treat its output as a formula-based estimate consistent with the rest of the script, not a byte-identical reproduction of the spreadsheet.
- Adaptive multi-week training plan (`simulateAdaptiveTrainingPlan()`, v8.3) — re-runs `recommendTraining()`'s real staged logic fresh every simulated week (fielding first, then primary, etc — same decision engine the Training page uses, not a duplicate), so the program actually changes over time instead of being locked in. Shown on the Player Advisor as "Development plan to age 20" with a program timeline + final skill table. Fatigue is NOT dynamically modeled (week 1 uses real fatigue, week 2+ assumes a healthy baseline of 8) — documented in the UI, not a bug.
- Player Detail Advisor (`player.htm` — keep/release verdict for any single player, squad-peer comparison for 21+, adaptive training plan + single-program ceiling grid for youth) — **unverified against live markup, see gotcha**: `scrapePlayerDetailPage()`, `comparePlayerToSquadPeers()`, `buildTrainingPotentialGrid()`, `simulateAdaptiveTrainingPlan()`, `updatePlayerAdvisor()`
- Page routing: `detectPageType()`
- Caching: `_saveCache` / `_loadCacheWithAge` (GM_setValue/GM_getValue), staleness constants at top
- Squad parsing: `parsePlayerRow()` (own squad, full skill grid) vs `parseOpponentPlayerRow()` (opponent squad, reduced columns — see gotcha)
- Transfer scouting: `evaluateTransferTarget()`, `calculateRank()`, `checkScoutBenchmark()`
- Tactics: `calculateBattingScore()`, `calculateBowlingScore()`, `recommendLineup()`, `allocateBowlingSpells()`, `recommendTossDecision()`
- Training: `recommendTraining()`, `scrapeTrainingPage()`
- UI: `createPanel()` (shared component lib) + `addCommonStyles()`; each game page has its own `createXUI()` / `updateXAdvisor()` pair

## Known gotchas
- `parseTransferRow()` (transfer search results) sets `wage: 0` and `experience: 0` — real values only arrive after a per-player page fetch. Never hard-filter on these without gating on `> 0` first, or every player fails and the results list goes empty.
- `AGE_SCOUT_THRESHOLDS` ("the base") is a **hard filter** in `evaluateTransferTarget`, not a scoring bonus. Values are taken verbatim from the user's saved Talent Scout search screenshots — treat them as source of truth, don't infer/interpolate/loosen without new screenshot data.
- Opponent squad pages (`seniors.htm`/`youths.htm?teamId=<other team>`) expose a genuinely different, reduced column set than your own squad page: Age/BT/Experience/Fatigue/Form/Wage/Rating only — no batting/bowling/technique/power/keeping/fielding/captaincy. This is the game's own scouting limitation, not a scraping bug. `fetchSquadFromPage()` auto-picks `parsePlayerRow` vs `parseOpponentPlayerRow` per row via `td.skills` count — don't reuse the own-squad column mapping for opponent data.
- No headless/authenticated access to fromthepavilion.org — if a fix depends on real page markup, ask the user for a raw HTML snippet rather than guessing selectors.
- `scrapePlayerDetailPage()` (player.htm) was written by extending `fetchPlayerPageDetails()`'s already-proven th/td label scan to the rest of the skill grid, **without** a live HTML sample of player.htm itself to confirm against — lower confidence than everything else in this file. It self-checks (`hasFullSkills`, needs 5+ matched skill labels) and shows a warning instead of a false verdict if scraping comes back empty. The user shared a screenshot in v8.1 confirming the visible field *labels* (Batting/Bowling/.../Fatigue/Form/Experience/Captaincy, all "Label: Value" rows matching what the code expects) — real corroboration, but a screenshot proves rendered output, not actual DOM/selectors. If the user reports it's not working, ask for the page's raw HTML before guessing at new selectors.

## Known tech debt (diagnosed, deliberately not fixed)
- Player "rec card" markup (name/age header, verdict badge, stat line, warnings) is duplicated across ~6 render sites (training, sell lists, academy, youth recruit, transfer results, opponent scouting). Consolidating into one shared helper is worth doing but needs live-browser verification across all 6 pages first — don't do it blind in a single pass.
- `FTP_Training 5.2.xlsx` (`G:\My Drive\FTP_Training 5.2.xlsx`) has a "Player 1/2/3" week-by-week training *simulator* far beyond what's in the script: ~90 columns × 15 weeks × 3 age-blocks per player. Its `DB` tab (725 rows, not the ~thousands originally feared) is the source of truth and has now yielded three verified, shipped constants — don't re-derive: `TRAINING_BASE_RATES` (`Refs!I26:Q37`, minimal-academy baseline), `ACADEMY_SPEED` (`DB!AK598:AL608`, keyed by exact academy name — corrected from a wrong wiki-sourced guess in v7.7), `TRAINING_TALENT_BONUS` (315 consistent `×1.2` occurrences across every Prodigy/Gifted formula in `DB` — corrected from a mis-cited 0.15 in v7.8, see its own code comment). The age-decay curve was cross-checked too and matches the pre-existing `AGE_TRAINING_MULTIPLIER` exactly (no change needed). What's NOT yet done: `DB!$DB$6:$GL$15`, a second ~190-column grid the Player-tab formulas pull from directly (likely a precomputed cache of the same underlying values across every age/week combination, not new source data — unconfirmed), and the full multi-week/multi-year forward-planner UI the "Player 1/2/3" tabs actually are. Don't attempt a blind port of the rest — validate against the sheet's own cached values first (`data_only=True`/raw XML `<v>` cells), since wrong training predictions cost the user real in-game weeks.
