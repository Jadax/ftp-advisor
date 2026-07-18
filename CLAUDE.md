# FTP Advisor

Single-file Tampermonkey userscript: `ftp-advisor_user.js` (~5600 lines, one IIFE). Tactical/scouting advisor for fromthepavilion.org (cricket sim), team "Joburg Vikings" (TEAM_ID 1173). No build step, no test suite, no other source files.

## Active Rules
- Keep the script modular; never duplicate a helper — grep for existing functions before adding one.
- No extensive explanatory prose in responses; output code/diffs directly, short summary only.
- Everything lives in `ftp-advisor_user.js` — don't create new files unless explicitly asked.
- Comments: only non-obvious WHY (hidden constraint, workaround, source of a magic number). Never WHAT.
- After any edit, verify with `node --check "ftp-advisor_user.js"` — that's the only available sanity check.
- Don't re-read the whole file to get oriented — grep/Glob the sections below by name.

## Map (grep these, don't re-read the file)
- Lookup tables / constants: top of file — `SKILL_MAP`, `FATIGUE_MAP`, `PITCH_EFFECTS`, `AGE_SCOUT_THRESHOLDS`
- Page routing: `detectPageType()`
- Caching: `_saveCache` / `_loadCacheWithAge` (GM_setValue/GM_getValue), staleness constants at top
- Transfer scouting: `evaluateTransferTarget()`, `calculateRank()`, `checkScoutBenchmark()`
- Tactics: `calculateBattingScore()`, `calculateBowlingScore()`, `recommendLineup()`, `allocateBowlingSpells()`, `recommendTossDecision()`
- Training: `recommendTraining()`, `scrapeTrainingPage()`
- UI: `createPanel()` (shared component lib) + `addCommonStyles()`; each game page has its own `createXUI()` / `updateXAdvisor()` pair

## Known gotchas
- `parseTransferRow()` (transfer search results) sets `wage: 0` and `experience: 0` — real values only arrive after a per-player page fetch. Never hard-filter on these without gating on `> 0` first, or every player fails and the results list goes empty.
- `AGE_SCOUT_THRESHOLDS` ("the base") is a **hard filter** in `evaluateTransferTarget`, not a scoring bonus. Values are taken verbatim from the user's saved Talent Scout search screenshots — treat them as source of truth, don't infer/interpolate/loosen without new screenshot data.
