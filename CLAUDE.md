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
- AI-recommendations scaffold — **exists but unwired, needs a provider/key decision from the user first**: `buildAIContextSnapshot()`, `getAICentralRecommendation()`
- Form/Experience multiplier curves (real game data, from `FTP_Training 5.2.xlsx`'s Form-Exp tab) — **reference only, not wired into scoring yet**: `FORM_MULTIPLIER`, `EXPERIENCE_MULTIPLIER`
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

## Known tech debt (diagnosed, deliberately not fixed)
- Player "rec card" markup (name/age header, verdict badge, stat line, warnings) is duplicated across ~6 render sites (training, sell lists, academy, youth recruit, transfer results, opponent scouting). Consolidating into one shared helper is worth doing but needs live-browser verification across all 6 pages first — don't do it blind in a single pass.
- `FTP_Training 5.2.xlsx` (`G:\My Drive\FTP_Training 5.2.xlsx`) has a "Player 1/2/3" week-by-week training simulator far beyond what's in the script: ~90 columns × 15 weeks × 3 age-blocks per player, driven by per-academy-level quadratic regression curves (`Refs` tab, columns S:Z and similar blocks) *and* a hidden `DB` lookup grid roughly 190 columns × 10 rows of precomputed training-gain values. Porting this faithfully is a real multi-session reverse-engineering project, not a quick add — don't attempt a blind one-pass port; extract and validate against the sheet's own cached values first (`data_only=True`/raw XML `<v>` cells), since wrong training predictions cost the user real in-game weeks.
