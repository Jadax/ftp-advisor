// ==UserScript==
// @name         FTP Advisor
// @namespace    http://tampermonkey.net/
// @version      8.90
// @description  Tactical/scouting advisor for fromthepavilion.org (cricket sim): team, tactics, pitch, training, transfer market, youth and squad plan advice with projections. Full changelog: github.com/Jadax/ftp-advisor
// @author       Tushant Sharma
// @license      MIT
// @match        https://www.fromthepavilion.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      www.fromthepavilion.org
// @updateURL    https://raw.githubusercontent.com/Jadax/ftp-advisor/main/ftp-advisor_user.js
// @downloadURL  https://raw.githubusercontent.com/Jadax/ftp-advisor/main/ftp-advisor_user.js
// @supportURL   https://github.com/Jadax/ftp-advisor/issues
// ==/UserScript==
// v8.90 release: prevent duplicate players in XI and batting-order recommendations.

(function() {
    'use strict';

    // ============================================================
    // FILE MAP — find a concern, jump straight to it.
    // Every name below is grep-able; the `// ===== ...` banner above
    // each block marks its section. Read this instead of the whole file.
    //   AGE MODEL & PARSING:      parseGameAge, formatAgeDisplay, ageYears,
    //       ageFraction, isYouthAge, interpAgeTableValue, interpAgeSteps
    //   PLAYER RATINGS:           computePlayerValueSkillSum,
    //       computePlayerValuePerK, computeSpareRating, computeOverallRating,
    //       computePlayerCeiling, weeksToAge20, weeksToAge, classifyProjectedPrimary
    //   MARKET PRICING:           loadPriceHistory, recordPlayerPrice,
    //       anchorPriceForPlayer, computeFairPrice, fairPriceLine
    //   CACHE & PAGE ROUTING:     _saveCache/_loadCacheWithAge,
    //       savePlayerCache/loadPlayerCache, isStale, detectPageType,
    //       fetchAllData, _loadCacheRaw
    //   SQUAD PARSING:            parsePlayerRow, parseOpponentPlayerRow,
    //       parseSummaryViewBlock, scrapeSummaryView, fetchSquadSummaryView,
    //       mergeTalentsIntoPlayers
    //   TRANSFER SCOUTING:        AGE_SCOUT_THRESHOLDS, checkScoutBenchmark,
    //       evaluateTransferTarget, calculateRank, assessSquadVariety,
    //       _mapTransferHeader, parseTransferRow, fetchPlayerPageDetails,
    //       scrapeTransferResults
    //   YOUTH DEVELOPMENT:        YOUTH_DEV_CURVE, evaluateYouthDevelopment,
    //       evaluateYouthRecruit, projectYouthToAge20
    //   TRAINING:                 AGE_TRAINING_MULTIPLIER,
    //       getAgeTrainingMultiplier, estimateWeeklyTrainingGain,
    //       recommendTraining, _recommendYouthTraining,
    //       _recommendSeniorTraining, _recommendAgingTraining,
    //       simulateTrainingPlan, simulateAdaptiveTrainingPlan,
    //       academySpeedAtWeek, scrapeTrainingPage, weeksToNextLevel
    //   TACTICS:                  calculateBattingScore, calculateBowlingScore,
    //       recommendLineup, recommendBattingOrder, allocateBowlingSpells
    //       (fixAdjacency/numberAndTactics/partitionSideSpells),
    //       recommendTossDecision, analyzeOpposition
    //   GROUND / ACADEMY:         recommendPitchForSquad, recommendCapacity,
    //       recommendAcademyAction, scrapeAcademyPage, parseAcademyDoc
    //   SQUAD PLAN & SELLS:       buildSquadPlan, buildSeniorSellRanking,
    //       buildYouthSellRanking, computeRoleSurplus,
    //       seniorTalentProtection, youthTalentProtection, computeSquadStats
    //   OPPONENT SCOUTING:        getOpponentTeamId,
    //       extractOpponentTeamIdFromGame, fetchOpponentSquad,
    //       scrapeOpponentSquad, fetchUpcomingFixtures
    //   MATCH DATA / SCOUTING FEED (v8.72, v8.75): parseMatchScorecard,
    //       parseMatchChunk, parseScorecardFromHTMLDoc, createMatchPasteUI,
    //       saveMatchesToHistory, loadMatchHistory, getPlayerHistoryStats,
    //       getTeamHistoryStats, getPitchHistoryStats, buildPastedScoutingHtml
    //   PLAYER ADVISOR:           scrapePlayerDetailPage, updatePlayerAdvisor,
    //       comparePlayerToSquadPeers
    //   PER-PAGE UI:              updateSquadAdvisor, updateOrdersAdvisor,
    //       updateTrainingAdvisor, updateTransferAdvisor, updateGroundAdvisor,
    //       updateAcademyAdvisor, updateYouthRecruitAdvisor,
    //       updateClubStatusUI, updateMatchesAdvisor
    //   SHARED UI LIB:            createPanel, addCommonStyles, makeDraggable,
    //       computeConfidence, renderConfidenceBadge, escapeHtml
    // ============================================================

    // Debug logging off by default (public userscript). Enable: localStorage.ftpDebug = '1'
    const FTP_DEBUG = (() => {
        try { return localStorage.getItem('ftpDebug') === '1'; } catch (e) { return false; }
    })();
    function debugLog(...args) { if (FTP_DEBUG) console.log(...args); }

    // ============================================================
    // TEAM CONFIGURATION
    // Previously hardcoded to one team (1173) — that made the script
    // unusable by anyone else. Now auto-detected from the page on
    // first run and cached locally, with a one-time manual prompt as
    // fallback. This single change is what turns this from "my personal
    // script" into something distributable to other players at all.
    // ============================================================
    const TEAM_ID_CACHE_KEY = 'ftp_config_team_id';

    // Best-effort: look for a persistent "My Club"-style nav link that
    // points at the logged-in user's own team regardless of which
    // team's page is currently being viewed. Selectors are a best
    // guess at FTP's nav markup — verify against the live site and
    // adjust if detection isn't firing reliably.
    function detectMyTeamIdFromPage() {
        const selectors = [
            'a[href*="club.htm?teamId="]',
            'a[href*="seniors.htm?teamId="]',
            'a[href*="finances.htm?teamId="]'
        ];
        for (const sel of selectors) {
            const link = document.querySelector(sel);
            if (link) {
                const match = link.href.match(/teamId=(\d+)/);
                if (match) return match[1];
            }
        }
        return null;
    }

    function getTeamId() {
        const cached = GM_getValue(TEAM_ID_CACHE_KEY, null);
        if (cached) return cached;

        let id = detectMyTeamIdFromPage();
        if (!id) {
            const entered = prompt('FTP Advisor: enter your From the Pavilion Team ID (found in your team\'s URL, e.g. seniors.htm?teamId=1234):');
            id = entered && /^\d+$/.test(entered.trim()) ? entered.trim() : null;
        }
        if (id) {
            GM_setValue(TEAM_ID_CACHE_KEY, id);
            return id;
        }
        console.warn('[FTP Advisor] Could not determine Team ID — squad/finance/academy data will not load correctly until this is set.');
        return null;
    }

    const TEAM_ID = getTeamId();

    // Cache keys
    const CACHE_KEY = 'ftp_squad_cache';
    const CACHE_TIMESTAMP_KEY = 'ftp_squad_cache_ts';
    const OPPONENT_CACHE_PREFIX = 'ftp_opponent_';
    const OPPONENT_TIMESTAMP_PREFIX = 'ftp_opponent_ts_';
    const ACADEMY_CACHE_KEY = 'ftp_academy_cache';
    const ACADEMY_TIMESTAMP_KEY = 'ftp_academy_cache_ts';
    const FINANCE_CACHE_KEY = 'ftp_finance_cache';
    const FINANCE_TIMESTAMP_KEY = 'ftp_finance_cache_ts';
    const GROUND_CACHE_KEY = 'ftp_ground_cache';
    const GROUND_TIMESTAMP_KEY = 'ftp_ground_cache_ts';

    // Local transfer price-history ledger (the closest userscript-friendly
    // analog to PavilionPy's persistent market archive). Every candidate we
    // see on the transfer market is recorded by (role, age-band, primary
    // skill), so future searches can anchor a candidate's asking price against
    // "similar archetypes this club has actually seen listed for". Kept small
    // and pruned — this is a rough value anchor, not a full market database.
    const TRANSFER_PRICE_KEY = 'ftp_transfer_price_history';
    const TRANSFER_PRICE_MAX = 400; // cap stored entries to bound GM storage

    // Pasted-match history — every match run through the Match Review paste
    // box is kept (parsed scorecard only, no HTML) so the tactics/ground
    // advisors can look up real evidence for named players/teams later,
    // not just produce a one-off review. Small (a scorecard is a few KB),
    // capped to bound GM storage growth.
    const MATCH_HISTORY_KEY = 'ftp_match_history';
    const MATCH_HISTORY_MAX = 150;

    // Staleness thresholds (hours)
    const STALE_SQUAD_HOURS = 24;
    const STALE_OPPONENT_HOURS = 24;
    const STALE_ACADEMY_HOURS = 24; // was 7 days — academy changes are rare, but the user explicitly wants an upgrade to propagate to every squad/market projection within a day even without re-visiting the Academy page (the Academy page itself always re-scrapes on visit regardless)
    const STALE_FINANCE_HOURS = 24;
    const STALE_GROUND_HOURS = 24;
    const STALE_TEAM_INFO_HOURS = 24;

    // ============================================================
    // SKILL MAPPINGS (from FTP skill abbreviations)
    // ============================================================
    const SKILL_MAP = {
        'legendary': 15, 'legen': 15,
        'elite': 14,
        'world class': 13, 'wclas': 13,
        'exceptional': 12, 'excep': 12,
        'spectacular': 11, 'spect': 11,
        'outstanding': 10, 'outs': 10,
        'expert': 9, 'exprt': 9,
        'accomplished': 8, 'accom': 8,
        'reliable': 7, 'reli': 7,
        'capable': 6, 'capab': 6,
        'reasonable': 5, 'reas': 5,
        'average': 4, 'avg': 4,
        'ordinary': 3, 'ordin': 3,
        'poor': 2,
        'dreadful': 1, 'dread': 1,
        'atrocious': 0, 'atroc': 0
    };

    const FATIGUE_MAP = {
        'rested': 10, 'rest': 10,
        'revived': 9, 'reviv': 9,
        'energetic': 8, 'ener': 8,
        'passable': 7, 'pass': 7,
        'satisfactory': 6, 'satis': 6,
        'moderate': 5, 'moder': 5,
        'weary': 4,
        'listless': 3, 'list': 3,
        'exhausted': 2, 'exhau': 2,
        'shattered': 1, 'shtrd': 1,
        'clinically dead': 0, 'clin': 0
    };

    const SKILL_LABELS = {
        15: 'Legendary', 14: 'Elite', 13: 'World Class', 12: 'Exceptional',
        11: 'Spectacular', 10: 'Outstanding', 9: 'Expert', 8: 'Accomplished',
        7: 'Reliable', 6: 'Capable', 5: 'Reasonable', 4: 'Average',
        3: 'Ordinary', 2: 'Poor', 1: 'Dreadful', 0: 'Atrocious'
    };

    // ============================================================
    // AGE PARSING — "YY.WW" table cells and "YYyWWw" panel text
    // The game shows age as years + a week count (14 weeks/age-year per
    // the official manual — see simulateAdaptiveTrainingPlan's own comment
    // for the source), NOT a base-10 decimal fraction. CRITICAL: the week
    // is 1-based WITHIN the age-year (v8.64, per the user) — "21y14w" is
    // the 14th (final) week of being 21, and the player only becomes 22
    // when the display rolls past it to "22y1w". So the week contributes
    // (week-1)/14, never 14/14 = 1.0: a "20.14" player reads 20.93 (still
    // 20, still a youth — they have NOT turned 21), and floor(parsed) ==
    // the displayed year for EVERY display. The old weeks/14 formula made
    // every boundary-week display read as the NEXT year (20.14 -> 21.0),
    // which pushed youth onto the senior scout base / senior training /
    // senior sell analysis a full week early and DISAGREED with the
    // training sim (simulateTrainingPlan has always advanced age by
    // (week-1)/14 per simulated week, so the parser and the sim were
    // two different conventions for the same week). parseGameAge() is the
    // single correct parser for both formats; every age scrape in the file
    // should go through it instead of parseFloat/parseInt on raw cell text.
    function parseGameAge(text) {
        if (!text) return 0;
        let m = text.match(/(\d{1,2})\s*y(?:ears?)?\s*(\d{1,2})\s*w(?:eeks?)?/i);
        if (m) return parseInt(m[1], 10) + (Math.max(1, Math.min(14, parseInt(m[2], 10))) - 1) / 14;
        m = text.match(/^\s*(\d{1,2})\.(\d{1,2})\s*$/);
        if (m) return parseInt(m[1], 10) + (Math.max(1, Math.min(14, parseInt(m[2], 10))) - 1) / 14;
        m = text.match(/(\d{1,2})/);
        return m ? parseInt(m[1], 10) : 0;
    }

    // Inverse of parseGameAge's decimal, for display — raw decimal ages
    // (e.g. 16.357142857142858) were leaking straight into the UI as
    // "16.357142857142858yo" wherever a template literal interpolated
    // player.age directly. Reconstructs the game's own "Yy Ww" format
    // instead of an ugly float. The +1 week reverses the (week-1)/14 in
    // parseGameAge so a boundary player round-trips exactly: parseGameAge
    // ("21y14w") = 21.93 -> "21y14w" (not "21y13w"), and the first week of
    // any age is "Xy1w" (there is no "Xy0w" in the game's display).
    function formatAgeDisplay(age) {
        if (age == null || isNaN(age)) return '';
        const years = Math.floor(age);
        const weeks = Math.min(14, Math.round((age - years) * 14) + 1);
        return weeks > 0 ? `${years}y${weeks}w` : `${years}`;
    }

    // ============================================================
    // AGE MODEL — how "years + weeks" is read everywhere.
    // The game tracks age as years + a week out of 14 (parseGameAge
    // above — 1-based since v8.64, so floor(age) ALWAYS equals the year
    // the game displays; there is no "20.14 reads 21.0" boundary artifact
    // anymore). The decision now lives here ONCE (v8.62) so callers stop
    // re-deriving Math.round/Math.floor and drifting apart:
    //   * ageYears(age)      — the year the player is CURRENTLY in
    //     (floor). For per-year TABLE lookups and "age N" labels:
    //     AGE_SCOUT_THRESHOLDS, YOUTH_DEV_CURVE, SENIOR_MINS_*. A player
    //     does not become 17 at 16y14w — they are still 16 until the
    //     display rolls to 17y1w, exactly as the game shows them.
    //   * ageFraction(age)   — 0..13/14 progress through that year
    //     (completed weeks/14 = age-floor(age)), for CONTINUOUS values
    //     that should ramp smoothly (training speed, rating/rank age
    //     scores) rather than step. Week 1 = 0, the final week = 13/14.
    //   * isYouthAge(age)    — the 20/21 senior-squad boundary, read
    //     continuously (a 20y14w player is 20.93 and has not turned 21).
    // ============================================================
    function ageYears(age) { return Math.floor(age || 0); }
    function ageFraction(age) { const a = age || 0; return a - Math.floor(a); }
    function isYouthAge(age) { return (age || 0) < 21; }

    // Linear interpolation of one numeric field of a per-year table
    // between the current year's row and the next year's (weeks-progress
    // through the year). Returns null when the current year has no row
    // (caller decides the fallback); the top year clamps to its own row.
    // Rows are keyed by integer year (e.g. AGE_TRAINING_MULTIPLIER).
    function interpAgeTableValue(table, age, field) {
        const y = ageYears(age);
        const lo = table[y];
        if (lo == null || lo[field] == null) return null;
        const hi = table[y + 1];
        if (hi == null || hi[field] == null) return lo[field];
        return lo[field] + (hi[field] - lo[field]) * ageFraction(age);
    }

    // Piecewise-linear score across age breakpoints [[year, value], ...].
    // The values ARE the old per-integer-year scores (kept identical, so
    // a player exactly on a year boundary scores exactly as before); the
    // difference is the score now ramps smoothly across the 14-week year
    // instead of stepping at the half-year. Clamps outside the range.
    function interpAgeSteps(age, steps) {
        const a = age || 0;
        if (a <= steps[0][0]) return steps[0][1];
        for (let i = 0; i < steps.length - 1; i++) {
            if (a < steps[i + 1][0]) {
                const [y0, v0] = steps[i], [y1, v1] = steps[i + 1];
                return v0 + (v1 - v0) * ((a - y0) / (y1 - y0));
            }
        }
        return steps[steps.length - 1][1];
    }

    // Which discipline (batting/bowling/keeping) is this player's actual
    // primary skill. Transfer scouting (checkScoutBenchmark,
    // evaluateTransferTarget, calculateRank) used to hardcode
    // primary = max(batting, bowling) everywhere, which silently judged
    // wicketkeeper prospects on their bat/bowl numbers and never looked at
    // keeping at all — a specialist keeper with strong keeping but modest
    // batting/bowling failed every age/senior minimum check and got
    // filtered out regardless of how good a keeper they actually were.
    // Threshold/ordering matches the keeper detection already used for
    // youth training (getYouthPrimarySkillName) and tactics
    // (_detectPlayerContext) — keeping only counts as primary once it's
    // at least Average(4) and actually their best discipline.
    // Player rows should carry a stable numeric ID, but use a name/age
    // fallback for partially scraped rows so no recommendation can render
    // the same player twice when an ID is temporarily missing.
    function getPlayerIdentity(player) {
        if (!player) return null;
        if (player.id !== undefined && player.id !== null && String(player.id) !== '') {
            return 'id:' + player.id;
        }
        const name = String(player.name || '').trim().toLowerCase();
        return name ? 'name:' + name + '|age:' + (player.age ?? '') : null;
    }

    function dedupePlayers(players) {
        const seen = new Set();
        return (players || []).filter(player => {
            const identity = getPlayerIdentity(player);
            if (identity === null) return true;
            if (seen.has(identity)) return false;
            seen.add(identity);
            return true;
        });
    }
    function getPrimarySkillInfo(player) {
        const keeping = player.keeping || 0, batting = player.batting || 0, bowling = player.bowling || 0;
        if (keeping >= 4 && keeping >= batting && keeping >= bowling) return { value: keeping, name: 'keeping' };
        // Both batting AND bowling reading exactly 0 means no skill data
        // has actually loaded for this player (a scrape gap or stale
        // cache entry) — not a genuine 0/0 allrounder. The tie-break
        // below (bowling >= batting -> bowling) used to silently
        // misclassify every such player as a bowler, which could make
        // role-group logic (comparePlayerToSquadPeers, computeRoleSurplus)
        // report "no batters in the squad" when real batters exist but
        // just haven't loaded their skills into this player object yet.
        if (batting === 0 && bowling === 0) return { value: 0, name: 'batting' };
        if (bowling >= batting) return { value: bowling, name: 'bowling' };
        return { value: batting, name: 'batting' };
    }

    // Wicketkeepers need to be a competent batsman too — not a bowler,
    // and not held to the same bar as keeping (their actual primary
    // skill) or a specialist batsman's bar, but a real secondary
    // requirement rather than ignored entirely. Roughly two skill tiers
    // below the primary/keeping requirement, floored at 0. Shared so
    // every hard filter that checks a keeper candidate (checkScoutBenchmark,
    // evaluateTransferTarget's senior branch, evaluateYouthDevelopment's
    // youth curve) applies the same secondary-batting bar instead of
    // three independently-drifting definitions of "good enough".
    function keeperBattingMin(primaryMin) {
        return Math.max(0, (primaryMin || 0) - 2);
    }

    /**
     * Whether a talent actually pays off for THIS player, given their
     * real role. User's own framing, and it's correct: a batsman with a
     * bowling talent is not the same as that batsman with a batting
     * talent — it rarely triggers, since he's picked and used for his
     * batting. A mismatched role-specific talent should count for
     * nothing, same as not having a talent at all — not a penalty, just
     * no bonus. Generic talents (captaincy, fatigue recovery, fielding,
     * broad training speed, Prodigy) always count regardless of role.
     *
     * Batting-relevant talents also apply to keepers — they have a real
     * secondary batting duty (see keeperBattingMin's reasoning), so
     * Opener/Skilled(Batting)/etc. genuinely help a keeper when he bats,
     * unlike a specialist bowler who rarely does.
     *
     * Talents already gated individually elsewhere for a manual-
     * confirmed reason (Seam/Spin Specialist — a BATTING matchup talent
     * per the manual, gated to batting-primary in evaluateTransferTarget
     * and calculateBattingScore) are left out of these two regexes on
     * purpose so their existing, separately-reasoned gate isn't doubled
     * up or overridden here.
     */
    const BATTING_RELEVANT_TALENTS = /skilled \(batting\)|skilled \(power\)|gifted \(batting\)|gifted \(power\)|^opener$|finisher|accumulator|boundary hitter/i;
    const BOWLING_RELEVANT_TALENTS = /skilled \(bowling\)|gifted \(bowling\)|new ball bowler|old ball bowler|wrongun|flipper|swing|bouncer|yorker|slower ball|arm ball|doosra/i;
    function isTalentRoleAligned(talentText, primaryName) {
        if (BATTING_RELEVANT_TALENTS.test(talentText)) return primaryName === 'batting' || primaryName === 'keeping';
        if (BOWLING_RELEVANT_TALENTS.test(talentText)) return primaryName === 'bowling';
        return true; // generic, or handled by its own dedicated gate elsewhere
    }
    // Talent count for scoring contexts that just need "how many talents
    // actually matter here" (calculateRank, computePlayerValueSkillSum) —
    // a mismatched role-specific talent doesn't count, matching the
    // reasoning above.
    function countAlignedTalents(player) {
        const primaryName = getPrimarySkillInfo(player).name;
        return (player.talents || []).filter(t => isTalentRoleAligned(t, primaryName)).length;
    }

    /**
     * Role-aware, talent-aware "value" skill total for a wage-adjusted
     * skill/$K metric. Replaces a previous version that summed
     * batting+bowling+technique+fielding+endurance for EVERY player
     * regardless of role — which diluted specialists (a pure batter's
     * near-zero bowling dragged their score down same as it would an
     * allrounder's) and, worse, never looked at keeping at all: a
     * wicketkeeper's actual value driver was completely invisible to it.
     *
     * - Primary skill (batting/bowling/keeping, via getPrimarySkillInfo)
     *   counted double — it's the actual reason this player is picked
     *   and paid; everything else is supporting.
     * - Technique/fielding/endurance/experience count once each — real
     *   supporting contributors for every role. Experience was added in
     *   v8.63 per the user's explicit weight list (primary, technique,
     *   fielding, endurance, experience); power is deliberately NOT in
     *   the sum — the same user list omitted it, and it's batting-oriented
     *   (stroke power) while this number is a universal comparator.
     * - Keepers ALSO get half credit for batting (they need to be a
     *   competent batsman too, not a specialist one — see
     *   keeperBattingMin()'s reasoning from the transfer-scouting work).
     * - Talents add a conservative flat bonus — same unquantified-but-
     *   real convention already used in evaluateTransferTarget/
     *   calculateBattingScore/calculateBowlingScore, not invented fresh
     *   here. Prodigy is youth-only per the manual.
     * - Age is deliberately NOT baked into the number — there's no
     *   manual-confirmed decline rate to apply (see the age-30+ know-gap
     *   note elsewhere in this file), so a fabricated age multiplier
     *   would just be a guess wearing a precise-looking number. Age
     *   context is shown alongside the value instead, left for the user
     *   to weigh — an efficient 33-year-old and an efficient 19-year-old
     *   are not the same signing/keep decision, but that's a judgement
     *   call, not something to silently bake into the math.
     */
    function computePlayerValueSkillSum(player) {
        const primaryInfo = getPrimarySkillInfo(player);
        let sum = primaryInfo.value * 2;
        sum += player.technique || 0;
        sum += player.fielding || 0;
        sum += player.endurance || 0;
        sum += player.experience || 0;
        if (primaryInfo.name === 'keeping') sum += (player.batting || 0) * 0.5;

        // Role-aligned only — a mismatched role-specific talent (e.g.
        // "Skilled (Bowling)" on a specialist batsman) is worth the same
        // as no talent at all here, same reasoning as calculateRank's
        // talent score. See isTalentRoleAligned().
        const talents = player.talents || [];
        const isYouth = (player.age || 0) < 21;
        const aligned = (re) => talents.some(t => re.test(t) && isTalentRoleAligned(t, primaryInfo.name));
        if (talents.some(t => /prodigy/i.test(t)) && isYouth) sum += 3; // generic — all skills
        if (aligned(/skilled/i)) sum += 2;
        if (aligned(/gifted/i) && isYouth) sum += 1;
        if (aligned(/new ball bowler|old ball bowler|^opener$|finisher/i)) sum += 1;
        if (talents.some(t => /safe hands|natural leader/i.test(t))) sum += 1; // generic — captaincy/fielding

        return sum;
    }

    // Returns null (not 0) when wage is unknown, so callers can tell
    // "no data" apart from "genuinely free" and skip display accordingly.
    function computePlayerValuePerK(player) {
        if (!player || !player.wage || player.wage <= 0) return null;
        // The game displays the DISCOUNTED wage (loyalty discount:
        // career youth-start 5% + 0.5%/season, capped at +5%). Undoing it
        // gives the real wage so value/$K compares a discounted long-tenure
        // player fairly against a fresh signing who pays full wage. Falls
        // back to the displayed wage when no discount was scraped.
        const disc = (player.wageDiscount != null && player.wageDiscount > 0) ? player.wageDiscount : 0;
        const realWage = disc >= 100 ? player.wage : player.wage / (1 - disc / 100);
        return computePlayerValueSkillSum(player) / (realWage / 1000);
    }

    // "Spare rating" / hidden-value estimate (idea lifted from PavilionPy's
    // SpareSkills tracking). The game shows each skill as a whole level,
    // but every level holds ~1000 hidden sub-levels, and the player's
    // displayed Rating is derived from the FULL underlying skills — so two
    // players with identical visible skill words can differ in Rating by
    // hundreds/thousands of points. The rating not explained by the visible
    // skill levels points at hidden sub-level progress, i.e. a player "about
    // to pop" a level who's genuinely better (or worse) than their on-paper
    // skills suggest.
    //
    // The exact per-level Rating weight is NOT manually confirmed, so this
    // uses PavilionPy's community-model approximation (1000 × level, with
    // atrocious=0 → 500) adapted to our 14-visible-level skill scale, then
    // reports the residual as a fraction of the visible level contribution.
    // It's a directional gauge (positive = hidden value, negative = flattered
    // by visible skills), not an official formula — surfaced as an estimate.
    function computeSpareRating(player) {
        if (!player || !player.rating || player.rating <= 0) return null;
        const skillKeys = ['batting', 'bowling', 'technique', 'power', 'keeping', 'fielding', 'endurance'];
        let visibleWeight = 0;
        let skillSum = 0;
        skillKeys.forEach(k => {
            const lvl = player[k] || 0;
            // level 0 (atrocious) is minimum baseline, levels 1-15 scale ~linearly
            const weight = lvl <= 0 ? 500 : 500 + (lvl - 1) * 1000;
            visibleWeight += weight;
            skillSum += lvl;
        });
        if (visibleWeight <= 0) return null;
        const spare = player.rating - visibleWeight;
        // Express as fraction of the visible contribution + a rounded $ of rating
        return {
            spare,
            ratio: spare / visibleWeight,
            visibleWeight,
            skillSum,
            // Direction + intensity label for display
            label: spare > visibleWeight * 0.03 ? 'hidden-potential' :
                   spare < -visibleWeight * 0.03 ? 'flattered' : 'match'
        };
    }

    function spareRatingBadge(spare) {
        if (!spare) return '';
        if (spare.label === 'hidden-potential') {
            return `<span class="ftp-stat-badge green" title="Rating exceeds what this player's visible skills alone predict — likely hidden sub-level progress (about to pop a skill) or strong underlying quality. Estimate, not official." style="font-size:9px;cursor:help;">\u2B06 Hidden potential (+${Math.abs(spare.spare).toLocaleString()})</span>`;
        } else if (spare.label === 'flattered') {
            return `<span class="ftp-stat-badge amber" title="Rating is below what this player's visible skills alone predict — may be flattered by their stat line." style="font-size:9px;cursor:help;">\u2B07 Flattered</span>`;
        }
        return `<span class="ftp-stat-badge neutral" title="Rating broadly matches visible skills." style="font-size:9px;cursor:help;">\u27A1 Fair value</span>`;
    }

    // ── Transfer price-history ledger (local comparable-pricing anchor) ──
    // Records every transfer candidate seen, keyed by (role, age-band,
    // primary skill), so subsequent searches can say "players like this are
    // typically listed around $X and have sold here before." Records persist
    // in GM storage between sessions — a lightweight stand-in for a server
    // market archive. Entries are cheap {t, primary, isYouth, age, sum, role,
    // price} and capped at TRANSFER_PRICE_MAX (age/sum added v8.57 so fair
    // prices can be age-banded and quality-scaled).
    function loadPriceHistory() {
        try {
            const raw = GM_getValue(TRANSFER_PRICE_KEY, null);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function recordPlayerPrice(player) {
        if (!player) return;
        const price = player.price || 0;
        if (price <= 0 && !(player.wage > 0)) return; // nothing meaningful to record
        const primaryInfo = getPrimarySkillInfo(player);
        const entry = {
            t: Date.now(),
            role: primaryInfo.name, // 'batting' | 'bowling' | 'keeping'
            isYouth: (player.age || 0) < 21,
            age: ageYears(player.age || 0), // v8.57 — pricing scales hugely with age (a 16yo and a 20yo are NOT the same market), so anchors must bucket by age band too; ageYears (floor) so the band matches the player's displayed age-year
            primary: primaryInfo.value,
            sum: computePlayerValueSkillSum(player), // visible-quality baseline so computeFairPrice can scale the anchor to a specific candidate (visible only — talents aren't in the transfer list scrape)
            price: price || 0,
            wage: player.wage || 0
        };
        try {
            let hist = loadPriceHistory();
            // Keep only recent entries (60 days) to bound growth
            const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
            hist = hist.filter(e => e.t >= cutoff);
            hist.push(entry);
            if (hist.length > TRANSFER_PRICE_MAX) {
                hist = hist.slice(hist.length - TRANSFER_PRICE_MAX);
            }
            GM_setValue(TRANSFER_PRICE_KEY, JSON.stringify(hist));
        } catch (e) { /* non-fatal; ignore storage failures */ }
    }

    // Returns { count, lo, med, hi, sumMed } of like-archetype listings we've
    // seen, or null when there's no data. Buckets by role + age band + primary
    // skill within ±1 (sliding wider when sparse). `sumMed` is the median
    // recorded QUALITY (skill-sum) of those listings, so computeFairPrice can
    // scale the price anchor to a specific candidate's quality rather than
    // treating every listing of that archetype as worth the same.
    function anchorPriceForPlayer(player) {
        if (!player) return null;
        const primaryInfo = getPrimarySkillInfo(player);
        const role = primaryInfo.name;
        const isYouth = (player.age || 0) < 21;
        const age = ageYears(player.age || 0);
        const primary = primaryInfo.value;
        const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
        const base = (e) => e.t >= cutoff && e.role === role && e.isYouth === isYouth && e.price > 0;
        // Legacy entries saved before v8.57 have no `age` — match them at any
        // age (coarser but same role/age-group archetype) until they expire
        // out of the 60-day window. Newer entries match the candidate's own
        // rounded age within tolerance.
        const byAge = (e, tol) => e.age == null || Math.abs(e.age - age) <= tol;
        let matches = loadPriceHistory().filter(e => base(e) && byAge(e, 1) && Math.abs(e.primary - primary) <= 1);
        // Slide both the primary range and the age tolerance wider if too few
        if (matches.length < 3) {
            matches = loadPriceHistory().filter(e => base(e) && byAge(e, 2) && Math.abs(e.primary - primary) <= 2);
        }
        if (matches.length === 0) return null;
        const prices = matches.map(e => e.price).sort((a, b) => a - b);
        const mid = i => prices[Math.floor(prices.length * i)];
        const sums = matches.map(e => e.sum).filter(s => s > 0).sort((a, b) => a - b);
        const sumMed = sums.length ? sums[Math.floor(sums.length / 2)] : null;
        return { count: prices.length, lo: mid(0.25), med: mid(0.5), hi: mid(0.75), sumMed };
    }

    // "What should I pay" — the price-aware half of the overall-rating pair.
    // computeOverallRating() is deliberately price-independent (so it works
    // identically for owned players who have no price); THIS function answers
    // the market-only question, scaled from the local price-history ledger's
    // anchor by how this candidate's quality compares to the archetype's
    // typical quality (a player well above the usual skill level of similar
    // listings is worth more than the raw median). Returns { fair, lo, hi,
    // count } or null when there's no usable comparable data yet.
    function computeFairPrice(player) {
        if (!player) return null;
        const anchor = anchorPriceForPlayer(player);
        if (!anchor) return null;
        // Scale by quality ratio when the ledger knows the archetype's typical
        // quality; fall back to the raw anchor median for legacy entries that
        // predate the sum field. Clamped so an extreme outlier can't produce a
        // ludicrous fair price (0.5x-2x the archetype median).
        const candidateQuality = computePlayerValueSkillSum(player);
        const ratio = anchor.sumMed ? Math.max(0.5, Math.min(2, candidateQuality / anchor.sumMed)) : 1;
        return {
            fair: anchor.med * ratio,
            lo: anchor.lo * ratio,
            hi: anchor.hi * ratio,
            count: anchor.count
        };
    }

    function fairPriceLine(player) {
        const fp = computeFairPrice(player);
        if (!fp) return '';
        const asking = player.price || 0;
        const ratio = asking > 0 ? asking / fp.fair : 0;
        let tag = '', color = 'var(--vj-text-muted)';
        if (asking <= 0) tag = 'no asking price yet';
        else if (ratio <= 0.85) { tag = 'below market — good deal'; color = 'var(--vj-green)'; }
        else if (ratio >= 1.15) { tag = 'above market — negotiate or pass'; color = 'var(--vj-red)'; }
        else tag = 'at market';
        const range = fp.count >= 6 ? ` ($${Math.round(fp.lo).toLocaleString()}–$${Math.round(fp.hi).toLocaleString()})` : '';
        return `<div class="vj-text-xs" style="color:${color};line-height:1.4;margin-top:2px;">\u2696 Fair price ~$${Math.round(fp.fair).toLocaleString()}${range} (${fp.count} similar seen)${asking > 0 ? ` \u00B7 asking $${asking.toLocaleString()} \u2192 ${tag}` : ''}</div>`;
    }

    // Weeks until this player turns 20 — the youth promotion boundary.
    // Delegates to weeksToAge() (14 weeks per age-year, see parseGameAge
    // / the 14-not-52 rule) so "weeks to a target age" lives in exactly
    // one formula instead of two copies quietly drifting apart (the same
    // class of bug the AGE_SKILL_EXPECTATIONS/YOUTH_DEV_CURVE duplication
    // was, removed v8.21 — see the Map section).
    function weeksToAge20(age) {
        return weeksToAge(age, 20);
    }

    // Weeks from the player's current age to a target age (14 weeks per
    // age-year — see parseGameAge()/the 14-not-52 rule). Generalizes
    // weeksToAge20() so a youth's ceiling can be projected to a senior-
    // comparable age (e.g. 25) rather than being truncated at the age-20
    // promotion boundary, which understated what they'll contribute once
    // they become seniors.
    function weeksToAge(age, targetAge) {
        // -1e-9 guards float drift at exact week boundaries: (20 - 16.35714)*14
        // can evaluate to 50.99999999999998, which Math.ceil would wrongly
        // round DOWN to 50 for a player 5 weeks into their 16th year (display
        // "16y6w") — with the 1-based parse they need exactly 51 weeks to turn
        // 20 (the current week counts; 16y14w has 43 = (20-16.92857)*14).
        return Math.max(0, Math.ceil((targetAge - (age || 16)) * 14 - 1e-9));
    }

    // Community-consensus assessment thresholds for a projected primary
    // skill at age 20 — Expert(9)+ = excellent, Accomplished(8) = strong,
    // Reliable(7) = adequate, below = likely won't contribute. Shared by
    // projectYouthToAge20() and the Transfer Advisor's candidate cards so
    // both label a given projected value identically.
    function classifyProjectedPrimary(value) {
        if (value >= 10) return 'outstanding';
        if (value >= 9) return 'expert';
        if (value >= 8) return 'accomplished';
        if (value >= 7) return 'reliable';
        return 'below-target';
    }

    /**
     * "Dynasty Score" — a single current-vs-ceiling figure combining
     * everything computePlayerValueSkillSum() already accounts for (role,
     * talents) with how far THIS specific player could still realistically
     * grow given their real age, real academy speed, and the same staged
     * training logic the Training Potential panel already simulates
     * (simulateAdaptiveTrainingPlan — not a new model, reused as-is).
     *
     * Explicitly requested: one number usable to compare a squad player
     * against a market candidate, accounting for age/academy/training
     * rather than just current stats — because a cheaper, currently-weaker
     * 17yo can still be the better long-term signing than an already-
     * peaked 26yo. current/ceiling are both computePlayerValueSkillSum()
     * outputs (same units, safely comparable) — current is "what you get
     * today", ceiling is "what they could realistically become".
     *
     * Two horizons, set by the caller:
     *   * DEFAULT (projectToAge omitted) — the NEAR-TERM plan horizon used
     *     by the Training Potential panel and the transfer card's "Projected
     *     at 20" promo line: youth (<20) project to the real age-20
     *     promotion boundary via weeksToAge20(); 20-29 get a real 2 age-year
     *     outlook; 30+ get 1 age-year — training still works past 30 (the
     *     age multiplier curve already accounts for slower gains), it's
     *     ACTIVE SKILL DECLINE from 30+ that isn't modeled (no confirmed
     *     rate — see the age-30 gotcha), so a short forward projection there
     *     is still meaningful, just not a substitute for judging an aging
     *     player mainly on current output.
     *   * projectToAge=25 — the SENIOR-COMPARABLE comparison horizon (v8.60,
     *     per the user) powering the Dynasty Score line/chip and the Overall
     *     Rating: EVERY age is projected to 25 (a 16yo and a 21yo are
     *     measured on the same "what they'll be at 25" scale), so a youth's
     *     potential future is directly comparable to the current 21/22/23-
     *     year-old squad players. Players already ≥25 get 0 weeks
     *     (weeksToAge → 0 → ceiling == current, label "no development
     *     runway").
     *
     * Unlike projectYouthToAge20() (which discards the plan and only
     * returns final skills + a verdict label), this returns the full
     * `plan` object too — callers that also need the week-by-week
     * timeline (the Player Advisor's training grid) can reuse it instead
     * of re-simulating.
     */
    function computePlayerCeiling(player, academySpeed, squadContext, projectToAge) {
        const age = player.age || 0;
        const isYouth = age < 20;
        // `projectToAge` overrides the default horizon so ANY player (youth
        // AND senior, v8.59 — the standardization) is projected to a
        // SENIOR-COMPARABLE age (25 — near the typical FTP peak) rather
        // than being truncated at 20 (youth) or judged on current value
        // alone (senior). A 21yo senior and a 16yo youth are therefore
        // measured on the same "what they'll be at 25" scale. Players
        // already ≥25 fall out naturally (weeksToAge → 0 → ceiling equals
        // current). Every projection also assumes the academy improves
        // toward Deluxe over the horizon (academySpeedAtWeek/ACADEMY_RAMP_
        // YEARS), so a better academy tomorrow correctly raises the
        // projected ceiling. The "ceiling" is always comparable in the
        // same computePlayerValueSkillSum() units.
        const weeks = projectToAge != null
            ? weeksToAge(age, projectToAge)
            : (isYouth ? weeksToAge20(age) : (age >= 30 ? 14 : 28));
        const label = projectToAge != null
            ? (weeks === 0 ? `no development runway — already past age ${projectToAge}` : `to age ${projectToAge}`)
            : (isYouth ? 'to age 20' : (age >= 30 ? '1 age-year outlook' : '2 age-year outlook'));
        const plan = simulateAdaptiveTrainingPlan(player, weeks, academySpeed, squadContext);
        const projectedSkills = Object.assign({}, player, plan.finalSkills);

        // Experience is a real value driver (see computePlayerValueSkillSum)
        // but CANNOT be projected by the training sim — the game grows it
        // through matchplay, not training. Carrying today's value forward
        // unchanged would under-rate every youth's ceiling by the experience
        // they'll realistically have accrued by the horizon (a 16yo with exp
        // 2 would still be exp 2 at 25). Project instead toward the game's
        // own per-age expectation (AGE_SCOUT_THRESHOLDS' experience rows —
        // real data from the user's saved scout searches), scaled by how
        // much of the full 16→25 career window (9 age-years = 126 weeks)
        // this player has left. Never reduces: a player already above the
        // expectation keeps their real number, and weeks=0 (already past
        // the horizon) → no growth → ceiling==current invariant preserved.
        const horizonAge = age + weeks / 14;
        const expTableAge = Math.min(horizonAge, 26); // table tops out at 26
        const expectedExp = interpAgeTableValue(AGE_SCOUT_THRESHOLDS, expTableAge, 'experience');
        const careerFrac = Math.min(1, weeks / (9 * 14));
        const currentExp = player.experience || 0;
        if (expectedExp != null) {
            projectedSkills.experience = Math.max(currentExp, Math.round(currentExp + (expectedExp - currentExp) * careerFrac));
        }
        return {
            current: computePlayerValueSkillSum(player),
            ceiling: computePlayerValueSkillSum(projectedSkills),
            weeks, label, projectedSkills, plan
        };
    }

    // ─────────────────────────────────────────────────────────────
    // OVERALL RATING (price-independent)
    // ─────────────────────────────────────────────────────────────
    // The single "how good is this player?" number, usable for ANY player —
    // owned (no price) or on the market — because it deliberately excludes
    // price and squad fit. It answers the question Dynasty alone can't:
    //   * "21y2 is 44 dynasty, 21y3 is 42 — is the 21y2 better?" → Dynasty
    //     is quality-only (skill sum). It says nothing about stat
    //     distribution, wage efficiency, or talents, so "44 vs 42" is NOT a
    //     rating on its own. OverallRating folds all of that in.
    //   * Price and squad fit are deliberately NOT part of it: price is a
    //     market fact (owned players don't have one, so a price-dependent
    //     rating would break them), and squad fit is already reported by
    //     comparePlayerToSquadPeers on transfer cards ("outranks your current
    //     X" / "fills a gap") and on the Player Advisor. Conflating price into
    //     the rating is exactly what the old
    //     Buy Rating did (v8.49), and it made the score swing wildly with the
    //     asking price (a $5k vs $50k listing of near-equal quality differed
    //     by ~10 points purely on cost) while saying nothing useful to an
    //     owner. Instead: this rating = quality of the player, and
    //     computeFairPrice() (see the price-ledger block above) = "what
    //     should I actually pay" for a market player.
    //
    // One horizon for EVERY age (v8.59 standardization, per the user):
    // quality is the projected skill-sum at age 25 — a 21yo senior is
    // judged on the player he'll be at 25, exactly like a 16yo, so owned
    // players and market candidates of every age sit on the same scale.
    // Players already ≥25 fall out naturally (weeksToAge → 0 → ceiling ==
    // current) — the "first-team now" reading for fully-developed players
    // is preserved. The projection also assumes the academy keeps
    // upgrading toward Deluxe over the horizon (ACADEMY_RAMP_YEARS), so
    // a better academy tomorrow correctly raises the ceiling. Prior to
    // this: seniors were judged on current quality only, youth on their
    // to-25 ceiling — two different scales that made the same player read
    // differently by age. The youth history: truncating at age 20 made
    // every 16yo look worse than any senior; projecting to 22 still
    // understated a youth still climbing through the mid-20s (v8.58: 22 →
    // 25 after a curve-meeting 16yo read too low — his bowling keeps
    // rising 8→9 between 22 and 25). This is the ONE horizon used
    // everywhere a player's quality is compared — the transfer overall
    // rating, the Player Advisor, and the Squad Plan's sell rankings.
    //
    // Score 0-100. Returns { score, label, parts, breakdown[] }. Every
    // component is a named, weighted term so the number is explainable rather
    // than a black box.
    // Requires opts: { academySpeed, squadContext, seniorCeiling } — the
    // to-25 projection is precomputed by the caller so the expensive
    // training simulation runs once per candidate; computeOverallRating
    // falls back to self-computing it only for direct callers that don't pass
    // it (e.g. test harnesses).
    function computeOverallRating(player, opts) {
        if (!opts) return { score: 0, label: 'no-context', parts: {}, breakdown: [] };
        const breakdown = [];
        const primaryInfo = getPrimarySkillInfo(player);
        const role = primaryInfo.name;
        const roleLabel = role === 'keeping' ? 'wicketkeeper' : role === 'bowling' ? 'bowler' : 'batter';

        // 1) Core quality distilled to a 0-55 contribution — the dominant
        //    term. ONE horizon for EVERYONE (v8.59 standardization): the
        //    projected skill-sum at age 25 — a 21yo senior is judged on the
        //    player he'll be at 25, exactly like a 16yo, so owned players
        //    and market candidates of every age sit on the same scale.
        //    Players already ≥25 fall out naturally (weeksToAge → 0 →
        //    ceiling == current), preserving the "first-team now" reading
        //    for fully-developed players. The to-25 projection assumes the
        //    academy keeps improving toward Deluxe (academySpeedAtWeek), so
        //    a better academy tomorrow correctly raises every projected
        //    ceiling. Cap 55 keeps headroom on the 0-100 scale while
        //    matching the real observed range of skill-sums (a ~50+ senior
        //    is already exceptional — a Spectacular primary plus strong
        //    supporting skills).
        //    Prefer the caller-precomputed to-25 projection (seniorCeiling)
        //    so the expensive training simulation isn't re-run here. The
        //    fallback self-computes for direct callers that don't pass it
        //    (e.g. test harnesses). This horizon is deliberately different
        //    from the near-term plan ceilingResult (to-20 for youth /
        //    2-age-year for seniors, which feeds the Training Potential
        //    panel and the transfer card's "Projected at 20" promo line):
        //    the rating (and the Dynasty Score) are about the senior they'll
        //    BECOME, not the near-term outlook.
        let qualityRef;
        qualityRef = (opts.seniorCeiling && opts.seniorCeiling.ceiling != null)
            ? opts.seniorCeiling.ceiling
            : computePlayerCeiling(player, opts.academySpeed, opts.squadContext, 25).ceiling;
        const qualityScore = Math.max(0, Math.min(55, qualityRef));

        // 2) Age/trajectory factor (0-10) — ONE continuous lifecycle curve
        //    for EVERY age (v8.65). The old two-curve split (youth declining
        //    16->20, senior peaking 21-24) measured two different things —
        //    "youth development runway remaining" vs "career prime" — and
        //    the stitched seam produced a real cliff: the identical player
        //    scored 4 at 20y14w (final youth week) and 10 at 21y1w, a
        //    one-week 6-point swing that let a 20yo with a HIGHER to-25
        //    ceiling rate BELOW a 21yo with a lower one, purely from the
        //    boundary. Since the quality term already projects EVERYONE to
        //    age 25, a 16yo's potential is already counted — there is no
        //    separate "youth runway" left for this term to measure. So it
        //    measures prime/decline only: flat at 10 across 16-24 (in prime,
        //    or with a clear path into it — a 20y14w player is a week from
        //    being a 21yo prime senior, not 60% of one), then the same
        //    smooth decline 25+ (interpAgeSteps ramps within each year, so
        //    a 24y6w player is 85% of the way to the 25yo tier).
        const ageScore = interpAgeSteps(player.age, [[16, 10], [24, 10], [25, 7], [26, 7], [27, 7], [28, 4], [29, 4], [30, 1]]);

        // 3) Stat distribution (0-10) — a specialist's value comes from a
        //    deep primary + supporting skills, not a flat all-rounder sum.
        //    Punish a big gap in the skill that matters most for the role.
        let distScore = 5;
        if (role === 'batting') {
            const support = ((player.technique||0) + (player.power||0)) / 2;
            distScore = 4 + Math.min(6, ((player.batting||0) - 5) + (support - 4) * 0.5);
        } else if (role === 'bowling') {
            const support = ((player.endurance||0) + (player.technique||0)) / 2;
            distScore = 4 + Math.min(6, ((player.bowling||0) - 5) + (support - 4) * 0.5);
        } else if (role === 'keeping') {
            const support = (player.batting||0); // keepers must bat (keeperBattingMin logic)
            distScore = 4 + Math.min(6, ((player.keeping||0) - 4) + (((player.batting||0) - 4) * 0.5));
        }
        distScore = Math.max(0, Math.min(10, distScore));

        // 4) Value for money (0-15). Quality (skill) per $1k of the real
        //    (discount-adjusted) wage. Cheap+skilled = excellent value.
        //    NOTE: uses WAGE only — the one-time transfer price is handled
        //    by computeFairPrice() (see the price-ledger block), not folded
        //    into the rating, so owned players (no price) and market
        //    candidates are rated on the same scale.
        let valueScore = 0;
        const vpk = computePlayerValuePerK(player);
        if (vpk != null) {
            // vpk ~ 5-15 typical; map to 0-15
            valueScore = Math.max(0, Math.min(15, (vpk - 3) * 1.5));
        } else {
            valueScore = 6; // wage unknown — neutral, don't punish
        }

        // 5) Talent bonus (0-5) — role-aligned talents add real upside
        //    already counted in skill-sum, but reward a meaningful talent
        //    set explicitly here.
        const talentScore = Math.min(5, countAlignedTalents(player) * 1.5);

        // ONE weight set for EVERY age (v8.65). The old youth weights
        // (1.0/1.2/0.6/0.4/0.8) discounted a youth's dist/value/talent
        // terms relative to seniors (1.0/1.0/0.8/0.8/1.0), which stacked
        // with the age cliff to systematically under-rate youth — a
        // 57-ceiling 20yo could rate below a 51-ceiling 21yo. There is
        // nothing age-specific left to weight differently: quality is the
        // to-25 projection for every age, age comes from one shared curve,
        // and value/dist/talent are player facts that don't change which
        // squad a player is in. No price, no squad-fit terms — those are
        // market decisions (computeFairPrice / comparePlayerToSquadPeers),
        // not player-quality, and leaving them out is what lets this one
        // number be shown identically for an owned player and a market
        // candidate. A curve-meeting youth can now legitimately outrank an
        // older senior, which is the whole point of the projection.
        let score, label;
        score = qualityScore * 1.0 + ageScore * 1.2 + distScore * 0.8 + valueScore * 0.8 + talentScore * 1.0;
        score = Math.max(0, Math.min(100, score));
        label = score >= 75 ? 'elite' : score >= 55 ? 'strong' : score >= 35 ? 'reasonable' : 'pass';

        return {
            score: Math.round(score * 10) / 10,
            label, role, roleLabel,
            parts: { quality: qualityScore, age: ageScore, dist: distScore, value: valueScore, talent: talentScore },
            breakdown
        };
    }

    // Renders the Overall Score as a compact, colour-coded card badge.
    // Price-independent, so it reads identically on a transfer card and an
    // owned player's page — the badge never carries a fit icon because squad
    // fit is reported separately (comparePlayerToSquadPeers lines on transfer
    // cards).
    function overallRatingBadge(r) {
        if (!r || r.score == null) return '';
        const color = r.label === 'elite' ? 'green'
            : r.label === 'strong' ? 'teal'
            : r.label === 'reasonable' ? 'amber' : 'red';
        return `<span class="ftp-stat-badge ${color}" title="${r.breakdown.join('; ') || 'No breakdown'}" style="font-size:10px;cursor:help;">\u2605 OVERALL ${r.score}/100</span>`;
    }


    // ============================================================
    // FORM / EXPERIENCE MULTIPLIERS
    // Real percentage curves from the user's FTP_Training model
    // (Form-Exp tab), not just ad-hoc linear weights. Verbatim from the
    // sheet — nothing here is interpolated or invented.
    // Wired into calculateBattingScore/calculateBowlingScore as a
    // multiplicative modifier on top of the existing linear skill
    // weights (score *= formMult * expMult) — replaces the old flat
    // `+ player.form * 1.5` / `+ player.experience * 0.5` additive terms,
    // which didn't reflect the real game's curves at all.
    //
    // FORM_MULTIPLIER: indices 0-10 (Atrocious..Outstanding) only — the
    // source sheet has NO data above Outstanding. Do not extrapolate;
    // callers should clamp index at 10 for Spectacular+ until real data
    // is available for those tiers.
    // EXPERIENCE_MULTIPLIER: full 0-15 range, matches SKILL_MAP.
    //
    // A Fatigue curve also exists in the sheet (1.00 down to 0.45) but
    // is NOT included here: the sheet has 12 distinct fatigue rows
    // ("rested" AND "rest" as separate levels, 1.00 vs 0.98) while
    // FATIGUE_MAP treats "rested"/"rest" as the same level (10) — an
    // unresolved mismatch. Get clarification before adding it rather
    // than guessing an index mapping that could silently corrupt
    // allocateBowlingSpells' fatigue-aware logic.
    // ============================================================
    const FORM_MULTIPLIER = [0.70, 0.73, 0.76, 0.79, 0.82, 0.85, 0.88, 0.91, 0.94, 0.97, 1.00];
    const EXPERIENCE_MULTIPLIER = [1.00, 1.06, 1.11, 1.16, 1.19, 1.22, 1.25, 1.28, 1.31, 1.33, 1.35, 1.36, 1.37, 1.38, 1.39, 1.40];

    // ============================================================
    // BOWLER TYPE CATEGORIES
    // ============================================================
    const BOWLER_CATEGORY = {
        'rf': 'seam', 'lf': 'seam', 'rfm': 'seam', 'lfm': 'seam', 'rm': 'seam', 'lm': 'seam',
        'rfs': 'spin', 'lfs': 'spin', 'rws': 'spin', 'lws': 'spin'
    };

    const BOWLER_PACE = {
        'rf': 5, 'lf': 5,
        'rfm': 4, 'lfm': 4,
        'rm': 3, 'lm': 3,
        'rfs': 2, 'lfs': 2,
        'rws': 2, 'lws': 2
    };

    // Minimum bowling stat (0-15 scale) for a player to be considered a potential bowler.
    // In FTP, any player can bowl regardless of designated bowlerType.
    // bowling >= 5 = "reasonable" skill level
    const MIN_BOWLING_FOR_BOWLERS = 5;

    // ============================================================
    // AGE-BASED SKILL EXPECTATIONS for the youth 16-20 curve used to live
    // here as a separate table (AGE_SKILL_EXPECTATIONS), community-backed
    // from forum posts/training guides. It had drifted into a near-
    // duplicate of YOUTH_DEV_CURVE below (same "user-specified
    // benchmarks", small unintentional differences like fielding target
    // 8 vs 7 at age 20) — removed in favor of the one canonical curve,
    // used via evaluateYouthDevelopment() everywhere a youth curve check
    // is needed (transfer scouting, Player Advisor, training).

    // AGE_WAGE_EXPECTATIONS (per-age min/typical/max wage bands) was
    // defined here and never read — "the base" gates quality on Primary
    // skill and Rating directly rather than on wage (see its own note
    // below), so the table had no consumer. Removed rather than left as
    // a plausible-looking constant someone wires up later assuming it's
    // load-bearing. Community wage figures are still documented in the
    // youth wage-cap comments in updateTransferAdvisor(), which are live.

    // ============================================================
    // PITCH & WEATHER EFFECTS (from actual ground page descriptions)
    // ============================================================
    const PITCH_EFFECTS = {
        'Sticky': { seam: 1.3, spin: 1.3, bat: 0.6, paceBonus: 1.3, favor: 'bowlers', desc: 'Heavily favours ALL bowlers' },
        'Uneven': { seam: 1.3, spin: 0.9, bat: 0.7, paceBonus: 1.3, favor: 'seam', desc: 'Favours seam (fast/fast-medium)' },
        'Green': { seam: 1.2, spin: 0.8, bat: 0.85, paceBonus: 1.0, favor: 'seam', desc: 'Favours medium seam, slight disadvantage to spin' },
        'Hard': { seam: 1.0, spin: 0.7, bat: 1.3, paceBonus: 1.1, favor: 'batting', desc: 'Favours batters, fast bowlers get bounce' },
        'Flat': { seam: 0.8, spin: 0.8, bat: 1.3, paceBonus: 0.8, favor: 'batting', desc: 'Favours batters' },
        'Even': { seam: 1.0, spin: 1.0, bat: 1.0, paceBonus: 1.0, favor: 'balanced', desc: 'No advantage to anyone' },
        'Sporting': { seam: 1.0, spin: 1.0, bat: 1.0, paceBonus: 1.0, favor: 'balanced', desc: 'No advantage to anyone' },
        'Slow': { seam: 1.1, spin: 1.1, bat: 0.85, paceBonus: 0.8, favor: 'spin', desc: 'Slightly favours medium pace and spin' },
        'Dry': { seam: 0.85, spin: 1.3, bat: 0.95, paceBonus: 0.7, favor: 'spin', desc: 'Favours spin, slight disadvantage to seam' },
        'Crumbling': { seam: 1.1, spin: 1.3, bat: 0.8, paceBonus: 0.8, favor: 'spin', desc: 'Heavily favours spin, slightly favours seam' }
    };

    const WEATHER_EFFECTS = {
        'Hot': { seam: 0.9, spin: 1.0, bat: 0.85, fatigue: 1.3, desc: 'Hard work - all players tire faster. Seam suffers, spinners OK' },
        'Sunny': { seam: 1.0, spin: 1.0, bat: 1.0, fatigue: 1.0, desc: 'Everyone likes a sunny day - no advantage' },
        'Humid': { seam: 1.1, spin: 0.8, bat: 0.9, fatigue: 1.2, desc: 'Players tire faster. Seam bowlers enjoy, spinners struggle to grip' },
        'Overcast': { seam: 1.15, spin: 0.9, bat: 0.9, fatigue: 1.0, desc: 'Cloudy, favours seam bowlers' },
        'Cloudy': { seam: 1.15, spin: 0.9, bat: 0.9, fatigue: 1.0, desc: 'Slightly favours seam bowlers' },
        'Windy': { seam: 0.9, spin: 1.15, bat: 0.95, fatigue: 1.0, desc: 'Wind helps spinners with flight' },
        'Cool': { seam: 1.0, spin: 1.0, bat: 1.0, fatigue: 0.9, desc: 'Cool, players last longer' }
    };

    // Youth age limit (for Youth and Youth T20 matches)
    const YOUTH_MAX_AGE = 20;

    // Squad-overcrowding training penalty: 7.5% per player beyond 25.
    // The 25 / 7.5 pair was previously written out by hand in five
    // separate places (two as a 0-1 multiplier, three as a percentage
    // for display) — one canonical definition instead, so a rules
    // change can't leave some call sites on the old numbers.
    const MAX_EFFICIENT_SQUAD = 25;
    const SQUAD_PENALTY_PCT_PER_PLAYER = 7.5;
    function squadPenaltyPct(squadSize) {
        return squadSize > MAX_EFFICIENT_SQUAD
            ? (squadSize - MAX_EFFICIENT_SQUAD) * SQUAD_PENALTY_PCT_PER_PLAYER : 0;
    }
    function squadPenaltyMultiplier(squadSize) {
        return Math.max(0, 1 - squadPenaltyPct(squadSize) / 100);
    }

    // Senior minimum skill requirements for transfers (age-dependent)
    const SENIOR_MINS_YOUNG = { primary: 9, technique: 9, fielding: 8, endurance: 4, experience: 4 };
    const SENIOR_MINS_VETERAN = { primary: 9, technique: 9, fielding: 8, endurance: 5, experience: 5 };

    // ============================================================
    // SCOUT BENCHMARKS ("the base") — age-specific minimums for a
    // long-term-development transfer strategy: buy mainly at 21 to
    // develop, hold Primary/skill floors strict at 24+ (proven quality,
    // little training runway left), but relax Technique/Experience at
    // 20-22 since those are cheaply recoverable through training/match
    // play at that age — widening the eligible pool without touching
    // the two truest quality signals (Primary skill, and Rating for
    // youth where wage hasn't caught up to potential yet).
    // No wage floor — Primary skill is the quality gate directly instead
    // of using wage as a proxy for it.
    // Used as a HARD filter in evaluateTransferTarget/checkScoutBenchmark:
    // a player must meet 100% of the fields defined for their age.
    // ============================================================
    const AGE_SCOUT_THRESHOLDS = {
        // experience: 1 (Dreadful), not 2 (Poor) — a freshly recruited
        // 16yo hasn't played senior/youth minutes yet, so Experience
        // starts low regardless of underlying quality; it accrues from
        // playing, not recruitment. Confirmed against a real recruit
        // (27,531 rating, Reasonable technique, Average fielding — a
        // clearly strong prospect) who sat at exactly Dreadful
        // experience and was being wrongly flagged for release under
        // the old Poor floor. Matches the looser of the user's two
        // saved 16yo searches ("dread exp" vs "poor exp") — this was
        // the correct one, not a screenshot transcription error.
        // Rating is a UNIVERSAL floor for every age (v8.69, per user): 25k
        // minimum for everyone — a 16yo recruit must be 25k+, and since no
        // player is ever below that, every age row enforces the same 25k
        // floor (the old age-graded 20k/23k/24.5k for 16/17/18 were replaced
        // by one flat number, and 19+ gained a gate they previously lacked).
        // Rating is only checked once a per-player fetch fills it in (the
        // "known" gate below), so a first-load results list is unaffected.
        16: { rating: 25000, primary: 4, technique: 2, experience: 1, fielding: 2 },
        17: { rating: 25000, primary: 5, technique: 4, experience: 2, fielding: 2 },
        18: { rating: 25000, primary: 6, technique: 6, experience: 2, fielding: 3 },
        19: { rating: 25000, primary: 8, technique: 7, experience: 3, fielding: 4 },
        20: { rating: 25000, primary: 9, technique: 7, experience: 3, fielding: 3 },
        21: { rating: 25000, primary: 9, technique: 7, experience: 4, fielding: 5 },
        22: { rating: 25000, primary: 9, technique: 8, experience: 5, fielding: 6 },
        23: { rating: 25000, primary: 10, technique: 10, experience: 6, fielding: 6 },
        24: { rating: 25000, primary: 11, technique: 11, experience: 8, fielding: 7 },
        25: { rating: 25000, primary: 11, technique: 11, experience: 8, fielding: 8 },
        26: { rating: 25000, primary: 11, technique: 11, experience: 8, fielding: 8 },
        27: { rating: 25000, primary: 11, technique: 11, fielding: 9 },
    };

    /**
     * Check a transfer target (youth or senior) against "the base" —
     * the age-specific scout benchmarks above. This is a HARD filter on
     * ONLY the fields defined for that age (primary, technique,
     * experience, fielding, and where present rating) — a player
     * must meet 100% of those or is filtered out. Every other skill
     * (endurance, keeping, etc.) is intentionally NOT gated here: higher
     * is simply better and that's handled by the scoring/ranking logic
     * elsewhere, not this filter.
     * A field is only checked once its data is actually known —
     * primary/technique/fielding are always present from the transfer
     * list scrape, but experience/rating are 0 until a per-player page
     * fetch fills them in, so they're skipped (not treated as a fail)
     * until then. Without this gate every player fails the experience
     * check before their details ever load, wiping out the results list.
     * Returns { hasBenchmark, passed, failed: string[], met: string[] }.
     */
    function checkScoutBenchmark(player) {
        // ageYears (floor), not round: the "age 16" base was transcribed
        // from a saved Talent Scout search that returns every player the
        // game DISPLAYS as 16 (16.0-16.93). Rounding bumped 16y7w+ players
        // onto the "17" base half a year early — a half-year cliff with no
        // basis in the source data. A player stays on their displayed year's
        // base until they actually turn the next age.
        const age = ageYears(player.age);
        const t = AGE_SCOUT_THRESHOLDS[age] || (age > 27 ? AGE_SCOUT_THRESHOLDS[27] : null);
        if (!t) return { hasBenchmark: false, passed: true, failed: [], met: [] };

        // Primary/Technique/Fielding are "known: value > 0", not
        // unconditionally true — a real 0 (Atrocious) on ALL of a
        // candidate's core skills at once almost always means the column
        // failed to scrape/map (see _mapTransferHeader/parseTransferRow),
        // not a genuine zero-skill player. Treating a scrape gap as a real
        // Atrocious rating silently hard-fails every candidate exactly
        // like the Experience-always-0 bug fixed in v8.11 — same failure
        // shape, different field.
        const primaryInfo = getPrimarySkillInfo(player);
        const primary = primaryInfo.value;
        const checks = [
            { name: 'Primary', value: primary, min: t.primary, known: primary > 0 },
            { name: 'Technique', value: player.technique || 0, min: t.technique, known: (player.technique || 0) > 0 },
            { name: 'Experience', value: player.experience || 0, min: t.experience, known: (player.experience || 0) > 0 },
            { name: 'Fielding', value: player.fielding || 0, min: t.fielding, known: (player.fielding || 0) > 0 },
        ];
        // A keeper's primary check above is keeping, not batting — add
        // batting as its own (lower-bar) requirement so a great keeper
        // who genuinely can't bat still gets filtered out.
        if (primaryInfo.name === 'keeping') {
            const battingMin = keeperBattingMin(t.primary);
            checks.push({ name: 'Batting (WK)', value: player.batting || 0, min: battingMin, known: (player.batting || 0) > 0 });
        }
        if (t.rating != null) checks.push({ name: 'Rating', value: player.rating || 0, min: t.rating, known: (player.rating || 0) > 0, isMoney: true });

        const fmt = (c, v) => c.isMoney ? v.toLocaleString() : skillLabel(v);
        const failed = checks.filter(c => c.known && c.value < c.min)
            .map(c => `${c.name} ${fmt(c, c.value)} — below age ${age} base minimum ${fmt(c, c.min)}`);
        const met = checks.filter(c => c.known && c.value >= c.min)
            .map(c => `${c.name} meets age ${age} base minimum (${fmt(c, c.min)}+)`);

        return { hasBenchmark: true, passed: failed.length === 0, failed, met };
    }

    // ============================================================
    // TRAINING REFERENCE DATA
    // Sourced from the "Refs" sheet of the user's FTP_Training model
    // (FTP_Training_5_2.xlsx). Governs how fast a skill can actually
    // improve, independent of the qualitative advice in
    // TRAINING_SKILL_GAINS / recommendTraining() below.
    // ============================================================

    // Age-based training-speed multipliers (Refs!AG3:AJ21).
    // "primary" = the skill a training program is mainly building
    // (batting/bowling/technique/keeping/fielding), "power" = Strength
    // training, "endurance" = Fitness training. All three decay with
    // age; Endurance barely decays until the late 20s, Power tails off
    // hard after the mid-20s, and Primary skills fall off steadily from
    // age 16. Age 33+ is not modelled in the source sheet and is
    // clamped to the age-32 rate.
    const AGE_TRAINING_MULTIPLIER = {
        16: { primary: 1.20, power: 0.50, endurance: 1.00 },
        17: { primary: 1.15, power: 0.60, endurance: 1.00 },
        18: { primary: 1.10, power: 0.70, endurance: 1.00 },
        19: { primary: 1.00, power: 0.80, endurance: 1.00 },
        20: { primary: 0.93, power: 0.85, endurance: 1.00 },
        21: { primary: 0.86, power: 0.90, endurance: 1.00 },
        22: { primary: 0.79, power: 0.95, endurance: 1.00 },
        23: { primary: 0.71, power: 1.00, endurance: 1.00 },
        24: { primary: 0.64, power: 1.00, endurance: 1.00 },
        25: { primary: 0.57, power: 1.00, endurance: 1.00 },
        26: { primary: 0.50, power: 1.00, endurance: 1.00 },
        27: { primary: 0.45, power: 1.00, endurance: 1.00 },
        28: { primary: 0.40, power: 0.90, endurance: 1.00 },
        29: { primary: 0.35, power: 0.80, endurance: 1.00 },
        30: { primary: 0.30, power: 0.70, endurance: 1.00 },
        31: { primary: 0.25, power: 0.60, endurance: 0.90 },
        32: { primary: 0.20, power: 0.50, endurance: 0.80 }
    };

    // Age-based training-speed multipliers, interpolated by WEEKS through
    // the current year (v8.62). Previously rounded the age to a whole
    // year, which made a 16y6w player train at the full age-16 rate and a
    // 16y7w player jump straight to the age-17 rate — a cliff at the
    // half-year for a decay that actually happens continuously. Training
    // speed is a continuous quantity, so it now lerps between the current
    // year's row and the next year's using the player's actual weeks
    // (e.g. 16y6w primary = 1.20 - (5/14)*(1.20-1.15) ≈ 1.182 — weeks are
    // 1-based since v8.64, so 16y6w is 5 completed weeks). Age 33+
    // is not modelled in the source sheet and is clamped to the age-32
    // rate (the interpolation's top-year clamp does this automatically).
    function getAgeTrainingMultiplier(age) {
        const c = Math.max(16, Math.min(32, age || 0));
        const out = { primary: 0.20, power: 0.50, endurance: 0.80 };
        ['primary', 'power', 'endurance'].forEach(f => {
            const v = interpAgeTableValue(AGE_TRAINING_MULTIPLIER, c, f);
            if (v != null) out[f] = v;
        });
        return out;
    }

    // Skill-level slowdown (Refs!I15:J23). Once a skill reaches
    // Outstanding (10), each further level is ~15% slower to train than
    // the one before it. Returns a multiplier <= 1 to apply on top of
    // the age multiplier above, e.g. a skill at Exceptional (12) is
    // training at roughly 0.85^2 = 72% of its "pre-slowdown" rate.
    const SKILL_SLOWDOWN_THRESHOLD = 10; // Outstanding
    const SKILL_SLOWDOWN_PER_LEVEL = 0.15; // 15% per level above threshold

    function getSkillSlowdownMultiplier(skillLevel) {
        const levelsAbove = Math.max(0, Math.round(skillLevel) - SKILL_SLOWDOWN_THRESHOLD);
        if (levelsAbove === 0) return 1;
        return Math.pow(1 - SKILL_SLOWDOWN_PER_LEVEL, levelsAbove);
    }

    // Training Talent bonus: a matching Training Talent (e.g. "Gifted
    // (Batting)") or Prodigy (all skills) gives a flat training-rate
    // bonus on top of age/academy/slowdown multipliers. Previously
    // cited as "Refs!I18:J23" = 0.15, but that range is actually the
    // Skills Slowdown table (also coincidentally 0.15/level) — a
    // citation mix-up, not the talent bonus at all. Verified instead
    // from FTP_Training 5.2.xlsx's DB tab: 315 consistent occurrences
    // of a flat x1.2 multiplier (+20%) across every Prodigy/Gifted
    // formula checked, for every academy level and training program.
    const TRAINING_TALENT_BONUS = 0.20;

    // ============================================================
    // YOUTH DEVELOPMENT CURVE (user-specified benchmarks)
    // Age-by-age minimum targets for a youth prospect worth keeping on
    // track. "primary" = batting for batsmen, bowling for bowlers,
    // keeping for wicketkeepers (wicketkeepers are also checked against
    // batting separately, per the user's "keeping AND batting" note).
    // Where the user gave a range (e.g. "Capable to Reliable") the
    // lower bound is used as the pass/fail line and the upper bound as
    // the "ahead of curve" line.
    // ============================================================
    const YOUTH_DEV_CURVE = {
        16: { primary: 4, technique: 4, fielding: 4 },                                   // Average
        17: { primary: 5, technique: 5, fielding: 5 },                                   // Reasonable
        18: { primary: 6, primaryGood: 7, technique: 6, techniqueGood: 7, fielding: 6 },  // Capable→Reliable / Capable
        19: { primary: 8, technique: 8, fielding: 6, fieldingGood: 7 },                   // Accomplished / Capable+
20: { primary: 9, technique: 9, fielding: 8,                                    // Expert / Accomplished
             endurance: 3, experience: 3 }                                               // Ordinary+
    };

    // Delegates to getPrimarySkillInfo() — this used to be a separate
    // implementation that additionally required bowlerCategory !== 'none'
    // before ever considering bowling as primary. That's a real bug: on
    // any scrape where bowlerType/bowlerCategory detection fails (e.g.
    // player.htm — see scrapePlayerDetailPage's own lower-confidence
    // note, its bowlerType span/regex fallback doesn't always match) a
    // genuine bowler with bowling clearly ahead of batting still fell
    // through to 'batting', while getPrimarySkillInfo() (used by transfer
    // search) only ever compares the raw skill numbers and has no such
    // dependency. Same player, two different "primary skill" answers
    // depending only on which page scraped bowlerCategory successfully —
    // e.g. Player Advisor verdict (RELEASE, judged on weak batting) vs.
    // transfer search verdict (STRONG, judged on solid bowling) for the
    // literal same person. One shared implementation now; can't diverge.
    function getYouthPrimarySkillName(player) {
        return getPrimarySkillInfo(player).name;
    }

    // Returns null if the player is outside the tracked age window (16-20)
    // or the target table has nothing for their age. Otherwise returns a
    // per-stat breakdown so the UI can show exactly what's behind/ahead.
    // Since v8.68 "behind" is TIME-AWARE: a below-target trainable stat is
    // only 'behind' if it can't realistically reach its target before the
    // player's displayed age increments (see the feasibility logic below);
    // if it can, the row is 'catching-up' instead. Statuses: ahead /
    // on-track / catching-up / behind. overallStatus is the worst of these.
    function evaluateYouthDevelopment(player) {
        // Same floor-based year lookup as checkScoutBenchmark: the "age 16"
        // curve is the target for anyone the game displays as 16, all the
        // way to 16y13w — not just the first half of the year.
        const age = ageYears(player.age);
        const target = YOUTH_DEV_CURVE[age];
        if (!target) return null;

        const primaryStatName = getYouthPrimarySkillName(player);
        const primaryValue = player[primaryStatName] || 0;
        const techniqueProgram = primaryStatName === 'keeping' ? 'keeperbatting' : primaryStatName === 'bowling' ? 'bowlingtech' : 'battingtech';
        const rows = [
            { label: `Primary (${primaryStatName})`, skill: primaryStatName, value: primaryValue, min: target.primary, good: target.primaryGood },
            { label: 'Technique', skill: 'technique', value: player.technique || 0, min: target.technique, good: target.techniqueGood },
            { label: 'Fielding', skill: 'fielding', value: player.fielding || 0, min: target.fielding, good: target.fieldingGood }
        ];
        if (primaryStatName === 'keeping') {
            // User's note: wicketkeepers are judged on keeping AND batting,
            // not keeping alone — but batting is a secondary requirement,
            // not held to the same bar as keeping itself (keeperBattingMin
            // shared with the transfer-scouting hard filters below).
            rows.push({ label: 'Batting (WK)', skill: 'batting', value: player.batting || 0, min: keeperBattingMin(target.primary) });
        }
        if (target.endurance !== undefined) rows.push({ label: 'Endurance', skill: 'endurance', value: player.endurance || 0, min: target.endurance });
        if (target.experience !== undefined) rows.push({ label: 'Experience', skill: 'experience', value: player.experience || 0, min: target.experience });

        // Time-aware "behind" (v8.68): a below-target TRAINABLE stat is only
        // genuinely behind if it can't plausibly reach its target before the
        // player's displayed age increments — a 20yo has until they turn 21
        // (i.e. 20.14), a 16yo until 17. A flat value-vs-min check wrongly
        // treated a 20y1w at fielding 7 exactly like a 20y14w at fielding 7,
        // when the first has ~14 weeks to close a ~5-week gap and the second
        // has a single week. Weeks-to-close come from the SAME per-week
        // training-rate model as the training sim (estimateWeeklyTrainingGain)
        // and are SUMMED across all below-target trainable skills, compared
        // against the weeks left in the year — so being behind on 2+ stats at
        // once is naturally infeasible (you can't run two youth programs at
        // once), which is the user's key constraint. Result: three statuses
        // instead of the old binary behind/on-track:
        //   behind      — below target AND not enough time left this year
        //   catching-up — below target but can realistically reach it this year
        //   on-track/ahead — at/above target (unchanged)
        const programToSkill = { batting: 'batting', bowling: 'bowling', keeping: 'keeping', battingtech: 'technique', bowlingtech: 'technique', keeperbatting: 'technique', fielding: 'fielding', fitness: 'endurance' };
        const TRAINABLE = { batting: 'batting', bowling: 'bowling', keeping: 'keeping', technique: techniqueProgram, fielding: 'fielding', endurance: 'fitness' };
        const weeksLeft = weeksToAge(player.age, age + 1);
        const academySpeed = getAcademySpeedForPlayer(player, loadAcademyCache());
        let totalWeeksToClose = 0, canEstimate = true;
        const nonTrainableBelow = rows.some(r => r.value < r.min && !TRAINABLE[r.skill]);
        rows.forEach(r => {
            if (r.value < r.min && TRAINABLE[r.skill]) {
                const wk = weeksToTrainSkill(TRAINABLE[r.skill], programToSkill[TRAINABLE[r.skill]], r.value, r.min, player, academySpeed);
                if (wk == null) canEstimate = false; else totalWeeksToClose += wk;
            }
        });
        const feasible = canEstimate && !nonTrainableBelow && totalWeeksToClose <= weeksLeft;

        rows.forEach(r => {
            if (r.value < r.min) {
                if (!TRAINABLE[r.skill]) {
                    // experience — grows by playing, not a trainable program
                    r.status = 'behind';
                    r.reason = `${r.label} below target and not trainable via a youth program`;
                } else if (!feasible) {
                    r.status = 'behind';
                    r.reason = `needs ~${totalWeeksToClose}wk to reach age-${age} targets but only ${weeksLeft}wk left of age ${age}`;
                } else {
                    r.status = 'catching-up';
                    r.reason = `~${totalWeeksToClose}wk to target, ${weeksLeft}wk left of age ${age}`;
                }
            } else if (r.good && r.value >= r.good) {
                r.status = 'ahead';
            } else {
                r.status = 'on-track';
            }
        });

        const overallStatus = rows.some(r => r.status === 'behind') ? 'behind'
            : rows.some(r => r.status === 'catching-up') ? 'catching-up' : 'on-track';

        return { age, rows, overallStatus };
    }

    // Weeks to train a skill from its current level up to a target min,
    // using the same per-week gain model as the training sim. Assumes the
    // player trains rested (fatiguePenalty 0, like the simulation baseline)
    // at the full squad size (no overcrowding penalty) — a tractable
    // best-case for "can they close this gap this year". Conservative
    // scaling: each level costs the full 1000 points from the TOP of the
    // current level (the same assumption as weeksToNextLevel). Returns null
    // when the gain can't be estimated (the caller treats that as infeasible
    // / behind).
    function weeksToTrainSkill(programKey, skillKey, value, min, player, academySpeed) {
        const gain = estimateWeeklyTrainingGain(programKey, player, academySpeed, { fatiguePenalty: 0, squadSizePenalty: 1 });
        if (!gain) return null;
        const weekly = gain[skillKey];
        if (!weekly || weekly <= 0) return null;
        const levels = Math.max(0, min - value);
        if (levels <= 0) return 0;
        return levels * weeksToNextLevel(weekly);
    }

    // ============================================================
    // HELPER FUNCTIONS
    // ============================================================

    /**
     * Escape text that will be interpolated into innerHTML.
     *
     * SECURITY — this is not theoretical. Player names are chosen by
     * other users (the game has a Rename Player page), and this script
     * reads them off pages full of OTHER people's players: transfer
     * search results, opponent squads, the youth recruit table. The
     * game renders those names safely, so `.textContent` hands us the
     * raw string — but every render site here then interpolates it into
     * `innerHTML` (~80 assignments, none previously escaped). A player
     * named `<img src=x onerror=...>` would therefore execute script in
     * the page's own origin on an authenticated session — i.e. able to
     * act as the user (list players, accept transfers, send mail).
     * Classic safe-source/unsafe-sink.
     *
     * Applied at the PARSER level rather than at each of the ~80 render
     * sites: the surface is small and auditable (a handful of scrape
     * points below), it can't be forgotten when a new render site is
     * added, and player names are display-only here — nothing compares
     * or matches on them (verified), so escaping early is behaviour-safe.
     */
    function escapeHtml(text) {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function parseSkill(text) {
        if (!text) return 0;
        const clean = text.replace(/<[^>]+>/g, '').trim().toLowerCase();
        return SKILL_MAP[clean] !== undefined ? SKILL_MAP[clean] : 0;
    }

    function parseFatigue(text) {
        if (!text) return 5;
        const clean = text.trim().toLowerCase();
        return FATIGUE_MAP[clean] !== undefined ? FATIGUE_MAP[clean] : 5;
    }

    function skillLabel(score) {
        return SKILL_LABELS[Math.round(score)] || `Lvl ${Math.round(score)}`;
    }

    function detectPageType() {
        if (window.location.href.includes('seniors.htm') || window.location.href.includes('youths.htm')) {
            return 'squad';
        }
        // CRITICAL: this game sets match tactics on game.htm?gameId=...,
        // NOT on an "orders.htm" page (that URL doesn't appear to exist
        // on this game at all). Both patterns are matched here so the
        // tactics advisor actually loads on the real page.
        if (window.location.href.includes('orders.htm') ||
            (window.location.href.includes('game.htm') && /[?&]gameId=/.test(window.location.href))) {
            return 'orders';
        }
        if (window.location.href.includes('training.htm')) {
            return 'training';
        }
        if (window.location.href.includes('ground.htm')) {
            return 'ground';
        }
        if (window.location.href.includes('teamfixtures.htm')) {
            return 'matches';
        }
        if (window.location.href.includes('academies.htm')) {
            return 'academy';
        }
        if (window.location.href.includes('youthrecruit.htm')) {
            return 'youthrecruit';
        }
        if (window.location.href.includes('finances.htm')) {
            return 'finance';
        }
        if (window.location.href.includes('transfer.htm') && !window.location.href.includes('teamtransfers') && !window.location.href.includes('currenttransfers')) {
            return 'transfer';
        }
        if (window.location.href.includes('club.htm')) {
            return 'club';
        }
        if (window.location.href.includes('player.htm')) {
            return 'player';
        }
        return 'other';
    }

    // ============================================================
    // CENTRALIZED DATA MANAGEMENT
    // ============================================================
    function isStale(timestampKey, maxHours) {
        try {
            const ts = parseInt(GM_getValue(timestampKey, '0'));
            if (!ts) return true;
            const ageMs = Date.now() - ts;
            const ageHours = ageMs / (1000 * 60 * 60);
            return ageHours > maxHours;
        } catch (e) {
            return true;
        }
    }

    function getDataAgeText(timestampKey) {
        try {
            const ts = parseInt(GM_getValue(timestampKey, '0'));
            if (!ts) return 'Never';
            const ageMs = Date.now() - ts;
            const ageMins = Math.floor(ageMs / (1000 * 60));
            const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
            const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            if (ageMins < 1) return 'Just now';
            if (ageMins < 60) return `${ageMins}m ago`;
            if (ageHours < 24) return `${ageHours}h ago`;
            if (ageDays === 1) return 'Yesterday';
            return `${ageDays}d ago`;
        } catch (e) {
            return 'Unknown';
        }
    }

    // ── Generic cache helpers ──────────────────────────────────
    function _saveCache(dataKey, tsKey, data) {
        try {
            GM_setValue(dataKey, JSON.stringify(data));
            GM_setValue(tsKey, Date.now().toString());
        } catch (e) {
            console.error('[FTP Advisor] Cache save failed:', e);
        }
    }

    function _loadCacheWithAge(dataKey, tsKey) {
        try {
            const raw = GM_getValue(dataKey, null);
            const timestamp = parseInt(GM_getValue(tsKey, '0'));
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const ageMs = Date.now() - timestamp;
            const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
            const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            return { parsed, timestamp, ageHours, ageDays };
        } catch (e) {
            return null;
        }
    }

    function _loadCacheRaw(dataKey) {
        try {
            const raw = GM_getValue(dataKey, null);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    // ── Squad cache (senior + youth) ──────────────────────────
    function savePlayerCache(players) { _saveCache(CACHE_KEY, CACHE_TIMESTAMP_KEY, players); }
    function loadPlayerCache() {
        const r = _loadCacheWithAge(CACHE_KEY, CACHE_TIMESTAMP_KEY);
        return r ? { players: r.parsed, timestamp: r.timestamp, ageHours: r.ageHours, ageDays: r.ageDays } : null;
    }

    // ── Opponent cache (per-teamId, 24h TTL) ─────────────────
    const OPPONENT_TTL_HOURS = 24;

    function saveOpponentCache(teamId, players) {
        _saveCache(OPPONENT_CACHE_PREFIX + teamId, OPPONENT_TIMESTAMP_PREFIX + teamId, players);
        cleanupOldOpponentCaches(teamId);
    }

    function loadOpponentCache(teamId) {
        const r = _loadCacheWithAge(OPPONENT_CACHE_PREFIX + teamId, OPPONENT_TIMESTAMP_PREFIX + teamId);
        if (!r) return null;
        if (r.ageHours >= OPPONENT_TTL_HOURS) {
            cleanupOpponentCache(teamId);
            return null;
        }
        return { players: r.parsed, timestamp: r.timestamp, ageHours: r.ageHours, ageDays: r.ageDays, teamId };
    }

    function cleanupOpponentCache(teamId) {
        GM_deleteValue(OPPONENT_CACHE_PREFIX + teamId);
        GM_deleteValue(OPPONENT_TIMESTAMP_PREFIX + teamId);
    }

    function cleanupOldOpponentCaches(keepTeamId) {
        const keepDataKey = OPPONENT_CACHE_PREFIX + keepTeamId;
        const keepTsKey = OPPONENT_TIMESTAMP_PREFIX + keepTeamId;
        const prefix = OPPONENT_CACHE_PREFIX;
        const tsPrefix = OPPONENT_TIMESTAMP_PREFIX;
        for (const key of GM_listValues()) {
            if (key === keepDataKey || key === keepTsKey) continue;
            if (key.startsWith(prefix) || key.startsWith(tsPrefix)) {
                GM_deleteValue(key);
            }
        }
    }

    // ── Academy / Finance / Ground caches ─────────────────────
    function saveAcademyCache(info) { _saveCache(ACADEMY_CACHE_KEY, ACADEMY_TIMESTAMP_KEY, info); }
    function loadAcademyCache() { return _loadCacheRaw(ACADEMY_CACHE_KEY); }
    function saveFinanceCache(info) { _saveCache(FINANCE_CACHE_KEY, FINANCE_TIMESTAMP_KEY, info); }
    function loadFinanceCache() { return _loadCacheRaw(FINANCE_CACHE_KEY); }
    function saveGroundCache(info) { _saveCache(GROUND_CACHE_KEY, GROUND_TIMESTAMP_KEY, info); }
    function loadGroundCache() { return _loadCacheRaw(GROUND_CACHE_KEY); }

    // ── Team info cache (supporters, mood, division) ──────────
    const TEAM_INFO_CACHE_KEY = 'ftp_team_info';
    const TEAM_INFO_TIMESTAMP_KEY = 'ftp_team_info_ts';
    function saveTeamInfoCache(info) { _saveCache(TEAM_INFO_CACHE_KEY, TEAM_INFO_TIMESTAMP_KEY, info); }
    function loadTeamInfoCache() { return _loadCacheRaw(TEAM_INFO_CACHE_KEY); }

    function getCacheAgeText(ageDays) {
        if (ageDays === 0) return 'Today';
        if (ageDays === 1) return 'Yesterday';
        if (ageDays < 7) return `${ageDays}d ago`;
        if (ageDays < 14) return `${ageDays}d ago (stale)`;
        return `${ageDays}d ago (very stale!)`;
    }

    // ── Confidence scoring ──────────────────────────────────────
    // Returns { level: 'high'|'medium'|'low', label, reasons[] }
    // based on data freshness, skill completeness, and context info.
    function computeConfidence(opts) {
        const reasons = [];
        let score = 0; // 0-100

        // Data freshness (0-40 pts)
        if (opts.cacheAgeHours != null) {
            if (opts.cacheAgeHours < 2) { score += 40; }
            else if (opts.cacheAgeHours < 6) { score += 30; reasons.push('Squad data ' + opts.cacheAgeHours + 'hr old'); }
            else if (opts.cacheAgeHours < 24) { score += 15; reasons.push('Squad data ' + opts.cacheAgeHours + 'hr old — re-scrape for best accuracy'); }
            else { score += 5; reasons.push('Squad data ' + Math.floor(opts.cacheAgeHours / 24) + 'd+ old — refresh recommended'); }
        } else {
            score += 10; reasons.push('No squad cache timestamp available');
        }

        // Skill completeness (0-30 pts)
        if (opts.playersWithSkills != null && opts.totalPlayers != null) {
            const ratio = opts.totalPlayers > 0 ? opts.playersWithSkills / opts.totalPlayers : 0;
            if (ratio >= 0.9) { score += 30; }
            else if (ratio >= 0.6) { score += 20; reasons.push(`${opts.playersWithSkills}/${opts.totalPlayers} players have full skill data`); }
            else if (ratio >= 0.3) { score += 10; reasons.push(`Only ${opts.playersWithSkills}/${opts.totalPlayers} have skill data — some recs may be incomplete`); }
            else { score += 0; reasons.push(`Few players have skill data (${opts.playersWithSkills}/${opts.totalPlayers})`); }
        } else {
            score += 15; // unknown — don't penalize too hard
        }

        // Context info (0-20 pts)
        if (opts.hasAcademyInfo) { score += 10; } else { reasons.push('Academy level unknown'); }
        if (opts.hasFinanceInfo) { score += 5; } else { reasons.push('Finances not cached'); }
        if (opts.hasOpponentData) { score += 5; } else { reasons.push('No opponent data — tactical recs are generic'); }

        // Match type awareness (0-10 pts)
        if (opts.matchTypeKnown) { score += 10; } else { reasons.push('Match format unknown — using defaults'); }

        let level, label;
        if (score >= 70) { level = 'high'; label = 'High confidence'; }
        else if (score >= 40) { level = 'medium'; label = 'Moderate confidence'; }
        else { level = 'low'; label = 'Low confidence'; }

        return { level, label, score, reasons };
    }

    function renderConfidenceBadge(conf) {
        const colorMap = { high: 'green', medium: 'amber', low: 'red' };
        const iconMap = { high: '\u2705', medium: '\u26A0', low: '\u26A0\uFE0F' };
        return `<span class="ftp-stat-badge ${colorMap[conf.level]}" title="${conf.reasons.join('; ')}" style="font-size:9px;cursor:help;">${iconMap[conf.level]} ${conf.label} (${conf.score}%)</span>`;
    }

    // ============================================================
    // CENTRALIZED DATA FETCHERS
    // ============================================================
    // Your own squad page (squadViewId=2 grid view) shows the full
    // 9-column skill breakdown: endurance, batting, bowling, technique,
    // power, keeping, fielding, captaincy, experience — each tagged
    // td.skills, in that fixed order.
    function parsePlayerRow(row) {
        const nameLink = row.querySelector('a.player');
        if (!nameLink) return null;
        const playerId = nameLink.href.match(/playerId=(\d+)/)?.[1];
        const name = escapeHtml(nameLink.textContent.trim());
        const bowlerTypeSpan = row.querySelector('span.bowlerType');
        const bowlerType = bowlerTypeSpan ? bowlerTypeSpan.textContent.trim() : '';
        const skillCells = row.querySelectorAll('td.skills');
        const fatigueCell = row.querySelector('td.fatigue');
        const formCell = row.querySelector('td.form');
        const cells = row.querySelectorAll('td');
        const isLeftHanded = false;
        let age = 99;
        for (const cell of cells) {
            const text = cell.textContent.trim();
            // "YY.WW" — weeks (1-14 of 14/age-year, 1-based since v8.64: the
            // 14th week is the last week of that age, not the next year).
            // parseGameAge() converts correctly; the bare-integer regex
            // still gates which cell is actually the age column.
            const m = text.match(/^(\d{1,2})(?:\.\d{1,2})?$/);
            if (m) {
                const val = parseInt(m[1], 10);
                if (val >= 16 && val <= 50) { age = parseGameAge(text); break; }
            }
        }

        return {
            id: playerId, name: name,
            bowlerType: bowlerType,
            bowlerCategory: BOWLER_CATEGORY[bowlerType] || 'none',
            bowlerPace: BOWLER_PACE[bowlerType] || 0,
            isLeftHanded: isLeftHanded, age: age,
            // Was hardcoded true regardless of whether skillCells actually
            // matched anything — a page that isn't the grid view (e.g. the
            // Overall Summary view, squadViewId=1, which the default squad
            // nav link with no squadViewId param can land on) has no
            // td.skills cells at all, so every stat below silently reads
            // as 0 while this claimed "full skills" anyway. Now reflects
            // reality: the grid has 9 skill columns.
            hasFullSkills: skillCells.length >= 9,
            endurance: parseSkill(skillCells[0]?.textContent),
            batting: parseSkill(skillCells[1]?.textContent),
            bowling: parseSkill(skillCells[2]?.textContent),
            technique: parseSkill(skillCells[3]?.textContent),
            power: parseSkill(skillCells[4]?.textContent),
            keeping: parseSkill(skillCells[5]?.textContent),
            fielding: parseSkill(skillCells[6]?.textContent),
            captaincy: parseSkill(skillCells[7]?.textContent),
            experience: parseSkill(skillCells[8]?.textContent),
            fatigue: parseFatigue(fatigueCell?.textContent),
            form: parseSkill(formCell?.textContent),
            isSenior: row.classList.contains('senior'),
            isYouth: row.classList.contains('youth')
        };
    }

    // Opponent squad pages (viewing another team's seniors.htm/youths.htm)
    // expose a deliberately reduced, DIFFERENT column set — confirmed
    // against live markup from a scouted opponent (team 1904):
    // Player · Age · Nat · BT · Exp · Fatg · Form · Wage · Rating.
    // Batting/bowling/technique/power/keeping/fielding/captaincy are not
    // shown at all — this is the game's scouting limitation, not a
    // scraping gap. Note the ONE td.skills cell here is Experience, not
    // Endurance like on your own squad page — reusing parsePlayerRow's
    // fixed skillCells[0..8] mapping against this markup silently
    // returned 0 players for every opponent (skillCells.length was never
    // 9). This parser targets the actual reduced layout directly.
    function parseOpponentPlayerRow(row) {
        const nameLink = row.querySelector('a.player');
        if (!nameLink) return null;
        const playerId = nameLink.href.match(/playerId=(\d+)/)?.[1];
        const name = escapeHtml(nameLink.textContent.trim());
        const bowlerTypeSpan = row.querySelector('span.bowlerType');
        const bowlerType = bowlerTypeSpan ? bowlerTypeSpan.textContent.trim() : '';
        const experienceCell = row.querySelector('td.skills');
        const fatigueCell = row.querySelector('td.fatigue');
        const formCell = row.querySelector('td.form');
        const cells = row.querySelectorAll('td');

        let age = 99, wage = 0, rating = 0;
        cells.forEach(cell => {
            const text = cell.textContent.trim();
            const ageMatch = text.match(/^(\d{1,2})(?:\.\d+)?$/);
            const wageMatch = text.match(/^\$([\d,]+)/);
            const ratingMatch = text.match(/^([\d,]{4,})$/);
            if (ageMatch) {
                const val = parseInt(ageMatch[1], 10);
                if (val >= 16 && val <= 50 && age === 99) age = parseGameAge(text);
            } else if (wageMatch) {
                wage = parseInt(wageMatch[1].replace(/,/g, ''), 10) || 0;
            } else if (ratingMatch) {
                rating = parseInt(ratingMatch[1].replace(/,/g, ''), 10) || 0;
            }
        });

        return {
            id: playerId, name: name,
            bowlerType: bowlerType,
            bowlerCategory: BOWLER_CATEGORY[bowlerType] || 'none',
            bowlerPace: BOWLER_PACE[bowlerType] || 0,
            isLeftHanded: false, age: age,
            hasFullSkills: false,
            wage: wage, rating: rating,
            endurance: 0, batting: 0, bowling: 0, technique: 0, power: 0,
            keeping: 0, fielding: 0, captaincy: 0,
            experience: parseSkill(experienceCell?.textContent),
            fatigue: parseFatigue(fatigueCell?.textContent),
            form: parseSkill(formCell?.textContent),
            isSenior: row.classList.contains('senior'),
            isYouth: row.classList.contains('youth')
        };
    }

    function fetchSquadFromPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: function(response) {
                    if (response.status === 200) {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');
                        const players = [];

                        // Try multiple selectors — opponent pages may use different table structures
                        let rows = doc.querySelectorAll('table#squad tbody tr');
                        if (rows.length === 0) rows = doc.querySelectorAll('table#squad tr');
                        if (rows.length === 0) rows = doc.querySelectorAll('table.squad tbody tr');
                        if (rows.length === 0) rows = doc.querySelectorAll('table.data tbody tr');
                        // Fallback: any table with player links
                        if (rows.length === 0) {
                            const allTables = doc.querySelectorAll('table');
                            for (const table of allTables) {
                                const links = table.querySelectorAll('a[href*="player.htm"]');
                                if (links.length >= 3) {
                                    rows = table.querySelectorAll('tbody tr');
                                    if (rows.length === 0) rows = table.querySelectorAll('tr');
                                    break;
                                }
                            }
                        }

                        rows.forEach(row => {
                            if (!row.querySelector('td')) return;
                            // Own-team pages have 9 td.skills cells (full
                            // breakdown); opponent pages have exactly 1
                            // (Experience only) — auto-detect per row so
                            // this works for both without needing the
                            // caller to know which kind of page it is.
                            const hasFullSkillGrid = row.querySelectorAll('td.skills').length >= 9;
                            const p = hasFullSkillGrid ? parsePlayerRow(row) : parseOpponentPlayerRow(row);
                            if (p) players.push(p);
                        });
                        resolve(players);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(err) { reject(err); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    /**
     * Parses one player block from a squadViewId=1 ("Overall Summary")
     * page — a fundamentally different DOM shape than the squadViewId=2
     * grid table (parsePlayerRow/parseOpponentPlayerRow): one
     * <div class="padded senior|youth"> per player, not a <tr>.
     * Confirmed via real HTML from both the user's own squad AND an
     * opponent's squad: THIS view exposes Talents (span.popuphelp,
     * title="Name|Description") for BOTH — the grid view used
     * everywhere else never has talents at all, for anyone. Own-squad
     * blocks additionally include a skills table with each player's
     * current training program; opponent blocks only have the two info
     * <p> lines (no skill numbers — same opponent-scouting limitation
     * documented elsewhere, this view doesn't lift it).
     */
    function parseSummaryViewBlock(block) {
        const nameLink = block.querySelector('h3 a');
        if (!nameLink) return null;
        const playerId = (nameLink.href.match(/playerId=(\d+)/) || [])[1];
        // Opponent pages prefix the name with a squad number ("01. Name")
        const name = escapeHtml(nameLink.textContent.replace(/^\d+\.\s*/, '').trim());

        const ps = block.querySelectorAll(':scope > p');
        const infoText = ps[0] ? ps[0].textContent : '';
        const statsText = ps[1] ? ps[1].textContent : '';

        const ageMatch = infoText.match(/(\d+)\s*years?\s*(\d+)\s*weeks?\s*old/i);
        // Routed through the shared parser so it stays on the same 1-based
        // (week-1)/14 convention as every other age scrape (v8.64) — an
        // inline duplicate here previously drifted to weeks/14.
        const age = ageMatch ? parseGameAge(ageMatch[0]) : 0;
        const ratingMatch = infoText.match(/([\d,]+)\s*rating/i);
        const rating = ratingMatch ? parseInt(ratingMatch[1].replace(/,/g, ''), 10) : 0;
        const wageMatch = infoText.match(/\$([\d,]+)\s*wage/i);
        const wage = wageMatch ? parseInt(wageMatch[1].replace(/,/g, ''), 10) : 0;
        const isLeftHanded = /left hand batsman/i.test(infoText);

        let bowlerType = '';
        for (const [re, code] of BOWLER_TYPE_PHRASES) {
            if (re.test(infoText)) { bowlerType = code; break; }
        }

        const talents = [];
        block.querySelectorAll('span.popuphelp').forEach(span => {
            const title = span.getAttribute('title') || '';
            // Escaped for the same reason as names — talent text is
            // rendered into innerHTML downstream, and this reads other
            // teams' players too. Talent MATCHING is all regex-based
            // (/prodigy/i etc) on ASCII words, which entity-escaping
            // leaves untouched, so scoring is unaffected.
            const t = escapeHtml(title.split('|')[0].trim());
            if (t) talents.push(t);
        });

        const expMatch = statsText.match(/([a-z]+)\s*experience/i);
        const formMatch = statsText.match(/([a-z]+)\s*form/i);
        const fatigueMatch = statsText.match(/([a-z]+)\s*fatigue/i);
        const captMatch = statsText.match(/([a-z]+)\s*captaincy/i);

        const player = {
            id: playerId, name, age, rating, wage,
            isLeftHanded, bowlerType,
            bowlerCategory: BOWLER_CATEGORY[bowlerType] || 'none',
            bowlerPace: BOWLER_PACE[bowlerType] || 0,
            talents,
            experience: expMatch ? parseSkill(expMatch[1]) : 0,
            form: formMatch ? parseSkill(formMatch[1]) : 0,
            fatigue: fatigueMatch ? parseFatigue(fatigueMatch[1]) : 0,
            captaincy: captMatch ? parseSkill(captMatch[1]) : 0,
            isSenior: block.classList.contains('senior'),
            isYouth: block.classList.contains('youth'),
            hasFullSkills: false,
            batting: 0, bowling: 0, keeping: 0, technique: 0, power: 0, fielding: 0, endurance: 0,
            currentTraining: null
        };

        // Own-squad blocks additionally have a skills table with a
        // "Training" cell (current training program).
        const skillsTable = block.querySelector('table.data');
        if (skillsTable) {
            const skillLabelMap = { batting: 'batting', bowling: 'bowling', keeping: 'keeping', technique: 'technique', power: 'power', fielding: 'fielding', endurance: 'endurance' };
            let found = 0;
            skillsTable.querySelectorAll('th').forEach(th => {
                const label = th.textContent.trim().toLowerCase();
                const td = th.nextElementSibling;
                if (!td || td.tagName !== 'TD') return;
                if (label === 'training') {
                    player.currentTraining = td.textContent.trim();
                } else if (skillLabelMap[label]) {
                    player[skillLabelMap[label]] = parseSkill(td.textContent.trim().toLowerCase());
                    found++;
                }
            });
            player.hasFullSkills = found >= 5;
        }

        return player;
    }

    function scrapeSummaryView(doc) {
        const blocks = doc.querySelectorAll('#standardsummary .padded');
        const players = [];
        blocks.forEach(b => {
            const p = parseSummaryViewBlock(b);
            if (p) players.push(p);
        });
        return players;
    }

    // One retry on failure before giving up. Talents only come from this
    // view (squadViewId=1) — a single dropped request used to silently
    // wipe every player's talents for that refresh (mergeTalentsIntoPlayers
    // had nothing to merge), making tactics recommendations flap between
    // visits purely from network flakiness, not real squad/opponent changes.
    function fetchSquadSummaryView(url, _isRetry) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: (response) => {
                    if (response.status !== 200) {
                        if (!_isRetry) { resolve(fetchSquadSummaryView(url, true)); return; }
                        resolve([]); return;
                    }
                    try {
                        const doc = new DOMParser().parseFromString(response.responseText, 'text/html');
                        resolve(scrapeSummaryView(doc));
                    } catch (e) {
                        if (!_isRetry) { resolve(fetchSquadSummaryView(url, true)); return; }
                        resolve([]);
                    }
                },
                onerror: () => { if (!_isRetry) resolve(fetchSquadSummaryView(url, true)); else resolve([]); },
                ontimeout: () => { if (!_isRetry) resolve(fetchSquadSummaryView(url, true)); else resolve([]); }
            });
        });
    }

    /**
     * Merges Talents (and current training, where available) from a
     * squadViewId=1 fetch into the squadViewId=2-sourced player objects
     * that carry the full skill grid — combining the two views' data
     * rather than picking one over the other, since neither alone is
     * complete (grid has skills but no talents; summary has talents
     * but only own-squad has skills).
     */
    function mergeTalentsIntoPlayers(players, summaryPlayers) {
        const byId = new Map(summaryPlayers.map(p => [p.id, p]));
        players.forEach(p => {
            const s = byId.get(p.id);
            if (!s) return;
            p.talents = s.talents;
            if (s.currentTraining) p.currentTraining = s.currentTraining;
            if (s.isLeftHanded) p.isLeftHanded = true;
            // Wage and rating are scraped here (parseSummaryViewBlock) but
            // were never actually copied onto the main squad player object
            // — parsePlayerRow (the grid view used for the squad cache)
            // doesn't scrape either field at all. That silently meant
            // p.wage/p.rating were always 0/undefined for your OWN squad
            // everywhere they're used (sell-list rating comparison, any
            // skill-per-$ value metric) despite being fetched right here.
            if (s.wage != null && s.wage > 0) p.wage = s.wage;
            if (s.rating != null && s.rating > 0) p.rating = s.rating;
        });
    }

    function fetchAcademyFromPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: function(response) {
                    if (response.status === 200) {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');
                        const info = parseAcademyDoc(doc);
                        resolve(info);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(err) { reject(err); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    // Academy level names and costs (Season 52+ — single academy system)
    const ACADEMY_LEVELS = [
        { name: 'minimal',    num: 0,  cost: 10000,  label: 'Minimal' },
        { name: 'meagre',     num: 1,  cost: 20000,  label: 'Meagre' },
        { name: 'inadequate', num: 2,  cost: 32000,  label: 'Inadequate' },
        { name: 'reasonable', num: 3,  cost: 46000,  label: 'Reasonable' },
        { name: 'satisfactory', num: 4, cost: 62000, label: 'Satisfactory' },
        { name: 'good',       num: 5,  cost: 80000,  label: 'Good' },
        { name: 'excellent',  num: 6,  cost: 102000, label: 'Excellent' },
        { name: 'superior',   num: 7,  cost: 126000, label: 'Superior' },
        { name: 'lavish',     num: 8,  cost: 152000, label: 'Lavish' },
        { name: 'luxurious',  num: 9,  cost: 180000, label: 'Luxurious' },
        { name: 'deluxe',     num: 10, cost: 210000, label: 'Deluxe' }
    ];

    // Training speed multiplier per academy level. Previously an
    // estimate ([0.55...1.5], deluxe = 2.7x minimal) that the user
    // confirmed against their own live Academy page does NOT match
    // what the game actually shows. Replaced with the verified curve
    // from FTP_Training 5.2.xlsx's DB!AK598:AL608 table (looked up by
    // exact academy name, not a guess): a clean 1 + 0.03 per level,
    // minimal = 1.0x baseline, deluxe = 1.3x. Index 0 = minimal,
    // index 10 = deluxe, matching ACADEMY_LEVELS' `num` field.
    const ACADEMY_SPEED = [1.00, 1.03, 1.06, 1.09, 1.12, 1.15, 1.18, 1.21, 1.24, 1.27, 1.30];

    // Multi-week training projections assume the academy improves over
    // the horizon (the user WILL keep upgrading it — the live-scraped
    // "Training Efficiency %" rises as the level does, which is why a
    // better academy tomorrow must make a player's projected rating
    // higher). The sim ramps each week's academy speed linearly from
    // today's scraped value toward Deluxe (ACADEMY_SPEED[10] = max)
    // over this many REAL years from the plan's start. Set to 0 to
    // freeze the academy at its current level. The game exposes no
    // upgrade schedule or pace, so 5 years is a tunable assumption,
    // not a sourced number.
    const ACADEMY_RAMP_YEARS = 5;

    /**
     * Real, age-appropriate training speed for a specific player.
     * Prefers the game's own directly-displayed "Senior/Youth Training
     * Efficiency %" (scraped from the Academy page, parseAcademyDoc)
     * over the derived ACADEMY_SPEED curve above — it's live per-team
     * data straight from the source, not an estimate, and critically
     * it's the correct AGE-SPECIFIC figure. The official game manual
     * (rules.htm?rulespage=training) confirms senior and youth academy
     * effectiveness are tracked separately by the game itself; a single
     * ACADEMY_SPEED curve applied to every age (as this script did
     * before) can never capture that distinction, only ACADEMY_SPEED's
     * derived level-based estimate can, as a fallback before the
     * Academy page has ever been visited/cached.
     */
    function getAcademySpeedForPlayer(player, academyInfo) {
        if (academyInfo) {
            const isYouthPlayer = (player.age || 0) < 21;
            const liveEfficiency = isYouthPlayer ? academyInfo.youthEfficiency : academyInfo.seniorEfficiency;
            if (liveEfficiency != null) return liveEfficiency / 100;
        }
        return ACADEMY_SPEED[academyInfo ? academyInfo.levelNum : 0] || 1.00;
    }

    // A third age-threshold table (AGE_SKILL_THRESHOLDS) lived here and
    // was never referenced by anything — dead since before v8.x. It
    // overlapped YOUTH_DEV_CURVE (16-20) and AGE_SCOUT_THRESHOLDS ("the
    // base", 16-27) with its own subtly different numbers, i.e. a third
    // competing definition of "good enough for this age" sitting in the
    // file waiting to be wired up by mistake. Removed; the two live
    // tables above are the only ones. Same cleanup as v8.21, which
    // removed the AGE_SKILL_EXPECTATIONS near-duplicate.

    /**
     * Compute squad statistics from cached players to use as dynamic
     * transfer thresholds. Returns averages, minimums, and role-specific
     * stats so we only buy players better than what we already have.
     */
    function computeSquadStats(players) {
        if (!players || players.length === 0) return null;
        const seniors = players.filter(p => p.isSenior && p.age >= 21);
        if (seniors.length === 0) return null;

        const avg = (key) => seniors.reduce((s, p) => s + (p[key] || 0), 0) / seniors.length;
        const min = (key) => Math.min(...seniors.map(p => p[key] || 0));

        // Role-specific: bowlers vs batters vs keepers. Now mutually
        // exclusive via getPrimarySkillInfo() — previously bowlers/batters
        // used a raw bowling>batting comparison while wicketkeepers used a
        // separate keeping>=6 threshold, so a genuine keeper with
        // bowling>batting was silently double-counted as both a bowler
        // AND a keeper. That corrupted any "do we have enough of X" logic
        // built on these counts (role-surplus sell scoring, squad gap
        // warnings). allrounders stays a separate cross-cutting quality
        // tag (batting AND bowling both strong), not a primary-role bucket
        // — a real allrounder still has exactly one primary role above.
        const bowlers = seniors.filter(p => getPrimarySkillInfo(p).name === 'bowling');
        const batters = seniors.filter(p => getPrimarySkillInfo(p).name === 'batting');
        const wicketkeepers = seniors.filter(p => getPrimarySkillInfo(p).name === 'keeping');
        const allrounders = seniors.filter(p => (p.batting || 0) >= 7 && (p.bowling || 0) >= 7);

        // Bowling-attack composition — official manual (rulespage=
        // matchengine): "a balanced bowling attack including a mix of
        // left and right handed spinners and seam bowlers will in general
        // perform slightly better during a match." Counts EVERY senior
        // with a real bowlerType (bowlerCategory !== 'none'), not just
        // primary-role bowlers — a part-time bowling allrounder or keeper
        // still contributes to the attack's actual variety on matchday.
        // Consumed by assessSquadVariety() below (shared by both the
        // youth and senior evaluateTransferTarget() branches, so this
        // doesn't need computing twice).
        const realBowlers = seniors.filter(p => p.bowlerCategory && p.bowlerCategory !== 'none');
        const bowlerTypeCounts = {};
        Object.keys(BOWLER_CATEGORY).forEach(t => { bowlerTypeCounts[t] = 0; });
        realBowlers.forEach(p => { if (bowlerTypeCounts[p.bowlerType] !== undefined) bowlerTypeCounts[p.bowlerType]++; });
        const seamBowlerCount = realBowlers.filter(p => p.bowlerCategory === 'seam').length;
        const spinBowlerCount = realBowlers.filter(p => p.bowlerCategory === 'spin').length;
        const leftArmBowlerCount = realBowlers.filter(p => (p.bowlerType || '').startsWith('l')).length;
        const rightArmBowlerCount = realBowlers.filter(p => (p.bowlerType || '').startsWith('r')).length;
        // Batting-handedness mix — same manual page: "Partnerships involving
        // a left hand and right hand batter will cause a small penalty to
        // be applied to the bowlers" (stated from the bowling side — i.e. a
        // mixed-handedness lineup makes life harder for the OPPONENT'S
        // bowlers, so it's a real asset for your own batting order).
        const leftHandBatCount = seniors.filter(p => p.isLeftHanded).length;
        const rightHandBatCount = seniors.length - leftHandBatCount;

        return {
            count: seniors.length,
            avgRating: Math.round(avg('rating')),
            minRating: min('rating'),
            avgBatting: avg('batting'),
            minBatting: min('batting'),
            avgBowling: avg('bowling'),
            minBowling: min('bowling'),
            avgTechnique: avg('technique'),
            minTechnique: min('technique'),
            avgFielding: avg('fielding'),
            minFielding: min('fielding'),
            avgEndurance: avg('endurance'),
            minEndurance: min('endurance'),
            // getPrimarySkillInfo(), not max(batting, bowling) — a keeper on
            // the squad should contribute their keeping skill here, not
            // whatever mediocre batting/bowling they happen to have, or the
            // "compare candidate to squad avg primary" bonus in
            // evaluateTransferTarget compares a keeper candidate's keeping
            // against a bat/bowl-based average that has nothing to do with
            // their actual role.
            avgPrimary: Math.round(seniors.reduce((s, p) => s + getPrimarySkillInfo(p).value, 0) / seniors.length),
            minPrimary: Math.min(...seniors.map(p => getPrimarySkillInfo(p).value)),
            avgKeep: avg('keeping'),
            bowlerCount: bowlers.length,
            batterCount: batters.length,
            allrounderCount: allrounders.length,
            keeperCount: wicketkeepers.length,
            avgBowlerBowling: bowlers.length > 0 ? Math.round(bowlers.reduce((s, p) => s + (p.bowling || 0), 0) / bowlers.length) : 0,
            avgBatterBatting: batters.length > 0 ? Math.round(batters.reduce((s, p) => s + (p.batting || 0), 0) / batters.length) : 0,
            realBowlerCount: realBowlers.length,
            bowlerTypeCounts,
            seamBowlerCount,
            spinBowlerCount,
            leftArmBowlerCount,
            rightArmBowlerCount,
            leftHandBatCount,
            rightHandBatCount,
        };
    }

    // Squad-variety assessment — official manual (rulespage=matchengine):
    // "a balanced bowling attack including a mix of left and right handed
    // spinners and seam bowlers will in general perform slightly better",
    // and "partnerships involving a left hand and right hand batter [help
    // against] the bowlers" (i.e. a mixed-handedness batting order is an
    // asset). Explicit user request: transfer/youth-recruit evaluation
    // should avoid recommending toward an unbalanced attack (e.g. all
    // finger spin) or an all-one-handed batting order. Deliberately a
    // SMALL nudge (max +/-1), same conservative-estimate philosophy as the
    // unquantified triggered-talent bonuses elsewhere in this file — the
    // manual says "slightly better", not "essential" — and deliberately
    // separate from the existing "Premium bowler type" scoring a few lines
    // below in evaluateTransferTarget() (fast/wrist-spin bowlers command a
    // MARKET premium regardless of squad fit; this function is squad-FIT
    // only, an orthogonal axis — a fast bowler can score well on both, or
    // well on one and poorly on the other, e.g. a 4th fast bowler when the
    // squad already has three). Shared by both the youth and senior
    // evaluateTransferTarget() branches (and, via them, the youth-recruit
    // evaluator) so the two can't independently drift like several other
    // squad-comparison checks in this file already have.
    function assessSquadVariety(player, squadStats) {
        const result = { score: 0, strengths: [], warnings: [] };
        if (!squadStats || squadStats.realBowlerCount === undefined) return result;

        const category = player.bowlerCategory;
        if (category === 'seam' || category === 'spin') {
            const total = squadStats.realBowlerCount;
            // Only worth commenting on once the squad has enough bowlers
            // for "mix" to be a meaningful concept — a 1-2 bowler squad is
            // still being built, not yet unbalanced.
            if (total >= 3) {
                const sameTypeCount = squadStats.bowlerTypeCounts[player.bowlerType] || 0;
                const sameCategoryCount = category === 'seam' ? squadStats.seamBowlerCount : squadStats.spinBowlerCount;
                const otherCategoryCount = category === 'seam' ? squadStats.spinBowlerCount : squadStats.seamBowlerCount;
                // Overall seam/spin balance — the manual-cited mix.
                if (otherCategoryCount === 0 && sameCategoryCount >= 2) {
                    result.score -= 1;
                    result.warnings.push(`Squad has ${sameCategoryCount} ${category} bowlers and zero ${category === 'seam' ? 'spin' : 'seam'} — adds to an already one-dimensional attack`);
                } else if (otherCategoryCount === 0 || sameCategoryCount < otherCategoryCount) {
                    result.score += 1;
                    result.strengths.push(`${category === 'seam' ? 'Seam' : 'Spin'} — squad currently leans ${category === 'seam' ? 'spin' : 'seam'}-heavy, this adds balance`);
                }
                // Exact-type duplication (the user's literal example: "all
                // finger spin or wrist spin") — same category, same arm/
                // style, already 2+ of them.
                if (sameTypeCount >= 2 && sameTypeCount >= Math.ceil(total / 2)) {
                    result.score -= 1;
                    result.warnings.push(`Already ${sameTypeCount} ${player.bowlerType.toUpperCase()} bowlers in the squad (of ${total} total) — limited variety, opponents can prepare for one style`);
                }
                // Arm-side balance within category, only flagged once the
                // squad has enough bowlers of THIS category for it to mean
                // anything (mirrors the seam/spin check's >=3 gate).
                if (sameCategoryCount >= 2) {
                    const isLeftArm = (player.bowlerType || '').startsWith('l');
                    const sameArmCount = isLeftArm ? squadStats.leftArmBowlerCount : squadStats.rightArmBowlerCount;
                    const otherArmCount = isLeftArm ? squadStats.rightArmBowlerCount : squadStats.leftArmBowlerCount;
                    if (otherArmCount === 0 && sameArmCount >= 2) {
                        result.score -= 1;
                        result.warnings.push(`Squad's bowlers are all right/left-arm one-sided — no ${isLeftArm ? 'right' : 'left'}-arm option yet`);
                    }
                }
            }
        }

        // Batting handedness — meaningful for anyone who actually bats
        // (batting or keeping primary); a pure specialist bowler's batting
        // handedness barely matters since they rarely face many balls.
        const primaryName = getPrimarySkillInfo(player).name;
        if (primaryName === 'batting' || primaryName === 'keeping') {
            const total = squadStats.leftHandBatCount + squadStats.rightHandBatCount;
            if (total >= 4) {
                const isLeft = player.isLeftHanded;
                const sameHandCount = isLeft ? squadStats.leftHandBatCount : squadStats.rightHandBatCount;
                const otherHandCount = isLeft ? squadStats.rightHandBatCount : squadStats.leftHandBatCount;
                if (otherHandCount === 0 && sameHandCount >= 4) {
                    result.score -= 1;
                    result.warnings.push(`Batting order is entirely ${isLeft ? 'left' : 'right'}-handed — a mixed order makes life harder for opposition bowlers`);
                } else if (isLeft && sameHandCount < otherHandCount / 3) {
                    result.score += 1;
                    result.strengths.push('Left-handed — squad batting is heavily right-handed, this adds a real mix');
                }
            }
        }

        return result;
    }

    /**
     * Evaluate a transfer target against the user's actual squad.
     * Uses squad averages and minimums as dynamic thresholds.
     * Returns { score, verdict, warnings[], strengths[] }.
     * verdict: 'elite' | 'strong' | 'adequate' | 'weak' | 'poor'
     */
    function evaluateTransferTarget(player, squadStats) {
        const age = ageYears(player.age);
        const warnings = [];
        const strengths = [];
        let score = 0;
        const isYouth = age < 21;

        // ---- YOUTH EVALUATION (16-20) ----
        // Youth are evaluated against age-based curve targets.
        // Only Primary, Technique, Fielding are checked — endurance/experience don't matter
        // ANY skill below target = filtered out
        if (isYouth) {
            // Reuses the same YOUTH_DEV_CURVE / evaluateYouthDevelopment()
            // the Player Advisor and training pages already use, instead
            // of the separate (now-removed) AGE_SKILL_EXPECTATIONS table.
            // The two had drifted into near-duplicates with small,
            // unintentional differences (e.g. fielding target 8 vs 7 at
            // age 20) — one canonical curve now, not two to keep in sync.
            const ydEval = evaluateYouthDevelopment(player);
            if (ydEval) {
                // Same "known" reasoning as checkScoutBenchmark: a real 0
                // across the board almost always means the column didn't
                // scrape/map, not a genuine Atrocious youth prospect —
                // evaluateYouthDevelopment() has no such gate since its
                // other caller (Player Advisor) always has real scraped
                // data, so it's applied here at the call site instead.
                const belowSkills = ydEval.rows.filter(r => r.status === 'behind' && r.value > 0);

                // ANY skill below target = filtered out
                if (belowSkills.length > 0) {
                    score = -5;
                    belowSkills.forEach(r => warnings.push(`${r.label} ${skillLabel(r.value)} — below age ${age} target ${skillLabel(r.min)}`));
                    warnings.push(`${belowSkills.length} skill${belowSkills.length > 1 ? 's' : ''} below age ${age} targets — filtered`);
                } else {
                    score += 3;
                    // A below-target stat that's only 'catching-up' (can still
                    // reach the target this age-year) isn't "meeting targets"
                    // yet — say so honestly rather than the misleading "All
                    // skills meet age X targets". Only genuinely-behind rows
                    // (status === 'behind') filter the candidate out above.
                    const catchingUp = ydEval.rows.filter(r => r.status === 'catching-up');
                    if (catchingUp.length > 0) {
                        strengths.push(`Within reach of age ${age} targets by age end (${catchingUp.map(r => `${r.label.replace(/\s*\(.*\)/, '')} ${skillLabel(r.value)}→${skillLabel(r.min)}`).join(', ')})`);
                    } else {
                        strengths.push(`All skills meet age ${age} targets`);
                    }
                    const aheadCount = ydEval.rows.filter(r => r.value > 0 && r.status === 'ahead').length;
                    if (aheadCount >= 3) {
                        score += 3;
                        strengths.push(`${aheadCount} skills well above target — exceptional prospect`);
                    } else if (aheadCount >= 2) {
                        score += 2;
                        strengths.push(`${aheadCount} skills above target — strong prospect`);
                    } else if (aheadCount >= 1) {
                        score += 1;
                        strengths.push(`${aheadCount} skill(s) above target — promising`);
                    }
                }
            }

            // Youth age bonus: younger = more development time
            if (age <= 17) { score += 2; strengths.push(`Age ${age} — 3+ years of youth development remaining`); }
            else if (age <= 18) { score += 1; strengths.push(`Age ${age} — 2 years of youth development remaining`); }
            else if (age === 19) { /* neutral — 1 year left */ }
            else if (age === 20) { score -= 1; warnings.push(`Age ${age} — final youth year, limited development time`); }

            // Talent bonuses — training talents matter MORE for youth.
            // Role-gated the same way as the senior branch below (added
            // here to match — this branch previously gave Gifted(Batting/
            // Bowling) and New/Old Ball Bowler/Opener/Finisher full credit
            // regardless of the player's actual role, which the senior
            // branch already got right). A mismatched role-specific
            // talent counts for nothing, same as not having it.
            const talents = player.talents || [];
            const hasTalent = (regex) => talents.some(t => regex.test(t));
            const primaryName = getPrimarySkillInfo(player).name;
            const battingRelevant = primaryName === 'batting' || primaryName === 'keeping';
            if (hasTalent(/prodigy/i)) { score += 4; strengths.push('Prodigy — trains ALL skills faster (HIGH VALUE at this age)'); }
            if (hasTalent(/gifted.*batting/i)) {
                if (battingRelevant) { score += 2; strengths.push('Gifted (Batting) — trains batting faster'); }
                else warnings.push('Gifted (Batting) present but primary role is ' + primaryName + ' — limited practical value');
            }
            if (hasTalent(/gifted.*bowling/i)) {
                if (primaryName === 'bowling') { score += 2; strengths.push('Gifted (Bowling) — trains bowling faster'); }
                else warnings.push('Gifted (Bowling) present but primary role is ' + primaryName + ' — limited practical value');
            }
            if (hasTalent(/gifted.*technique/i)) { score += 2; strengths.push('Gifted (Technique) — trains technique faster'); }
            if (hasTalent(/gifted.*fielding/i)) { score += 1; strengths.push('Gifted (Fielding) — trains fielding faster'); }
            if (hasTalent(/gifted.*endurance/i)) { score += 1; strengths.push('Gifted (Endurance) — trains endurance faster'); }
            if (hasTalent(/gifted.*power/i) && battingRelevant) { score += 1; strengths.push('Gifted (Power) — trains power faster'); }
            if (hasTalent(/natural leader/i)) { score += 1; strengths.push('Natural Leader — captaincy bonus'); }
            if (hasTalent(/sturdy/i)) { score += 1; strengths.push('Sturdy — recovers from fatigue faster'); }

            // Role-specific talents (immediate value even for youth)
            if (hasTalent(/new ball bowler/i) && primaryName === 'bowling') { score += 1; strengths.push('New Ball Bowler — opens bowling'); }
            if (hasTalent(/old ball bowler/i) && primaryName === 'bowling') { score += 1; strengths.push('Old Ball Bowler — death overs specialist'); }
            if (hasTalent(/^opener$/i) && battingRelevant) { score += 1; strengths.push('Opener — bats at top of order'); }
            if (hasTalent(/finisher/i) && battingRelevant) { score += 1; strengths.push('Finisher — end-of-innings specialist'); }
            // Batting matchup talents (official manual: "performs better
            // when batting against seam/spin bowlers") — only meaningful
            // for a player whose primary skill is batting.
            if (hasTalent(/seam specialist/i)) {
                if ((player.batting || 0) >= (player.bowling || 0)) { score += 1; strengths.push('Seam Specialist — better batting vs seam'); }
                else warnings.push('Seam Specialist present but primary role is ' + primaryName + ' — a batting matchup talent, rarely triggers');
            }
            if (hasTalent(/spin specialist/i)) {
                if ((player.batting || 0) >= (player.bowling || 0)) { score += 1; strengths.push('Spin Specialist — better batting vs spin'); }
                else warnings.push('Spin Specialist present but primary role is ' + primaryName + ' — a batting matchup talent, rarely triggers');
            }
            // Generic fallback for role-specific talents without their own
            // hand-written strength/warning pair above (Opener, Finisher,
            // Accumulator, Boundary Hitter, New/Old Ball Bowler, the
            // triggered delivery talents) — reuses isTalentRoleAligned(),
            // the same source of truth already driving their scoring in
            // calculateRank()/computePlayerValueSkillSum(), so a mismatch
            // here can't silently drift out of sync with those. Without
            // this, a mismatched Accumulator/Finisher/etc. was previously
            // dropped with zero explanation, unlike Gifted/Skilled
            // (Batting/Bowling) which already explain themselves below.
            const ALREADY_EXPLAINED_TALENTS = /gifted \(batting\)|gifted \(bowling\)|skilled \(batting\)|skilled \(bowling\)/i;
            talents.forEach(t => {
                if (ALREADY_EXPLAINED_TALENTS.test(t)) return;
                if (!isTalentRoleAligned(t, primaryName)) {
                    warnings.push(`${t} present but primary role is ${primaryName} — mismatched, contributes nothing`);
                }
            });

            // Squad variety (bowler-type/handedness mix) — see
            // assessSquadVariety()'s own doc comment for the manual quotes
            // and reasoning. Shared with the senior branch below.
            const variety = assessSquadVariety(player, squadStats);
            score += variety.score;
            strengths.push(...variety.strengths);
            warnings.push(...variety.warnings);

            // "The base" — age-specific primary/technique/experience/
            // fielding minimums (rating for youth). HARD FILTER: must
            // meet 100% or the player is filtered out.
            const scoutCheck = checkScoutBenchmark(player);
            scoutCheck.met.forEach(t => strengths.push(t));

            // Verdict
            let verdict;
            if (score >= 6) verdict = 'elite';
            else if (score >= 3) verdict = 'strong';
            else if (score >= 0) verdict = 'adequate';
            else if (score >= -2) verdict = 'weak';
            else verdict = 'poor';

            if (scoutCheck.hasBenchmark && !scoutCheck.passed) {
                score = Math.min(score, -5);
                verdict = 'poor';
                scoutCheck.failed.forEach(w => warnings.push(w));
                warnings.push(`Does not meet the base for age ${age} — filtered`);
            }
            return { score, verdict, warnings, strengths, rank: 0 };
        }

        // ---- SENIOR EVALUATION (21+) ----
        // Hard minimums for senior transfers (age-dependent):
        //   21-23: Primary Expert, Technique Expert, Fielding Accomplished, Endurance Average, Experience Average
        //   24-27: Primary Expert, Technique Expert, Fielding Accomplished, Endurance Reasonable, Experience Reasonable
        const SENIOR_MINS = age <= 23 ? SENIOR_MINS_YOUNG : SENIOR_MINS_VETERAN;

        const primaryInfo = getPrimarySkillInfo(player);
        const primary = primaryInfo.value;
        const primaryName = primaryInfo.name;

        // Experience is 0 on every transfer-list row until a per-player
        // page fetch fills it in (same gotcha as checkScoutBenchmark below)
        // — hard-filtering on it unconditionally failed EVERY 21+ candidate
        // before "Fetch Experience & Wages" was ever clicked, silently
        // zeroing out the whole senior results list. Gated on `known` so
        // it's skipped (not treated as a fail) until the real value loads,
        // then genuinely enforced afterward.
        // Primary/Technique/Fielding/Endurance are also "known: value > 0" —
        // same reasoning as checkScoutBenchmark's gate: a real 0 across the
        // board almost always means the column didn't scrape/map that row,
        // not a genuine Atrocious senior transfer target.
        const seniorMinChecks = [
            { name: 'Primary', value: primary, min: SENIOR_MINS.primary, known: primary > 0 },
            { name: 'Technique', value: player.technique || 0, min: SENIOR_MINS.technique, known: (player.technique || 0) > 0 },
            { name: 'Fielding', value: player.fielding || 0, min: SENIOR_MINS.fielding, known: (player.fielding || 0) > 0 },
            { name: 'Endurance', value: player.endurance || 0, min: SENIOR_MINS.endurance, known: (player.endurance || 0) > 0 },
            { name: 'Experience', value: player.experience || 0, min: SENIOR_MINS.experience, known: (player.experience || 0) > 0 }
        ];
        // Same as checkScoutBenchmark: a keeper's Primary check above is
        // keeping, not batting — a great keeper who genuinely can't bat
        // should still be filtered, just against a lower bar than keeping.
        if (primaryName === 'keeping') {
            const battingMin = keeperBattingMin(SENIOR_MINS.primary);
            seniorMinChecks.push({ name: 'Batting (WK)', value: player.batting || 0, min: battingMin, known: (player.batting || 0) > 0 });
        }

        const belowMins = seniorMinChecks.filter(s => s.known && s.value < s.min);

        // ANY skill below minimum = filtered out (poor verdict)
        if (belowMins.length > 0) {
            score = -5;
            belowMins.forEach(s => warnings.push(`${s.name} ${skillLabel(s.value)} — below minimum ${skillLabel(s.min)}`));
            warnings.push(`${belowMins.length} skill${belowMins.length > 1 ? 's' : ''} below senior minimums — filtered`);
        } else {
            score += 3;
            strengths.push('All skills meet senior minimums');
        }

        // Compare primary skill against squad
        if (squadStats) {
            if (primary > squadStats.avgPrimary + 2) {
                score += 3; strengths.push(`${primaryName} ${skillLabel(primary)} — well above squad avg (${skillLabel(Math.round(squadStats.avgPrimary))})`);
            } else if (primary > squadStats.avgPrimary) {
                score += 2; strengths.push(`${primaryName} ${skillLabel(primary)} — above squad avg`);
            } else if (primary >= squadStats.minPrimary) {
                score += 0;
            } else {
                score -= 1; warnings.push(`${primaryName} ${skillLabel(primary)} — below squad min (${skillLabel(squadStats.minPrimary)})`);
            }
            if ((player.technique || 0) > squadStats.avgTechnique + 1) {
                score += 2; strengths.push(`Technique ${skillLabel(player.technique)} — significantly above squad avg`);
            } else if ((player.technique || 0) > squadStats.avgTechnique) {
                score += 1; strengths.push(`Technique ${skillLabel(player.technique)} — above squad avg`);
            }
            if ((player.fielding || 0) > squadStats.avgFielding + 1) {
                score += 1; strengths.push(`Fielding ${skillLabel(player.fielding)} — above squad avg`);
            }
            if ((player.endurance || 0) > squadStats.avgEndurance + 1) {
                score += 1; strengths.push(`Endurance ${skillLabel(player.endurance)} — above squad avg`);
            }
        }

        // Talent bonus — comprehensive, role-aware evaluation
        const talents = player.talents || [];
        const hasTalent = (regex) => talents.some(t => regex.test(t));

        // Training talents (long-term value) — less valuable for seniors.
        // Prodigy specifically: the official game manual confirms it
        // trains faster "while in the youth squad" only — zero training
        // benefit once senior, not just "less" — so no score bonus here
        // (a senior scoring well elsewhere isn't helped by a stale Prodigy tag).
        if (hasTalent(/prodigy/i)) { strengths.push('Prodigy (no training benefit now senior, but confirms elite youth potential)'); }
        // Gifted (Batting/Power) only pays off if this player will
        // actually train/use batting — i.e. batting or keeping primary
        // (keepers have a real secondary batting duty, see
        // keeperBattingMin). A specialist bowler with "Gifted (Batting)"
        // is very unlikely to ever prioritise batting training, so the
        // talent is largely wasted on him — same reasoning throughout
        // this block, and the user's own framing: a mismatched role-
        // specific talent is worth the same as no talent at all.
        const battingRelevant = primaryName === 'batting' || primaryName === 'keeping';
        if (hasTalent(/gifted.*batting/i)) {
            if (battingRelevant) { score += 1; strengths.push('Gifted (Batting) — trains batting faster'); }
            else warnings.push('Gifted (Batting) present but primary role is ' + primaryName + ' — limited practical value');
        }
        if (hasTalent(/gifted.*bowling/i)) {
            if (primaryName === 'bowling') { score += 1; strengths.push('Gifted (Bowling) — trains bowling faster'); }
            else warnings.push('Gifted (Bowling) present but primary role is ' + primaryName + ' — limited practical value');
        }
        if (hasTalent(/gifted.*technique/i)) { score += 1; strengths.push('Gifted (Technique) — trains technique faster'); }
        if (hasTalent(/gifted.*fielding/i)) { strengths.push('Gifted (Fielding) — trains fielding faster'); }
        if (hasTalent(/gifted.*endurance/i)) { strengths.push('Gifted (Endurance) — trains endurance faster'); }
        if (hasTalent(/gifted.*power/i) && battingRelevant) { strengths.push('Gifted (Power) — trains power faster'); }

        // Match performance talents (immediate value)
        if (hasTalent(/skilled.*batting/i)) {
            if (battingRelevant) { score += 1; strengths.push('Skilled (Batting) — bonus during matches'); }
            else warnings.push('Skilled (Batting) present but primary role is ' + primaryName + ' — rarely triggers');
        }
        if (hasTalent(/skilled.*bowling/i)) {
            if (primaryName === 'bowling') { score += 1; strengths.push('Skilled (Bowling) — bonus during matches'); }
            else warnings.push('Skilled (Bowling) present but primary role is ' + primaryName + ' — rarely triggers');
        }
        if (hasTalent(/skilled.*technique/i)) { score += 1; strengths.push('Skilled (Technique) — bonus during matches'); }
        if (hasTalent(/skilled.*power/i) && battingRelevant) { score += 1; strengths.push('Skilled (Power) — bonus during matches'); }
        if (hasTalent(/natural leader/i)) { score += 1; strengths.push('Natural Leader — captaincy bonus during matches'); }
        if (hasTalent(/sturdy/i)) { score += 1; strengths.push('Sturdy — recovers from fatigue faster'); }

        // Role-specific talents
        if (hasTalent(/new ball bowler/i) && primaryName === 'bowling') {
            score += 2; strengths.push('New Ball Bowler — performs better at start of innings (open the bowling!)');
        }
        if (hasTalent(/old ball bowler/i) && primaryName === 'bowling') {
            score += 1; strengths.push('Old Ball Bowler — performs better at end of innings');
        }
        if (hasTalent(/^opener$/i) && primaryName === 'batting') {
            score += 2; strengths.push('Opener — performs better batting at the top of the order');
        }
        if (hasTalent(/finisher/i) && primaryName === 'batting') {
            score += 1; strengths.push('Finisher — performs better batting at the end of the innings');
        }
        // Seam/Spin Specialist are BATTING matchup talents (official
        // manual: "performs better than normal when batting against
        // seam/spin bowlers") — only meaningful for a player who
        // actually bats, same gating as Opener/Finisher above.
        if (hasTalent(/seam specialist/i)) {
            if (primaryName === 'batting') { score += 1; strengths.push('Seam Specialist — performs better batting against seam bowling'); }
            else warnings.push('Seam Specialist present but primary role is ' + primaryName + ' — a batting matchup talent, rarely triggers');
        }
        if (hasTalent(/spin specialist/i)) {
            if (primaryName === 'batting') { score += 1; strengths.push('Spin Specialist — performs better batting against spin bowling'); }
            else warnings.push('Spin Specialist present but primary role is ' + primaryName + ' — a batting matchup talent, rarely triggers');
        }
        if (hasTalent(/safe hands/i)) {
            score += 1; strengths.push('Safe Hands — fielding/keeping bonus');
        }
        // Generic fallback for role-specific talents without their own
        // hand-written strength/warning pair above (Opener, Finisher,
        // New/Old Ball Bowler, the triggered delivery talents) — see the
        // matching comment in the youth branch above for why this reuses
        // isTalentRoleAligned() instead of hand-checking each talent name.
        const ALREADY_EXPLAINED_TALENTS = /gifted \(batting\)|gifted \(bowling\)|skilled \(batting\)|skilled \(bowling\)/i;
        talents.forEach(t => {
            if (ALREADY_EXPLAINED_TALENTS.test(t)) return;
            if (!isTalentRoleAligned(t, primaryName)) {
                warnings.push(`${t} present but primary role is ${primaryName} — mismatched, contributes nothing`);
            }
        });

        // Age penalty — peak at 25-27, decline starts 28+
        if (age >= 30) { score -= 3; warnings.push(`Age ${age} — past prime, skills declining`); }
        else if (age >= 28) { score -= 2; warnings.push(`Age ${age} — starting to decline`); }
        else if (age >= 25) { score -= 1; warnings.push(`Age ${age} — peak years, limited development`); }

        // Bowler type premium/value tiering (community consensus):
        // genuine fast bowlers (rf/lf) are the premium type — priciest but
        // most valuable; fast-medium (rfm/lfm) is strong value, usually
        // cheaper on the market; wrist spin (rws/lws) is just rare/hard to find.
        if (player.bowlerType === 'rf' || player.bowlerType === 'lf') {
            score += 2; strengths.push(`Premium bowler type: fast (${player.bowlerType}) — worth the higher price`);
        } else if (player.bowlerType === 'rfm' || player.bowlerType === 'lfm') {
            score += 1; strengths.push(`Value bowler type: fast-medium (${player.bowlerType}) — strong option, usually cheaper than out-and-out pace`);
        } else if (player.bowlerType === 'rws' || player.bowlerType === 'lws') {
            score += 1; strengths.push(`Rare bowler type: ${player.bowlerType}`);
        }

        // Squad balance bonus: fills a gap (squadStats is null if no
        // cached squad has a senior/21+ player yet — e.g. first run, or
        // a squad that's entirely youth)
        if (squadStats) {
            if (primaryName === 'bowling' && squadStats.bowlerCount < 4) {
                score += 1; strengths.push('Squad needs more specialist bowlers');
            }
            if (primaryName === 'keeping' && squadStats.keeperCount < 2) {
                score += 2; strengths.push('Genuine keeper prospect — squad needs a backup wicketkeeper');
            } else if ((player.keeping || 0) >= 6 && squadStats.keeperCount < 2) {
                score += 1; strengths.push('Squad needs a backup wicketkeeper');
            }
        }

        // Squad variety (bowler-type/handedness mix) — see
        // assessSquadVariety()'s own doc comment for the manual quotes and
        // reasoning. Shared with the youth branch above; deliberately
        // separate from the "Premium bowler type" market-value scoring
        // just above (orthogonal axes — see that function's comment).
        {
            const variety = assessSquadVariety(player, squadStats);
            score += variety.score;
            strengths.push(...variety.strengths);
            warnings.push(...variety.warnings);
        }

        // "The base" — age-specific primary/technique/experience/fielding
        // minimums (rating for youth). HARD FILTER: must meet 100% or the
        // player is filtered out.
        const scoutCheck = checkScoutBenchmark(player);
        scoutCheck.met.forEach(t => strengths.push(t));

        // Verdict
        let verdict;
        if (score >= 4) verdict = 'elite';
        else if (score >= 2) verdict = 'strong';
        else if (score >= 0) verdict = 'adequate';
        else if (score >= -2) verdict = 'weak';
        else verdict = 'poor';

        if (scoutCheck.hasBenchmark && !scoutCheck.passed) {
            score = Math.min(score, -5);
            verdict = 'poor';
            scoutCheck.failed.forEach(w => warnings.push(w));
            warnings.push(`Does not meet the base for age ${age} — filtered`);
        }

        return { score, verdict, warnings, strengths, rank: 0 };
    }

    // Calculate a 1-10 rank for a player (10 = best)
    // Skill-first, cost as tiebreaker
    function calculateRank(player, squadStats) {
        if (!player) return 0;
        const age = ageYears(player.age);
        const isYouth = age < 21;
        const primary = getPrimarySkillInfo(player).value;

        // 1. Primary skill (0-5 points) — main factor
        // Expert(9)=3, Outstanding(10)=3.5, Spectacular(11)=4, Exceptional(12)=4.3, WC+(13+)=5
        // Below Expert: Reliable(7)=2, Accomplished(8)=2.5, Capable(6)=1.5, etc.
        // Growth tapers above Spectacular(11): at the elite tail, one more
        // skill tier is real but marginal on-field impact, and shouldn't
        // outweigh a large gap in Rating/price/wage between two players
        // who are both already comfortably elite (see ratingScore below).
        let primaryScore;
        if (primary >= 13) primaryScore = 5;
        else if (primary >= 11) primaryScore = 4 + (primary - 11) * 0.3;
        else if (primary >= 9) primaryScore = 3 + (primary - 9) * 0.5;
        else if (primary >= 7) primaryScore = 2 + (primary - 7) * 0.25;
        else primaryScore = Math.max(0, primary * 0.3);

        // 2. Skill surplus above minimums (0-2 points)
        let surplusScore = 0;
        const mins = isYouth ? YOUTH_DEV_CURVE[age] : (age <= 23 ? SENIOR_MINS_YOUNG : SENIOR_MINS_VETERAN);
        if (mins) {
            const skills = [
                { value: primary, min: mins.primary },
                { value: player.technique || 0, min: mins.technique },
                { value: player.fielding || 0, min: mins.fielding }
            ];
            if (!isYouth) {
                skills.push({ value: player.endurance || 0, min: mins.endurance });
                skills.push({ value: player.experience || 0, min: mins.experience });
            }
            const totalSurplus = skills.reduce((sum, s) => sum + Math.max(0, s.value - s.min), 0);
            surplusScore = Math.min(2, totalSurplus * 0.25);
        }

        // 3. Age value (0-1.5 points) — ramps smoothly across the year
        //    (interpAgeSteps), so a 24y6w senior scores halfway between
        //    the 24yo peak tier and the 25yo next tier rather than a flat
        //    1.5 until the instant they turn 25.
        let ageScore = 0;
        if (isYouth) {
            // Younger = more development time
            ageScore = interpAgeSteps(player.age, [[16, 1.5], [17, 1.2], [18, 0.9], [19, 0.5], [20, 0.2]]);
        } else {
            // Peak at 24-26, decline after
            ageScore = interpAgeSteps(player.age, [[21, 0.8], [22, 1.0], [23, 1.0], [24, 1.5], [25, 1.5], [26, 1.5], [27, 0.3], [28, 0.3], [29, 0.3], [30, 0.3]]);
        }

        // 4. Talents (0-1 point) — role-aligned count, not raw count.
        // A "Skilled (Bowling)" talent on a specialist batsman rarely
        // triggers and shouldn't rank him the same as a batsman whose
        // talents actually match what he's picked for — see
        // isTalentRoleAligned()/countAlignedTalents().
        const talentScore = Math.min(1, countAlignedTalents(player) * 0.25);

        // 5. Squad fit (0-0.5 points)
        let fitScore = 0;
        if (squadStats) {
            if (primary > squadStats.avgPrimary + 1) fitScore += 0.25;
            if ((player.technique || 0) > squadStats.avgTechnique + 1) fitScore += 0.125;
            if ((player.fielding || 0) > squadStats.avgFielding + 1) fitScore += 0.125;
        }

        // 6. "The base" (0 or 0.7 points) — age-specific primary/technique/
        // experience/fielding minimums (covers ages 16-27+). This is a
        // hard filter elsewhere (evaluateTransferTarget filters failing
        // players out entirely) — here it's just the scoring contribution
        // for a player who does clear it, on top of that hard filter.
        const scoutCheck = checkScoutBenchmark(player);
        const scoutScore = scoutCheck.hasBenchmark && scoutCheck.passed ? 0.7 : 0;

        // 7. Rating (0-1.5 points) — FTP's own hidden overall-quality
        // score. Two players can look near-identical on the visible
        // skill columns (or one can even edge the other on Primary) but
        // differ meaningfully in hidden attributes that only surface in
        // Rating. Band is 20,000 (typical senior transfer floor) to
        // 55,000 (top-tier) — without this, ranking was blind to Rating
        // entirely and could favor a lower-rated, pricier player over a
        // higher-rated, cheaper one on a single skill-tier technicality.
        let ratingScore = 0;
        if (player.rating > 0) {
            ratingScore = Math.max(0, Math.min(1.5, (player.rating - 20000) / 35000 * 1.5));
        }

        // Total before cost adjustment
        let total = primaryScore + surplusScore + ageScore + talentScore + fitScore + scoutScore + ratingScore;

        // 7. Cost tiebreaker (-0.5 to 0.3) — optimize for quality per price.
        // Primary skill is the direct quality gate (the base, above), so
        // among players who already clear it, cheaper price/wage is pure
        // value and should always be rewarded — no exception needed.
        if (player.price > 0) {
            if (player.price <= 1000) total += 0.3;
            else if (player.price <= 5000) total += 0.15;
            else if (player.price <= 15000) total += 0;
            else if (player.price <= 50000) total -= 0.15;
            else total -= 0.3;
        }
        if (player.wage > 0) {
            if (player.wage <= 1000) total += 0.2;
            else if (player.wage <= 3000) total += 0.1;
            else if (player.wage <= 8000) total += 0;
            else total -= 0.1;
        }

        // Normalize to 1-10 scale
        // Max possible ≈ 5 + 2 + 1.5 + 1 + 0.5 + 0.7 + 1.5 + 0.5 = 12.7
        // Min possible ≈ 0
        const rank = Math.round(Math.max(1, Math.min(10, total * (10 / 12.7))));
        return rank;
    }

    function parseAcademyDoc(doc) {
        // Parses academy page HTML (works for both DOM and DOMParser doc)
        // Actual HTML structure: <th>Label</th><td>Value</td> inside table.form
        const info = {
            level: 'unknown', levelNum: 0,
            trainingEfficiency: 100,
            seniorCount: 0, youthCount: 0,
            weeklyCost: 0, upgradeCost: 0, downgradeRefund: 0,
            seniorEfficiency: 100, youthEfficiency: 100
        };
        const bodyText = doc.body ? doc.body.textContent : '';

        // Parse from <th>/<td> pairs in the form table
        const rows = doc.querySelectorAll('table.form tr');
        rows.forEach(row => {
            const th = row.querySelector('th');
            const td = row.querySelector('td');
            if (!th || !td) return;
            const label = th.textContent.trim().toLowerCase();
            const value = td.textContent.trim();

            if (label.includes('academy level')) {
                // <td class="academy">inadequate</td> — plain text, not a select
                const levelText = value.toLowerCase();
                for (const lvl of ACADEMY_LEVELS) {
                    if (levelText.includes(lvl.name)) {
                        info.level = lvl.name;
                        info.levelNum = lvl.num;
                        break;
                    }
                }
            } else if (label.includes('senior players')) {
                info.seniorCount = parseInt(value.replace(/,/g, '')) || 0;
            } else if (label.includes('youth players')) {
                info.youthCount = parseInt(value.replace(/,/g, '')) || 0;
            } else if (label.includes('senior training efficiency')) {
                info.seniorEfficiency = parseFloat(value.replace('%', '')) || 100;
            } else if (label.includes('youth training efficiency')) {
                info.youthEfficiency = parseFloat(value.replace('%', '')) || 100;
            } else if (label.includes('weekly academy maintenance')) {
                info.weeklyCost = parseInt(value.replace(/[$,]/g, '')) || 0;
            }
        });

        // Overall training efficiency = average of senior and youth
        info.trainingEfficiency = Math.round((info.seniorEfficiency + info.youthEfficiency) / 2);

        // Use wiki-correct costs based on detected level
        const currentLevel = ACADEMY_LEVELS[info.levelNum];
        if (currentLevel) {
            info.weeklyCost = currentLevel.cost;
            // Upgrade cost = 2.5x new level's maintenance
            if (info.levelNum < 10) {
                info.upgradeCost = Math.round(ACADEMY_LEVELS[info.levelNum + 1].cost * 2.5);
            }
            // Downgrade refund = 1.25x current level's maintenance
            if (info.levelNum > 0) {
                info.downgradeRefund = Math.round(currentLevel.cost * 1.25);
            }
        }

        // Also try to parse from page text (fallback)
        const upgradeMatch = bodyText.match(/one[- ]?off cost.*?\$?([\d,]+)/i);
        if (upgradeMatch && !info.upgradeCost) info.upgradeCost = parseInt(upgradeMatch[1].replace(/,/g, ''));

        const refundMatch = bodyText.match(/refund.*?\$?([\d,]+)/i);
        if (refundMatch && !info.downgradeRefund) info.downgradeRefund = parseInt(refundMatch[1].replace(/,/g, ''));

        console.log('[FTP Academy] Parsed:', info.level, '(' + info.levelNum + '), upgrade: $' + info.upgradeCost, 'weekly: $' + info.weeklyCost);
        return info;
    }

    // ============================================================
    // FINANCE PAGE PARSER (shared by in-page scrape + background fetch)
    // Verified directly against the real finances.htm HTML the user
    // provided. Two things the previous version got wrong:
    //   1. Data rows use plain <td> label/value pairs — there is NO
    //      <th> anywhere in the data rows (only the "Income"/"Expenses"
    //      column headers use <th>), so the old th+td lookup silently
    //      matched nothing.
    //   2. Each row holds up to FOUR cells: [income label, income
    //      value, expense label, expense value] — e.g. one row is
    //      "Gate Takings: 44,554 | Ground Maintenance: 8,000". The old
    //      code only ever read the row's first td, so it could never
    //      see the second (expense) pair, and it couldn't tell "This
    //      Week"'s table apart from the identical "Last Week" table
    //      further down the page — so a later matching row could
    //      silently overwrite a correct earlier one with stale data.
    // The real balance to use is the row labelled "Available Funds
    // (ignores ongoing transfers):" — NOT "Projected Weekly Balance"
    // (that's next week's income minus expenses, a very different
    // number) and NOT "Projected Overall Balance" (same figure as
    // Available Funds today, but described as a projection).
    // ============================================================
    function parseFinanceDoc(doc) {
        const info = {
            availableFunds: 0, weeklyIncome: 0, weeklyExpenses: 0, weeklyNet: 0,
            gateRevenue: 0, sponsorshipRevenue: 0,
            seniorWages: 0, youthWages: 0, academyCost: 0, groundMaintenance: 0
        };

        // Handles "$1,234", "-$1,234", and "($1,234)" (accounting-style negatives).
        const toAmount = (raw) => {
            if (!raw) return 0;
            const negative = /^\(.*\)$/.test(raw.trim()) || raw.trim().startsWith('-');
            const digits = raw.replace(/[^\d]/g, '');
            const n = parseInt(digits, 10) || 0;
            return negative ? -n : n;
        };

        // Only the FIRST stats table on the page is "This Week" — the
        // page also repeats the exact same row labels for "Last Week"
        // further down, which must NOT be allowed to overwrite these.
        const table = doc.querySelector('table.data.stats') || doc.querySelector('table.stats') || doc.querySelector('table.data');
        let foundAny = false;

        if (table) {
            table.querySelectorAll('tr').forEach(row => {
                const cells = Array.from(row.querySelectorAll('td'));
                if (cells.length < 2) return;

                // Walk the row in (label, value) pairs — handles both the
                // normal 4-cell rows (income pair + expense pair) and the
                // "Available Funds" row where the label isn't in cell 0.
                for (let i = 0; i < cells.length - 1; i++) {
                    const label = cells[i].textContent.trim().toLowerCase();
                    const value = cells[i + 1].textContent.trim();
                    if (!label.endsWith(':') || !/\d/.test(value)) continue;

                    if (/^available funds/.test(label)) {
                        info.availableFunds = toAmount(value); foundAny = true;
                    } else if (/^weekly income/.test(label)) {
                        info.weeklyIncome = toAmount(value); foundAny = true;
                    } else if (/^weekly expenses/.test(label)) {
                        info.weeklyExpenses = toAmount(value); foundAny = true;
                    } else if (/^gate takings/.test(label)) {
                        info.gateRevenue = toAmount(value); foundAny = true;
                    } else if (/^sponsorship/.test(label)) {
                        info.sponsorshipRevenue = toAmount(value); foundAny = true;
                    } else if (/^senior wages/.test(label)) {
                        info.seniorWages = toAmount(value); foundAny = true;
                    } else if (/^youth wages/.test(label)) {
                        info.youthWages = toAmount(value); foundAny = true;
                    } else if (/^academy:/.test(label)) { // NOT "academy refund:"
                        info.academyCost = toAmount(value); foundAny = true;
                    } else if (/^ground maintenance/.test(label)) {
                        info.groundMaintenance = toAmount(value); foundAny = true;
                    }
                    i++; // skip the value cell we just consumed
                }
            });
        }

        // --- Fallback: regex over flattened body text, colon-tolerant,
        // only used if the table structure wasn't found at all (e.g.
        // the site changes its markup in future). ---
        if (!foundAny) {
            const bodyText = doc.body ? doc.body.textContent : '';
            const extractAmount = (text, pattern) => {
                const match = text.match(pattern);
                return match ? toAmount(match[1]) : 0;
            };
            info.availableFunds = extractAmount(bodyText, /available funds[^:]*:[\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.weeklyIncome = extractAmount(bodyText, /weekly income[:\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.weeklyExpenses = extractAmount(bodyText, /weekly expenses[:\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.gateRevenue = extractAmount(bodyText, /gate takings[:\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.sponsorshipRevenue = extractAmount(bodyText, /sponsorship[:\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.seniorWages = extractAmount(bodyText, /senior wages[:\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.youthWages = extractAmount(bodyText, /youth wages[:\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.academyCost = extractAmount(bodyText, /academy:[\s]*\$?(-?\(?[\d,]+\)?)/i);
            info.groundMaintenance = extractAmount(bodyText, /ground maintenance[:\s]*\$?(-?\(?[\d,]+\)?)/i);
        }

        info.weeklyNet = info.weeklyIncome - info.weeklyExpenses;
        console.log('[FTP Finance] Parsed (source:', foundAny ? 'table' : 'regex-fallback', ') funds:$' + info.availableFunds, 'net:$' + info.weeklyNet + '/wk');
        return info;
    }

    function fetchFinanceFromPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: function(response) {
                    if (response.status === 200) {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');
                        resolve(parseFinanceDoc(doc));
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(err) { reject(err); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    function fetchGroundFromPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: function(response) {
                    if (response.status === 200) {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');
                        const info = { pitch: 'Even', weather: 'Sunny', pitchValue: 5, capacity: 0, groundName: '', lastUpgraded: '', nextUpgrade: '' };
                        const allThs = doc.querySelectorAll('th');
                        allThs.forEach(th => {
                            const thText = th.textContent.trim();
                            const td = th.nextElementSibling;
                            if (!td) return;
                            const label = thText.toLowerCase();
                            if (label.includes('pitch')) {
                                const popuphelp = td.querySelector('.popuphelp');
                                if (popuphelp) {
                                    const title = popuphelp.getAttribute('title') || '';
                                    info.pitch = title.split('|')[0].trim() || td.textContent.trim();
                                } else {
                                    info.pitch = td.textContent.trim();
                                }
                            } else if (label.includes('weather')) {
                                const popuphelp = td.querySelector('.popuphelp');
                                if (popuphelp) {
                                    const title = popuphelp.getAttribute('title') || '';
                                    info.weather = title.split('|')[0].trim() || td.textContent.trim();
                                } else {
                                    info.weather = td.textContent.trim();
                                }
                            } else if (label.includes('capacity')) {
                                info.capacity = parseInt(td.textContent.trim().replace(/,/g, '')) || 0;
                            } else if (label.includes('ground name')) {
                                info.groundName = td.textContent.trim();
                            } else if (label.includes('last upgraded')) {
                                info.lastUpgraded = td.textContent.trim();
                            } else if (label.includes('next upgrade')) {
                                info.nextUpgrade = td.textContent.trim();
                            }
                        });
                        resolve(info);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(err) { reject(err); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    // ============================================================
    // CENTRALIZED REFRESH: fetchAllData()
    // Fetches any stale data in parallel. Returns when done.
    // ============================================================
    async function fetchAllData(options = {}) {
        const force = options.force || false;
        const onProgress = options.onProgress || null;
        const promises = [];
        const labels = [];

        // 1. Squad (senior + youth)
        // Force a refetch if the existing cache is corrupted, not just
        // stale — a squad page visited via the default nav link (no
        // squadViewId, skill-less summary view) can otherwise overwrite
        // good cached skills with zeros. Check actual skill values, not
        // hasFullSkills (entries written before the bug that fixed it
        // still bake that flag true). Also catches PARTIAL corruption:
        // a single player with all three core stats 0 (a scrape gap that
        // makes getPrimarySkillInfo() default them to 'bowling', causing
        // false "no batters in your squad" reports) is treated the same
        // as a full wipe. And an empty-but-present cache (players.length
        // === 0), a cache that fails to load at all (null), or one that
        // has players in only ONE role group (real senior/youth clubs
        // always have both — a wipe leaves exactly one empty) all force
        // a refetch so a bad cache can never persist silently.
        const existingSquadCache = loadPlayerCache();
        const squadCacheCorrupted = !!(existingSquadCache &&
            (existingSquadCache.players.length === 0
             || !existingSquadCache.players.some(p => (p.batting || 0) > 0 || (p.bowling || 0) > 0 || (p.fielding || 0) > 0)
             || existingSquadCache.players.some(p => (p.isSenior || p.isYouth) &&
                (p.batting || 0) === 0 && (p.bowling || 0) === 0 && (p.fielding || 0) === 0)
             || (existingSquadCache.players.some(p => p.isYouth) && !existingSquadCache.players.some(p => p.isSenior))
             || (existingSquadCache.players.some(p => p.isSenior) && !existingSquadCache.players.some(p => p.isYouth))));
        if (force || isStale(CACHE_TIMESTAMP_KEY, STALE_SQUAD_HOURS) || squadCacheCorrupted || !existingSquadCache) {
            labels.push('squad');
            promises.push(
                fetchSquadFromPage(`https://www.fromthepavilion.org/seniors.htm?squadViewId=2&teamId=${TEAM_ID}`)
                    .then(async (seniors) => {
                        const [youth, summarySeniors, summaryYouth] = await Promise.all([
                            fetchSquadFromPage(`https://www.fromthepavilion.org/youths.htm?teamId=${TEAM_ID}`).catch(() => []),
                            // squadViewId=1 is the only view that exposes
                            // Talents — the grid view (=2) above never has
                            // them, for own squad or opponents.
                            fetchSquadSummaryView(`https://www.fromthepavilion.org/seniors.htm?squadViewId=1&teamId=${TEAM_ID}`),
                            fetchSquadSummaryView(`https://www.fromthepavilion.org/youths.htm?squadViewId=1&teamId=${TEAM_ID}`)
                        ]);
                        const existing = loadPlayerCache();
                        // If one group (seniors or youth) comes back empty
                        // while the previous cache had real players in that
                        // group, treat it as a failed fetch and keep the last
                        // known-good data instead of silently wiping it (a
                        // transient markup/session hiccup can return 0 rows
                        // without throwing). Same protection opponent-talent
                        // fetches use, applied here to prevent a partial squad
                        // wipe from persisting to cache.
                        const existingPlayers = existing ? existing.players : [];
                        const existingSeniors = existingPlayers.filter(p => p.isSenior);
                        const existingYouth = existingPlayers.filter(p => p.isYouth);
                        let seniorsToUse = seniors, youthToUse = youth;
                        if (seniors.length === 0 && existingSeniors.length > 0) {
                            console.warn(`[FTP Advisor] Senior squad fetch returned 0 players but the cache previously had ${existingSeniors.length} — treating as a failed fetch and keeping the last known-good senior data instead of wiping it.`);
                            seniorsToUse = existingSeniors;
                        }
                        if (youth.length === 0 && existingYouth.length > 0) {
                            console.warn(`[FTP Advisor] Youth squad fetch returned 0 players but the cache previously had ${existingYouth.length} — treating as a failed fetch and keeping the last known-good youth data instead of wiping it.`);
                            youthToUse = existingYouth;
                        }
                        const map = {};
                        seniorsToUse.forEach(p => { map[p.id] = p; });
                        youthToUse.forEach(p => { if (!map[p.id]) map[p.id] = p; });
                        // Seed talents from the last known-good fetch before
                        // merging this round's summary-view result. If this
                        // round's squadViewId=1 fetch still failed after the
                        // retry (empty array), players keep last-known talents
                        // instead of silently losing them for this refresh —
                        // that gap was the real cause of tactics recommendations
                        // changing on every visit with no real squad change.
                        if (existing) {
                            existing.players.forEach(ep => {
                                const p = map[ep.id];
                                if (p && ep.talents && !p.talents) p.talents = ep.talents;
                            });
                        }
                        mergeTalentsIntoPlayers(Object.values(map), [...summarySeniors, ...summaryYouth]);
                        savePlayerCache(Object.values(map));
                        console.log('[FTP Data] Squad refreshed:', Object.values(map).length, 'players');
                    })
            );
        }

        // 2. Academy
        if (force || isStale(ACADEMY_TIMESTAMP_KEY, STALE_ACADEMY_HOURS)) {
            labels.push('academy');
            promises.push(
                fetchAcademyFromPage(`https://www.fromthepavilion.org/academies.htm?teamId=${TEAM_ID}`)
                    .then(info => {
                        saveAcademyCache(info);
                        console.log('[FTP Data] Academy refreshed:', info.level);
                    })
            );
        }

        // 3. Finance
        if (force || isStale(FINANCE_TIMESTAMP_KEY, STALE_FINANCE_HOURS)) {
            labels.push('finance');
            promises.push(
                fetchFinanceFromPage(`https://www.fromthepavilion.org/finances.htm?teamId=${TEAM_ID}`)
                    .then(info => {
                        saveFinanceCache(info);
                        console.log('[FTP Data] Finance refreshed: $' + info.availableFunds);
                    })
            );
        }

        // 4. Ground (pitch/weather)
        if (force || isStale(GROUND_TIMESTAMP_KEY, STALE_GROUND_HOURS)) {
            labels.push('ground');
            promises.push(
                fetchGroundFromPage(`https://www.fromthepavilion.org/ground.htm?teamId=${TEAM_ID}`)
                    .then(info => {
                        saveGroundCache(info);
                        console.log('[FTP Data] Ground refreshed:', info.pitch, info.weather, 'cap:', info.capacity);
                    })
            );
        }

        // 5. Team info (supporters, mood)
        if (force || isStale(TEAM_INFO_TIMESTAMP_KEY, STALE_TEAM_INFO_HOURS)) {
            labels.push('team info');
            promises.push(
                fetchClubFromPage(`https://www.fromthepavilion.org/club.htm?teamId=${TEAM_ID}`)
                    .then(info => {
                        saveTeamInfoCache(info);
                        console.log('[FTP Data] Team info refreshed: supporters:', info.supporters, 'mood:', info.mood);
                    })
            );
        }

        if (promises.length > 0) {
            console.log('[FTP Data] Fetching stale data:', labels.join(', '));
            if (onProgress) onProgress(`Refreshing ${labels.join(', ')}...`);
            await Promise.allSettled(promises);
            console.log('[FTP Data] All data refreshed.');
        } else {
            console.log('[FTP Data] All data is fresh.');
        }
    }

    // ============================================================
    // CENTRALIZED STATUS BUILDER
    // Returns HTML string showing freshness of all data stores
    // ============================================================
    function buildDataStatusHTML() {
        const rows = [
            { label: 'Squad', ts: CACHE_TIMESTAMP_KEY, stale: STALE_SQUAD_HOURS },
            { label: 'Academy', ts: ACADEMY_TIMESTAMP_KEY, stale: STALE_ACADEMY_HOURS },
            { label: 'Finance', ts: FINANCE_TIMESTAMP_KEY, stale: STALE_FINANCE_HOURS },
            { label: 'Ground', ts: GROUND_TIMESTAMP_KEY, stale: STALE_GROUND_HOURS }
        ];
        let html = '';
        rows.forEach(r => {
            const age = getDataAgeText(r.ts);
            const stale = isStale(r.ts, r.stale);
            const badge = stale ? '<span class="ftp-stat-badge red">Stale</span>' : '<span class="ftp-stat-badge green">Fresh</span>';
            html += `<div class="ftp-stat-row"><span class="ftp-stat-label">${r.label}</span><span class="vj-flex vj-gap-6">${badge} <span class="vj-text-xs vj-text-muted">${age}</span></span></div>`;
        });
        return html;
    }

    // ============================================================
    // SQUAD SCRAPER (for current page DOM)
    // ============================================================
    function scrapeSquad() {
        const players = [];
        let rows = document.querySelectorAll('table#squad tbody tr');
        if (rows.length === 0) rows = document.querySelectorAll('table#squad tr');
        if (rows.length === 0) rows = document.querySelectorAll('table.squad tbody tr');
        if (rows.length === 0) {
            const allTables = document.querySelectorAll('table');
            for (const table of allTables) {
                const links = table.querySelectorAll('a[href*="player.htm"]');
                if (links.length >= 3) {
                    rows = table.querySelectorAll('tbody tr');
                    if (rows.length === 0) rows = table.querySelectorAll('tr');
                    break;
                }
            }
        }
        rows.forEach(row => {
            if (!row.querySelector('td')) return;
            const p = parsePlayerRow(row);
            if (p) players.push(p);
        });
        return players;
    }

    function scrapeOpponentSquad() {
        const players = [];
        const rows = document.querySelectorAll('table#squad tbody tr');
        console.log('[FTP Advisor] scrapeOpponentSquad - found rows:', rows.length);
        rows.forEach((row, idx) => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) {
                debugLog('[FTP Advisor] Row', idx, 'skipped - cells.length:', cells.length);
                return;
            }
            const nameLink = row.querySelector('a.player');
            if (!nameLink) {
                debugLog('[FTP Advisor] Row', idx, 'skipped - no name link');
                return;
            }
            const playerId = nameLink.href.match(/playerId=(\d+)/)?.[1];
            const name = escapeHtml(nameLink.textContent.trim());

            const bowlerTypeSpan = row.querySelector('span.bowlerType');
            const bowlerType = bowlerTypeSpan ? bowlerTypeSpan.textContent.trim() : '';
            const skillCells = row.querySelectorAll('td.skills');
            const experience = skillCells[0] ? parseSkill(skillCells[0].textContent) : 0;
            const fatigueCell = row.querySelector('td.fatigue');
            const formCell = row.querySelector('td.form');

            // Opponent squad pages only expose Player/Age/Nat/BT/Exp/Fatg/
            // Form/Wage/Rating — no batting/bowling/technique/etc. (see
            // parseOpponentPlayerRow for the full explanation).
            let age = 99, wage = 0;
            cells.forEach(cell => {
                const text = cell.textContent.trim();
                const ageMatch = text.match(/^(\d{1,2})(?:\.\d+)?$/);
                const wageMatch = text.match(/^\$([\d,]+)/);
                if (ageMatch) {
                    const val = parseInt(ageMatch[1], 10);
                    if (val >= 16 && val <= 50 && age === 99) age = val;
                } else if (wageMatch) {
                    wage = parseInt(wageMatch[1].replace(/,/g, ''), 10) || 0;
                }
            });

            const ratingText = cells[cells.length - 1]?.textContent.trim() || '';
            const rating = parseInt(ratingText.replace(/,/g, '')) || 0;

            players.push({
                id: playerId,
                name: name,
                age: age,
                bowlerType: bowlerType,
                bowlerCategory: BOWLER_CATEGORY[bowlerType] || 'none',
                bowlerPace: BOWLER_PACE[bowlerType] || 0,
                hasFullSkills: false,
                wage: wage,
                experience: experience,
                fatigue: parseFatigue(fatigueCell?.textContent),
                form: parseSkill(formCell?.textContent),
                rating: rating,
                isSenior: row.classList.contains('senior'),
                isYouth: row.classList.contains('youth')
            });
        });
        console.log('[FTP Advisor] scrapeOpponentSquad - total players:', players.length);
        return players;
    }

    // ============================================================
    // TRANSFER PAGE PARSER
    // Parses search results from transfer.htm into player objects.
    // Uses header-based column detection: reads the <th> row to determine
    // which column index maps to which field, then maps each data row.
    // This handles varying column orders across different FTP table views.
    // ============================================================

    // Map a header label text to a canonical field key
    function _mapTransferHeader(text) {
        const t = text.toLowerCase().trim();
        if (t === 'player' || t === 'name') return 'name';
        if (t.includes('bid') || t === 'price' || t.includes('current')) return 'price';
        if (t.includes('deadline') || t.includes('time left') || t.includes('ends')) return 'deadline';
        if (t === 'age') return 'age';
        if (t.includes('nat') || t === 'country') return 'nationality';
        if (t === 'bt' || t.includes('bowler type') || t === 'type') return 'bowlerType';
        if (t === 'end' || t.includes('endurance')) return 'endurance';
        if (t === 'bat' || t.includes('batting')) return 'batting';
        if (t === 'bowl' || t.includes('bowling')) return 'bowling';
        if (t === 'tech' || t.includes('technique')) return 'technique';
        if (t === 'pow' || t.includes('power')) return 'power';
        if (t === 'keep' || t.includes('keeping')) return 'keeping';
        if (t === 'field' || t.includes('fielding')) return 'fielding';
        if (t.includes('rating') || t.includes('score')) return 'rating';
        return null;
    }

    function parseTransferRow(row, colMap) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) return null;

        const nameLink = row.querySelector('a[href*="player.htm"]');
        if (!nameLink) return null;
        const playerId = nameLink.href.match(/playerId=(\d+)/)?.[1];
        const name = escapeHtml(nameLink.textContent.trim());
        if (!name || name.length < 2) return null;

        const cellTexts = Array.from(cells).map(c => c.textContent.trim());

        const getCell = (key) => {
            const idx = colMap[key];
            return (idx !== undefined && idx < cellTexts.length) ? cellTexts[idx] : '';
        };

        // "YY.WW" — weeks out of 14, not a base-10 decimal fraction. See
        // parseGameAge() for why parseFloat() here was silently wrong.
        const age = parseGameAge(getCell('age'));
        const ratingText = (getCell('rating') || '').replace(/,/g, '');
        const rating = parseInt(ratingText) || 0;

        const bowlerTypeRaw = getCell('bowlerType').toLowerCase().trim();
        const bowlerTypes = ['rf','lf','rfs','lfs','rfm','lfm','rm','lm','rws','lws'];
        const bowlerType = bowlerTypes.includes(bowlerTypeRaw) ? bowlerTypeRaw : '';

        // Price: the current bid amount (transfer page shows bid, NOT wage)
        const priceText = getCell('price');
        const priceMatch = priceText.match(/\$([\d,]+)/);
        const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0;

        const player = {
            id: playerId,
            name: name,
            age: age,
            rating: rating,
            wage: 0,
            price: price,
            bowlerType: bowlerType,
            bowlerCategory: BOWLER_CATEGORY[bowlerType] || 'none',
            bowlerPace: BOWLER_PACE[bowlerType] || 0,
            isLeftHanded: false,
            batting: parseSkill(getCell('batting')),
            bowling: parseSkill(getCell('bowling')),
            keeping: parseSkill(getCell('keeping')),
            technique: parseSkill(getCell('technique')),
            fielding: parseSkill(getCell('fielding')),
            endurance: parseSkill(getCell('endurance')),
            power: parseSkill(getCell('power')),
            captaincy: 0,
            experience: 0,
            talents: []
        };

        return player;
    }

    // Fetch individual player page to extract experience, wage, and talents
    // (not available in transfer table — only in AJAX hover tooltip)
    // Player page HTML structure:
    //   <div class="panel"><div class="padded">
    //     <p>16y0w | 13,555 rating | $500 wage (0% discount)</p>
    //   </div>
    //   <table class="data">
    //     <tr><th>Talents</th><td><span class="popuphelp" title="Name|Desc">Name</span></td></tr>
    //     <tr><th>Experience</th><td class="skills">dreadful</td></tr>
    //     <tr><th>Captaincy</th><td class="skills">dreadful</td></tr>
    //   </table></div>
    function fetchPlayerPageDetails(playerId) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.fromthepavilion.org/player.htm?playerId=${playerId}`,
                timeout: 10000,
                onload: (resp) => {
                    try {
                        if (resp.status !== 200) {
                            debugLog(`[FTP] Player ${playerId}: HTTP ${resp.status}`);
                            return resolve({ experience: null, wage: null, talents: [], captaincy: null });
                        }
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(resp.responseText, 'text/html');
                        const result = { experience: null, wage: null, wageDiscount: null, talents: [], captaincy: null };

                        // Quick sanity check: if we got the login page, bail
                        if (doc.querySelector('input[name="username"]') || resp.responseText.length < 500) {
                            debugLog(`[FTP] Player ${playerId}: likely login page or empty (len=${resp.responseText.length})`);
                            return resolve(result);
                        }

                        // Parse age/rating/wage from first <p> in .panel .padded
                        // Format: "16y0w | 13,555 rating | $500 wage (0% discount)".
                        // The wage shown is the DISCOUNTED wage — the game applies a
                        // loyalty discount (career youth-start = 5% + 0.5%/season,
                        // capped at +5%). To compare value fairly across players we
                        // also recover the real (pre-discount) wage from the % shown.
                        const paddedPs = doc.querySelectorAll('.panel .padded p');
                        if (paddedPs.length > 0) {
                            const infoText = paddedPs[0].textContent;
                            const wageMatch = infoText.match(/\$([\d,]+)\s*wage/);
                            if (wageMatch) result.wage = parseInt(wageMatch[1].replace(/,/g, ''));
                            const discMatch = infoText.match(/\((\d+)%\s*discount\)/i);
                            if (discMatch) result.wageDiscount = parseInt(discMatch[1], 10) || 0;
                        }

                        // Scan ALL th/td pairs across ALL tables
                        const allThs = doc.querySelectorAll('th');
                        for (const th of allThs) {
                            const label = th.textContent.trim().toLowerCase();
                            let td = th.nextElementSibling;
                            if (!td || td.tagName !== 'TD') continue;

                            if (label === 'experience' && result.experience === null) {
                                const val = td.textContent.trim().toLowerCase();
                                result.experience = parseSkill(val);
                            } else if (label === 'captaincy' && result.captaincy === null) {
                                const val = td.textContent.trim().toLowerCase();
                                result.captaincy = parseSkill(val);
                            } else if (label === 'talents' && result.talents.length === 0) {
                                const spans = td.querySelectorAll('span.popuphelp');
                                spans.forEach(span => {
                                    const title = span.getAttribute('title') || '';
                                    const name = escapeHtml(title.split('|')[0].trim());
                                    if (name) result.talents.push(name);
                                });
                                if (result.talents.length === 0) {
                                    const text = td.textContent.trim();
                                    if (text && text !== 'None') {
                                        result.talents = text.split(',').map(t => escapeHtml(t.trim())).filter(t => t.length > 0);
                                    }
                                }
                            }
                        }

                        debugLog(`[FTP] Player ${playerId}: exp=${result.experience}, wage=${result.wage}, disc=${result.wageDiscount}%, capt=${result.captaincy}, talents=${result.talents.length}`);
                        resolve(result);
                    } catch (e) {
                        debugLog(`[FTP] Player ${playerId}: parse error`, e);
                        resolve({ experience: null, wage: null, wageDiscount: null, talents: [], captaincy: null });
                    }
                },
                onerror: (e) => { debugLog(`[FTP] Player ${playerId}: network error`, e); resolve({ experience: null, wage: null, wageDiscount: null, talents: [], captaincy: null }); },
                ontimeout: () => { debugLog(`[FTP] Player ${playerId}: timeout`); resolve({ experience: null, wage: null, wageDiscount: null, talents: [], captaincy: null }); }
            });
        });
    }

    // Fetch details for all priority buy players with rate limiting
    async function fetchTransferPlayerDetails(players, onUpdate) {
        const DELAY_MS = 300;
        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            if (!p.id) continue;
            const details = await fetchPlayerPageDetails(p.id);
            if (details.experience !== null) p.experience = details.experience;
            if (details.wage !== null) p.wage = details.wage;
            if (details.wageDiscount != null) p.wageDiscount = details.wageDiscount;
            if (details.talents.length > 0) p.talents = details.talents;
            if (details.captaincy !== null) p.captaincy = details.captaincy;
            if (onUpdate) onUpdate(i, players.length);
            if (i < players.length - 1) await new Promise(r => setTimeout(r, DELAY_MS));
        }
    }

    function scrapeTransferResults() {
        const players = [];
        const tables = document.querySelectorAll('table.data');
        for (const table of tables) {
            const allRows = table.querySelectorAll('tr');
            if (allRows.length < 2) continue;

            // Find header row: first row containing a "Player" cell
            let colMap = {};
            let headerIdx = -1;
            for (let i = 0; i < Math.min(allRows.length, 3); i++) {
                const hdrCells = allRows[i].querySelectorAll('th, td');
                const hdrTexts = Array.from(hdrCells).map(c => c.textContent.trim());
                const playerColIdx = hdrTexts.findIndex(t => /^player$/i.test(t.trim()));
                if (playerColIdx >= 0) {
                    headerIdx = i;
                    hdrTexts.forEach((t, j) => {
                        const key = _mapTransferHeader(t);
                        if (key) colMap[key] = j;
                    });
                    break;
                }
            }

            if (headerIdx < 0 || Object.keys(colMap).length < 3) continue;

            for (let i = headerIdx + 1; i < allRows.length; i++) {
                const row = allRows[i];
                if (!row.querySelector('td')) continue;
                const p = parseTransferRow(row, colMap);
                if (p && p.age > 0) players.push(p);
            }
        }
        return players;
    }

    async function fetchOpponentSquad(teamId) {
        // Fetch BOTH senior and youth squads in parallel, plus the
        // squadViewId=1 summary view for each — confirmed via real HTML
        // that opponent summary pages expose Talents (span.popuphelp)
        // even though the grid view (=2) never does. Skill numbers
        // still aren't available for opponents either way — that
        // limitation is the game's own scouting design, not fixed by
        // this view.
        const [seniors, youth, summarySeniors, summaryYouth] = await Promise.all([
            fetchSquadFromPage(`https://www.fromthepavilion.org/seniors.htm?squadViewId=2&orderBy=&teamId=${teamId}&playerType=0`).catch(() => []),
            fetchSquadFromPage(`https://www.fromthepavilion.org/youths.htm?teamId=${teamId}`).catch(() => []),
            fetchSquadSummaryView(`https://www.fromthepavilion.org/seniors.htm?squadViewId=1&orderBy=&teamId=${teamId}&playerType=0`),
            fetchSquadSummaryView(`https://www.fromthepavilion.org/youths.htm?squadViewId=1&teamId=${teamId}`)
        ]);

        // Merge and deduplicate by player ID
        const seen = new Set();
        const players = [];
        for (const p of [...seniors, ...youth]) {
            if (!seen.has(p.id)) {
                seen.add(p.id);
                players.push(p);
            }
        }
        // Same fallback as fetchAllData: keep last known-good talents for
        // this opponent if this round's squadViewId=1 fetch (still) failed,
        // rather than letting a transient network hiccup wipe them and
        // silently change lineup/opponent-analysis recommendations.
        const existingOpp = loadOpponentCache(teamId);
        if (existingOpp) {
            existingOpp.players.forEach(ep => {
                const p = players.find(pl => pl.id === ep.id);
                if (p && ep.talents && !p.talents) p.talents = ep.talents;
            });
        }
        mergeTalentsIntoPlayers(players, [...summarySeniors, ...summaryYouth]);
        saveOpponentCache(teamId, players);
        return players;
    }

    // Extract opponent teamId from a game.htm page by fetching it
    function extractOpponentTeamIdFromGame(gameUrl) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: gameUrl,
                timeout: 15000,
                onload: function(response) {
                    if (response.status !== 200) return reject(new Error(`HTTP ${response.status}`));
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(response.responseText, 'text/html');
                    const opponentId = findOpponentTeamIdInDocument(doc);
                    resolve(opponentId);
                },
                onerror: function(err) { reject(err); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    // ============================================================
    // ACADEMY UPGRADE RECOMMENDATION
    // ============================================================
    function recommendAcademyAction(academyInfo, financeInfo, squadContext) {
        const rec = {
            action: 'maintain',
            reason: '',
            priority: 'low',
            upgradeCost: academyInfo?.upgradeCost || 0,
            downgradeRefund: academyInfo?.downgradeRefund || 0,
            weeklyIncrease: 0,
            canAfford: false,
            breakEvenWeeks: 0,
            benefits: []
        };

        if (!academyInfo || academyInfo.level === 'unknown') {
            rec.reason = 'Academy level unknown. Visit Club → Academies to check.';
            return rec;
        }

        const funds = financeInfo ? financeInfo.availableFunds : 0;
        const weeklyNet = financeInfo ? financeInfo.weeklyNet : 0;
        const level = academyInfo.levelNum;
        const levelName = academyInfo.level;
        const currentLevel = ACADEMY_LEVELS[level];
        const nextLevel = level < 10 ? ACADEMY_LEVELS[level + 1] : null;

        rec.upgradeCost = currentLevel ? currentLevel.cost * 2.5 : 0;
        rec.downgradeRefund = currentLevel ? Math.round(currentLevel.cost * 1.25) : 0;
        rec.weeklyIncrease = nextLevel ? nextLevel.cost - currentLevel.cost : 0;
        rec.canAfford = funds >= rec.upgradeCost && (weeklyNet + rec.weeklyIncrease) >= 0;
        if (rec.weeklyIncrease > 0) {
            rec.breakEvenWeeks = Math.ceil(rec.upgradeCost / rec.weeklyIncrease);
        }

        // Senior and youth counts for benefit calculation
        const seniorCount = squadContext.seniorCount || 0;
        const youthCount = squadContext.youthCount || 0;
        const totalPlayers = seniorCount + youthCount;

        // Benefits of upgrade: faster training for ALL players
        const currentSpeed = ACADEMY_SPEED[level] || 1.00;
        const nextSpeed = nextLevel ? ACADEMY_SPEED[level + 1] : currentSpeed;
        const speedGain = nextSpeed - currentSpeed;

        if (level < 10) {
            rec.benefits.push(`Training speed: ${Math.round(currentSpeed * 100)}% → ${Math.round(nextSpeed * 100)}% (+${Math.round(speedGain * 100)}%) for all ${totalPlayers} players`);
            rec.benefits.push(`Youth players benefit even more from higher academy`);
            if (level <= 3) {
                rec.benefits.push('Current academy is LOW — significant training speed improvement possible');
            }
        }

        // Experienced-player guidance: Superior is the realistic target to
        // aim for — from there you can train quality players without going
        // bankrupt. Lavish+ is a longer-term goal: gate takings scale with
        // club supporters (top clubs run ~2500), so the academy upgrade
        // cycle is expected to take a while.
        if (level < 7) {
            rec.benefits.push('Community guidance: aim for Superior — from there you can train quality players without going bankrupt. Lavish+ is a long-term goal (top clubs run ~2500 supporters driving gate takings).');
        }

        // Decision logic
        if (level >= 8) {
            // Lavish+ — very expensive, diminishing returns
            rec.action = 'maintain';
            rec.reason = `${currentLevel.label} academy is near maximum. Training is ${Math.round(currentSpeed * 100)}% speed. Further upgrades have diminishing returns — the cost per % speed gain is very high at this level.`;
            rec.priority = 'low';
        } else if (level >= 5 && !rec.canAfford) {
            rec.action = 'maintain';
            rec.reason = `${currentLevel.label} academy — training at ${Math.round(currentSpeed * 100)}% speed. Can't afford upgrade to ${nextLevel.label} ($${rec.upgradeCost.toLocaleString()}). Maintain current level.`;
            rec.priority = 'low';
        } else if (level >= 5 && rec.canAfford) {
            // Good+ and can afford — optional upgrade
            rec.action = 'upgrade';
            rec.reason = `Consider upgrading to ${nextLevel.label} ($${rec.upgradeCost.toLocaleString()}). Training speed improves from ${Math.round(currentSpeed * 100)}% to ${Math.round(nextSpeed * 100)}%. Weekly cost increases by $${rec.weeklyIncrease.toLocaleString()}. Optional at this level — diminishing returns.`;
            rec.priority = 'low';
        } else if (level <= 2 && rec.canAfford) {
            // Low level and can afford — strong recommendation
            rec.action = 'upgrade';
            rec.reason = `Academy is ${currentLevel.label} — UPGRADE to ${nextLevel.label}. Cost: $${rec.upgradeCost.toLocaleString()} one-off + $${rec.weeklyIncrease.toLocaleString()}/week more. Training speed: ${Math.round(currentSpeed * 100)}% → ${Math.round(nextSpeed * 100)}%. This is the best investment for squad development.`;
            rec.priority = 'high';
        } else if (level <= 2 && !rec.canAfford) {
            // Can't afford upgrade at low level
            const needed = rec.upgradeCost - funds;
            rec.action = 'save';
            rec.reason = `Academy is ${currentLevel.label} — training at only ${Math.round(currentSpeed * 100)}% speed. Upgrade to ${nextLevel.label} costs $${rec.upgradeCost.toLocaleString()}. You need $${needed.toLocaleString()} more (have $${funds.toLocaleString()}). Weekly net: $${weeklyNet.toLocaleString()}/week.`;
            rec.priority = 'medium';
        } else if (level <= 4 && rec.canAfford && weeklyNet > 15000) {
            // Mid level, can afford, positive cash flow
            rec.action = 'upgrade';
            rec.reason = `Upgrading to ${nextLevel.label} costs $${rec.upgradeCost.toLocaleString()}. You have $${funds.toLocaleString()} and +$${weeklyNet.toLocaleString()}/week. Training speed: ${Math.round(currentSpeed * 100)}% → ${Math.round(nextSpeed * 100)}%. Recommended for long-term squad development.`;
            rec.priority = 'medium';
        } else if (level <= 4 && !rec.canAfford) {
            rec.action = 'save';
            rec.reason = `Academy is ${currentLevel.label}. Upgrade to ${nextLevel.label} costs $${rec.upgradeCost.toLocaleString()}. You have $${funds.toLocaleString()} — need $${(rec.upgradeCost - funds).toLocaleString()} more. Weekly net: $${weeklyNet.toLocaleString()}/week.`;
            rec.priority = 'medium';
        } else {
            rec.action = 'maintain';
            rec.reason = `Academy is ${currentLevel.label} — training at ${Math.round(currentSpeed * 100)}% speed. Adequate for current situation.`;
            rec.priority = 'low';
        }

        // Downgrade warning if finances are bad
        if (financeInfo && weeklyNet < -30000 && level >= 4) {
            const refund = rec.downgradeRefund;
            rec.benefits.push(`⚠️ Financial pressure: weekly deficit is $${Math.abs(weeklyNet).toLocaleString()}. Downgrade refund: ~$${refund.toLocaleString()}. Consider downgrading to save $${(currentLevel.cost - ACADEMY_LEVELS[level - 1].cost).toLocaleString()}/week.`);
        }

        // Youth recruitment quality note
        if (level < 5) {
            rec.benefits.push(`Higher academy = better youth recruits. Current level ${level} gives lower quality recruits.`);
        }

        return rec;
    }

    // ============================================================
    // MATCH CONTEXT (pitch, weather, match type)
    // ============================================================
    function scrapeMatchContext() {
        const context = {
            weather: 'Sunny',
            pitch: 'Sporting',
            matchType: 'OD',
            matchTypeKnown: false,
            overs: 50,
            venue: 'Unknown',
            isYouthOnly: false,
            maxAge: 99,
            isHome: null
        };

        // Find weather, pitch, league from the match details table
        const allThs = document.querySelectorAll('th');
        allThs.forEach(th => {
            const thText = th.textContent.trim();
            const td = th.nextElementSibling;
            if (!td) return;

            if (thText.includes('Weather')) {
                const popuphelp = td.querySelector('.popuphelp');
                if (popuphelp) {
                    const title = popuphelp.getAttribute('title') || '';
                    context.weather = title.split('|')[0].trim() || td.textContent.trim();
                } else {
                    context.weather = td.textContent.trim();
                }
            } else if (thText.includes('Pitch')) {
                const popuphelp = td.querySelector('.popuphelp');
                if (popuphelp) {
                    const title = popuphelp.getAttribute('title') || '';
                    context.pitch = title.split('|')[0].trim() || td.textContent.trim();
                } else {
                    context.pitch = td.textContent.trim();
                }
            } else if (thText.includes('Ground')) {
                context.venue = td.textContent.trim();
            } else if (thText.includes('League')) {
                const leagueText = td.textContent.trim().toLowerCase();
                context.matchTypeKnown = true;
                if (leagueText.includes('youth twenty20') || leagueText.includes('youth t20')) {
                    context.matchType = 'YT20';
                    context.overs = 20;
                    context.isYouthOnly = true;
                    context.maxAge = YOUTH_MAX_AGE;
                } else if (leagueText.includes('twenty20') || leagueText.includes(' t20')) {
                    context.matchType = 'T20';
                    context.overs = 20;
                } else if (leagueText.includes('youth') || leagueText.includes(' yod ')) {
                    context.matchType = 'YOD';
                    context.overs = 40;
                    context.isYouthOnly = true;
                    context.maxAge = YOUTH_MAX_AGE;
                } else {
                    context.matchType = 'OD';
                    context.overs = 50;
                }
            } else if (thText.includes('Home')) {
                // "Home: [Team Name]" — check if it's our team
                const homeText = td.textContent.trim();
                if (homeText && TEAM_ID) {
                    const homeLink = td.querySelector('a[href*="teamId="]');
                    if (homeLink) {
                        const m = homeLink.href.match(/teamId=(\d+)/);
                        context.isHome = m && m[1] === String(TEAM_ID);
                    } else {
                        // Fallback: if no link, check if team name is in the text
                        // (less reliable but handles cases where the link format differs)
                        context.isHome = null; // unknown
                    }
                }
            }
        });

        return context;
    }

    // Parse the fixture's Home/Away rows once. ID and name consumers
    // must share this source so the opponent cannot differ by caller.
    function parseFixtureTeams(doc) {
        const teams = { home: null, away: null };
        for (const th of doc.querySelectorAll('th')) {
            const label = th.textContent.trim().toLowerCase();
            if (label !== 'home' && label !== 'away') continue;
            const td = th.nextElementSibling;
            const link = td ? td.querySelector('a') : null;
            const match = link ? link.href.match(/teamId=(\d+)/) : null;
            if (!match) continue;
            teams[label] = { id: match[1], name: link.textContent.trim() };
        }
        return teams;
    }

    // "Home" is not always the opponent — it is whichever fixture team
    // is not ours. This helper is shared by live and fetched documents.
    function findOpponentTeamIdInDocument(doc) {
        const teams = parseFixtureTeams(doc);
        if (teams.home && teams.home.id !== String(TEAM_ID)) return teams.home.id;
        if (teams.away && teams.away.id !== String(TEAM_ID)) return teams.away.id;

        // Some fetched match pages expose team links without Home/Away
        // table labels. Use the first non-self team link as a fallback.
        const teamLinks = doc.querySelectorAll('a[href*="teamId="]');
        for (const link of teamLinks) {
            const match = link.href.match(/teamId=(\d+)/);
            if (match && match[1] !== String(TEAM_ID)) return match[1];
        }
        return null;
    }

    function getOpponentTeamId() {
        return findOpponentTeamIdInDocument(document);
    }

    // ============================================================
    // SCORING FUNCTIONS
    // ============================================================
    function calculateBattingScore(player, pitchEffect, weatherEffect, isT20, isYouth, isHome) {
        // Form and Experience use multiplicative curves from the FTP_Training
        // workbook's Form-Exp tab (real game data), not flat additive weights.
        // Form index clamped at 10 (Outstanding) — the source sheet has no data
        // above Outstanding; don't extrapolate.
        const formIdx = Math.min(10, Math.max(0, player.form || 0));
        const expIdx = Math.min(15, Math.max(0, player.experience || 0));
        const formMult = FORM_MULTIPLIER[formIdx] || 1.0;
        const expMult = EXPERIENCE_MULTIPLIER[expIdx] || 1.0;
        let score = (player.batting * 3) + (player.technique * 2) + (player.power * 1.5) +
                    (player.fatigue * 0.3);
        score *= formMult * expMult;
        score *= pitchEffect.bat;
        // weatherEffect.bat: direct batting modifier (Hot=0.9, Humid=1.1, etc.)
        // weatherEffect.fatigue: fatigue drain proxy — (2 - fatigue)/2 reduces
        // score proportionally to how much weather accelerates tiredness.
        if (weatherEffect.bat) score *= weatherEffect.bat;
        score *= (2 - weatherEffect.fatigue) / 2;
        // Home advantage: pitch control (you choose the pitch type) + crowd
        // support. Small but real — official manual confirms home team gets
        // 2/3 gate revenue and pitch choice. ~3% bonus is conservative.
        if (isHome === true) score *= 1.03;
        if (isT20) score += player.power * 1.5;

        // Talent bonuses — format-aware
        const talents = player.talents || [];
        const hasTalent = (regex) => talents.some(t => regex.test(t));

        // Opener: more valuable in OD (longer innings), slightly less in T20
        if (hasTalent(/^opener$/i)) score *= isT20 ? 1.10 : 1.15;
        // Finisher: more valuable in T20 (death overs matter more)
        if (hasTalent(/finisher/i)) score *= isT20 ? 1.15 : 1.10;
        // Skilled batting: flat bonus, more impactful in T20
        if (hasTalent(/skilled.*batting/i)) score += isT20 ? 7 : 5;
        // Skilled power: only useful in T20
        if (hasTalent(/skilled.*power/i) && isT20) score += 5;

        // Triggered batting talents — official manual confirms these
        // exist ("more likely to turn a dot ball into a single/two" /
        // "...into a four or six") but doesn't quantify the effect.
        // Small flat bonus per talent, more valuable in T20 where
        // strike rate matters more than in a longer format — same
        // conservative-estimate reasoning as the bowling triggered
        // talents above, better than continuing to ignore them.
        if (hasTalent(/accumulator/i)) score += isT20 ? 3 : 2;
        if (hasTalent(/boundary hitter/i)) score += isT20 ? 4 : 2.5;

        // Youth bonus: training talents suggest higher ceiling
        if (isYouth) {
            if (hasTalent(/prodigy/i)) score *= 1.10;
            if (hasTalent(/gifted.*batting/i)) score *= 1.05;
        }

        return score;
    }

    function calculateBowlingScore(player, pitchEffect, weatherEffect, isT20, isYouth, isHome) {
        const category = player.bowlerCategory;
        const isDesignatedBowler = category !== 'none';
        let pitchMod, weatherMod;
        if (category === 'spin') {
            pitchMod = pitchEffect.spin;
            weatherMod = weatherEffect.spin;
        } else if (category === 'seam') {
            pitchMod = pitchEffect.seam;
            weatherMod = weatherEffect.seam;
        } else {
            pitchMod = (pitchEffect.seam + pitchEffect.spin) / 2;
            weatherMod = (weatherEffect.seam + weatherEffect.spin) / 2;
        }
        // Form and Experience use multiplicative curves (same as batting),
        // not flat additive weights. Form index clamped at 10.
        const formIdx = Math.min(10, Math.max(0, player.form || 0));
        const expIdx = Math.min(15, Math.max(0, player.experience || 0));
        const formMult = FORM_MULTIPLIER[formIdx] || 1.0;
        const expMult = EXPERIENCE_MULTIPLIER[expIdx] || 1.0;
        let score = (player.bowling * 3) + (player.technique * 1.5) + (player.endurance * 1) +
                    (player.fatigue * 0.3);
        score *= formMult * expMult;
        score *= pitchMod * weatherMod;
        // Home advantage: pitch familiarity + crowd support
        if (isHome === true) score *= 1.03;
        if (category === 'seam') score *= 1.1;
        if (!isDesignatedBowler) score *= 0.75;

        // Pace bonus — pitches like Sticky/Uneven/Hard give raw pace an
        // extra edge (bounce, movement) on top of the seam/spin split
        // above. Genuinely fast bowlers (rf/lf, pace 5) get the full
        // benefit; fast-medium (rfm/lfm, pace 4) get most of it; medium
        // (rm/lm, pace 3) get proportionally less. Community consensus:
        // fast bowlers are the premium (and priciest) bowling type —
        // this is where that premium actually pays off on the field.
        if (category === 'seam' && pitchEffect.paceBonus) {
            const paceWeight = (player.bowlerPace || 3) / 5;
            score *= (1 + (pitchEffect.paceBonus - 1) * paceWeight);
        }

        // Talent bonuses — format-aware
        const talents = player.talents || [];
        const hasTalent = (regex) => talents.some(t => regex.test(t));

        // New Ball Bowler: more valuable in OD (new ball matters more in longer format)
        if (hasTalent(/new ball bowler/i)) score *= isT20 ? 1.10 : 1.15;
        // Old Ball Bowler: more valuable in T20 (death overs are critical)
        if (hasTalent(/old ball bowler/i)) score *= isT20 ? 1.15 : 1.10;
        // NOTE: Seam/Spin Specialist do NOT belong here. Official manual:
        // "performs better than normal when BATTING against seam/spin
        // bowlers" — a batting matchup talent, not a bonus to the
        // player's own bowling. Previously misapplied here; moved to
        // calculateBattingScore(), conditioned on the opponent's actual
        // bowling mix (opponentAnalysis.seamerCount/spinnerCount).
        // Skilled bowling: more impactful in T20
        if (hasTalent(/skilled.*bowling/i)) score += isT20 ? 7 : 5;

        // Triggered delivery talents (Wrongun/Flipper/Swing/Bouncer/
        // Yorker/Slower Ball/Arm Ball/Doosra) — official manual confirms
        // each exists and is real ("particularly skilled at bowling a
        // ...") but does NOT quantify the in-match effect size. Previously
        // ignored entirely, which is worse than a conservative estimate —
        // applying a small flat bonus per matching talent (roughly half
        // of the quantified Skilled bonus, reflecting real-but-narrower/
        // situational value) rather than continuing to treat them as
        // invisible to scoring.
        const TRIGGERED_BOWLING_TALENTS = /wrongun|flipper|swing|bouncer|yorker|slower ball|arm ball|doosra/i;
        const triggeredBowlingCount = talents.filter(t => TRIGGERED_BOWLING_TALENTS.test(t)).length;
        if (triggeredBowlingCount > 0) score += triggeredBowlingCount * (isT20 ? 3.5 : 2.5);

        // Youth bonus: training talents suggest higher ceiling
        if (isYouth) {
            if (hasTalent(/prodigy/i)) score *= 1.10;
            if (hasTalent(/gifted.*bowling/i)) score *= 1.05;
        }

        return score;
    }

    function calculateKeepingScore(player) {
        return (player.keeping * 3) + (player.batting * 1) + (player.experience * 0.5) +
               (player.form * 1) + (player.fatigue * 0.3);
    }

    function calculateCaptainScore(player) {
        // Wiki: "select the player with the highest captaincy and experience"
        // Forum (FTP-asharrio, official GM): captaincy skill is capped at
        // Outstanding(10) — it never trains/displays past that, unlike
        // other skills which run to Legendary(15). No code change needed
        // here since parseSkill() just reflects whatever the page shows,
        // but don't be surprised two "10/Outstanding" captains tie on
        // this term — experience is the tiebreaker per the same thread.
        let score = (player.captaincy * 3) + (player.experience * 2) + (player.batting * 0.5) +
                    (player.form * 0.5) + (player.fatigue * 0.3);
        // Natural Leader talent — captaincy bonus
        if (player.talents?.some(t => /natural leader/i.test(t))) score *= 1.20;
        return score;
    }

    // ============================================================
    // OPPOSITION ANALYSIS
    // ============================================================
    function analyzeOpposition(opponentPlayers, myPlayers = null) {
        if (!opponentPlayers || opponentPlayers.length === 0) return null;
        const seniors = opponentPlayers.filter(p => p.isSenior);
        const playingSquad = seniors.length > 0 ? seniors : opponentPlayers.slice(0, 11);

        // Use experience (0-15 scale) as a more reliable indicator than raw rating
        const avgExp = playingSquad.reduce((s, p) => s + p.experience, 0) / playingSquad.length;
        const avgForm = playingSquad.reduce((s, p) => s + p.form, 0) / playingSquad.length;
        const avgFatigue = playingSquad.reduce((s, p) => s + p.fatigue, 0) / playingSquad.length;

        const seamers = playingSquad.filter(p => p.bowlerCategory === 'seam');
        const spinners = playingSquad.filter(p => p.bowlerCategory === 'spin');
        const allBowlers = playingSquad.filter(p => p.bowlerCategory !== 'none');

        // Bowler effectiveness: use experience as proxy (since we don't have bowling skill)
        const seamExp = seamers.length > 0 ? seamers.reduce((s, p) => s + p.experience, 0) / seamers.length : 0;
        const spinExp = spinners.length > 0 ? spinners.reduce((s, p) => s + p.experience, 0) / spinners.length : 0;

        // Find key bowler (highest experience bowler)
        const keyBowler = [...allBowlers].sort((a, b) => b.experience - a.experience)[0];

        // Opponent talent signals — now possible because fetchOpponentSquad
        // also pulls squadViewId=1 (Talents aren't in the grid view at all,
        // for anyone). Seam/Spin Specialist here are the opponent's
        // BATTERS being good against that bowling type — i.e. a signal for
        // which of MY bowling types to lean on, not a bowling threat.
        // Dangerous-delivery talents are real bowling threats regardless
        // of quantified size (see the triggered-talent scoring notes).
        const oppSeamSpecialistBatters = playingSquad.filter(p => (p.talents || []).some(t => /seam specialist/i.test(t))).length;
        const oppSpinSpecialistBatters = playingSquad.filter(p => (p.talents || []).some(t => /spin specialist/i.test(t))).length;
        const DANGEROUS_BOWLING_TALENTS = /wrongun|flipper|swing|bouncer|yorker|slower ball|arm ball|doosra/i;
        const dangerousBowlers = allBowlers.filter(p => (p.talents || []).some(t => DANGEROUS_BOWLING_TALENTS.test(t)));

        // Compare against my team if provided
        let relativeStrength = 'unknown';
        if (myPlayers && myPlayers.length > 0) {
            const myAvgExp = myPlayers.reduce((s, p) => s + (p.experience || 5), 0) / myPlayers.length;
            const expDiff = avgExp - myAvgExp;
            if (expDiff > 1.5) relativeStrength = 'stronger';
            else if (expDiff < -1.5) relativeStrength = 'weaker';
            else relativeStrength = 'similar';
        }

        // Strength classification based on experience (0-15 scale)
        // 0-3 = weak, 4-7 = average, 8-10 = strong, 11+ = dominant
        let strength;
        if (avgExp >= 9) strength = 'elite';
        else if (avgExp >= 7) strength = 'strong';
        else if (avgExp >= 5) strength = 'average';
        else strength = 'weak';

        return {
            playerCount: playingSquad.length,
            avgExp,
            avgForm,
            avgFatigue,
            seamerCount: seamers.length,
            spinnerCount: spinners.length,
            seamExp,
            spinExp,
            keyBowler,
            strength,
            relativeStrength,
            // Vulnerability: if their seam attack is weaker than spin, target seam matchup
            pitchVulnerability: seamExp < spinExp ? 'seam' : 'spin',
            // Fatigue: if avg fatigue is low, they're tired
            isFatigued: avgFatigue < 6,
            // Form: if avg form is high, they're in form
            inForm: avgForm > 7,
            // Total bowler count
            totalBowlers: allBowlers.length,
            // Opponent talent signals (see comment above keyBowler)
            oppSeamSpecialistBatters, oppSpinSpecialistBatters,
            dangerousBowlerCount: dangerousBowlers.length,
            dangerousBowlerNames: dangerousBowlers.map(p => p.name)
        };
    }

    // ============================================================
    // TOSS DECISION LOGIC
    // ============================================================
    function recommendTossDecision(context, opponentAnalysis) {
        const pitchEffect = PITCH_EFFECTS[context.pitch] || PITCH_EFFECTS.Sporting;
        const weatherEffect = WEATHER_EFFECTS[context.weather] || WEATHER_EFFECTS.Sunny;
        const pitch = context.pitch;
        const weather = context.weather;
        const isT20 = context.matchType === 'T20' || context.matchType === 'YT20';

        let decision, reason;

        // Based on Admin team's expert guide:
        // - Flat: Chase in almost all instances
        // - Hard: Bat first strongly recommended
        // - Uneven: Depends on team (bat first if batting stronger, bowl first if seam stronger)
        // - Slow: Sometimes bat first (RRR pressure builds naturally)
        // - Dry: Bat first to force grind
        // - Crumbling: Bat first (deep batting needed)
        // - Sticky: Bat first (RRR pressure route)

        if (pitch === 'Flat') {
            decision = 'bowl';
            reason = 'Flat pitch: Chase in almost all instances. Expert advice: "Nothing is unchaseable on Flat - 350+ scores possible."';
        } else if (pitch === 'Hard') {
            decision = 'bat';
            reason = 'Hard pitch: Bat first STRONGLY recommended. Expert: "The least useful pitch strategically - neutralizes spin/mediums, rewards good F/FM."';
        } else if (pitch === 'Uneven') {
            // Depends on team strength
            if (opponentAnalysis && opponentAnalysis.relativeStrength === 'weaker') {
                decision = 'bat';
                reason = 'Uneven pitch: Opponent is weaker overall. Bat first to create RRR pressure and make the chase difficult.';
            } else if (opponentAnalysis && opponentAnalysis.relativeStrength === 'stronger') {
                decision = 'bowl';
                reason = 'Uneven pitch: Opponent is stronger overall. Bowl first to attack early and create pressure around the drinks break.';
            } else {
                decision = 'bat';
                reason = 'Uneven pitch: Teams are similar overall. Bat first to create RRR pressure; good seamers can take wickets throughout.';
            }
        } else if (pitch === 'Green') {
            decision = 'bowl';
            reason = 'Green pitch: Mediums become very effective. Bowl first to exploit seam movement. Biggest Par Score variation (160-270).';
        } else if (pitch === 'Slow') {
            decision = 'bat';
            reason = 'Slow pitch: Sometimes bat first - RRR pressure builds naturally. Late-innings collapses common when chasing. Rewards good batsmen.';
        } else if (pitch === 'Dry') {
            decision = 'bat';
            reason = 'Dry pitch: Bat first to set a target, then force opponents to grind against your spinners. Need 3+ good spinners.';
        } else if (pitch === 'Crumbling') {
            decision = 'bat';
            reason = 'Crumbling pitch: Bat first with deep batting lineup. All bowlers destructive. Wrist spinners single-handedly win games here.';
        } else if (pitch === 'Sticky') {
            decision = 'bat';
            reason = 'Sticky pitch: Bat first and use RRR pressure route. Rewards balanced sides. Wickets fall, steep chases at death.';
        } else if (isT20) {
            decision = 'bowl';
            reason = 'T20 default: Chase often advantageous as you know the target.';
        } else {
            decision = 'bowl';
            reason = 'Standard: Bowl first, chase with knowledge of target.';
        }

        // Weather notes — official manual confirms these effects on
        // bowling types, which matters for your attack selection.
        // NOTE: toss decision remains pitch-based. Weather affects
        // which bowlers to pick, not whether to bat/bowl first.
        const weatherNotes = [];
        if (weather === 'Overcast' || weather === 'Cloudy') {
            weatherNotes.push(`${weather} favours seam bowlers — prioritise seam in your attack.`);
        } else if (weather === 'Hot') {
            weatherNotes.push('Hot: seam bowlers perform worse. Lean on spin.');
        } else if (weather === 'Humid') {
            weatherNotes.push('Humid: seam bowlers enjoy it, spinners struggle. Lean on seam.');
        } else if (weather === 'Windy') {
            weatherNotes.push('Windy: slightly favours spin bowlers.');
        }

        // T20 override: Hard/Crumbling pitches still bat first even in
        // T20. All other pitches default to bowl (chase) — the pitch-
        // specific logic above already handles this correctly, so no
        // additional override needed.

        if (weatherNotes.length > 0) {
            reason += ' Weather: ' + weatherNotes.join(' ');
        }

        return { decision, reason };
    }

    // ============================================================
    // LINEUP RECOMMENDATION (with LH/RH mixing + bowling variety)
    // ============================================================
    function recommendLineup(availablePlayers, context, opponentAnalysis) {        // Keep every downstream selector on a unique candidate set. This is
        // a hard invariant: the XI and batting order cannot contain a player
        // twice, even if a page/cache scrape briefly duplicates a row.
        availablePlayers = dedupePlayers(availablePlayers);
        const pitchEffect = PITCH_EFFECTS[context.pitch] || PITCH_EFFECTS.Sporting;
        const weatherEffect = WEATHER_EFFECTS[context.weather] || WEATHER_EFFECTS.Sunny;
        const isT20 = context.matchType === 'T20' || context.matchType === 'YT20';
        const isYouth = context.isYouthOnly;

        const ranked = availablePlayers.map(p => {
            let batScore = calculateBattingScore(p, pitchEffect, weatherEffect, isT20, isYouth, context.isHome);
            let bowlScore = calculateBowlingScore(p, pitchEffect, weatherEffect, isT20, isYouth, context.isHome);
            let keepScore = calculateKeepingScore(p);

            if (opponentAnalysis) {
                if (opponentAnalysis.pitchVulnerability === 'seam' && p.bowlerCategory === 'seam') bowlScore *= 1.25;
                if (opponentAnalysis.pitchVulnerability === 'spin' && p.bowlerCategory === 'spin') bowlScore *= 1.25;
                if (opponentAnalysis.isFatigued) {
                    bowlScore *= 1.1;
                    batScore *= 1.05;
                }
                // Seam/Spin Specialist are BATTING matchup talents
                // (official manual: "performs better than normal when
                // batting against seam/spin bowlers") — apply based on
                // which type the OPPONENT actually bowls more of, not
                // the player's own bowling category.
                const talents = p.talents || [];
                const hasTalent = (regex) => talents.some(t => regex.test(t));
                if (hasTalent(/seam specialist/i) && opponentAnalysis.seamerCount > opponentAnalysis.spinnerCount) batScore *= 1.1;
                if (hasTalent(/spin specialist/i) && opponentAnalysis.spinnerCount > opponentAnalysis.seamerCount) batScore *= 1.1;

                // If more of THEIR batters hold Seam Specialist than Spin
                // Specialist, they're comparatively less prepared for
                // spin (and vice versa) — lean on the bowling type their
                // own talent investment didn't cover.
                if (opponentAnalysis.oppSeamSpecialistBatters > opponentAnalysis.oppSpinSpecialistBatters && p.bowlerCategory === 'spin') bowlScore *= 1.1;
                if (opponentAnalysis.oppSpinSpecialistBatters > opponentAnalysis.oppSeamSpecialistBatters && p.bowlerCategory === 'seam') bowlScore *= 1.1;
            }

            return {
                ...p,
                batScore,
                bowlScore,
                keepScore,
                captainScore: calculateCaptainScore(p),
                isSeamer: p.bowlerCategory === 'seam',
                isSpinner: p.bowlerCategory === 'spin',
                isBowler: p.bowlerCategory !== 'none' || p.bowling >= MIN_BOWLING_FOR_BOWLERS,
                pitchEffect, weatherEffect
            };
        });

        // Step 1: Pick keeper (highest keeping, cannot bowl)
        const keepers = ranked.filter(p => p.keeping >= 3).sort((a, b) => b.keepScore - a.keepScore);
        const keeper = keepers[0];

        // Step 2: Pick top 5 batsmen (alternating LH/RH for bowler penalty)
        // Wiki: LH/RH partnerships cause penalty to bowlers → mix them!
        const sortedBatters = [...ranked].sort((a, b) => b.batScore - a.batScore);
        const topBatsmen = [];
        const used = new Set();
        if (keeper) used.add(keeper.id);

        // Try to alternate LH/RH in top 5
        const leftHanded = sortedBatters.filter(p => p.isLeftHanded && !used.has(p.id));
        const rightHanded = sortedBatters.filter(p => !p.isLeftHanded && !used.has(p.id));

        // Take 2-3 of each type to mix
        for (let i = 0; i < 3 && rightHanded.length > 0; i++) {
            topBatsmen.push(rightHanded.shift());
            used.add(topBatsmen[topBatsmen.length - 1].id);
        }
        for (let i = 0; i < 2 && leftHanded.length > 0; i++) {
            topBatsmen.push(leftHanded.shift());
            used.add(topBatsmen[topBatsmen.length - 1].id);
        }
        while (topBatsmen.length < 5) {
            const next = sortedBatters.find(p => !used.has(p.id));
            if (!next) break;
            topBatsmen.push(next);
            used.add(next.id);
        }

        // Step 3: Pick bowlers (seam + spin variety per wiki)
        const seamers = ranked.filter(p => p.isSeamer).sort((a, b) => b.bowlScore - a.bowlScore);
        const spinners = ranked.filter(p => p.isSpinner).sort((a, b) => b.bowlScore - a.bowlScore);
        // Also consider all-rounders: batters with good bowling (not designated bowlers)
        const allRounders = ranked.filter(p => !p.isSeamer && !p.isSpinner && p.bowling >= MIN_BOWLING_FOR_BOWLERS)
            .sort((a, b) => b.bowlScore - a.bowlScore);

        // Wiki: prefer not too many of same type, balanced LH/RH mix
        // Game rule: ALL selected bowlers MUST be in the batting lineup
        const bowlerPicks = [];
        // Priority 1: Designated seamers + spinners (variety matters per wiki)
        if (seamers.length > 0 && !used.has(seamers[0].id)) { bowlerPicks.push(seamers[0]); used.add(seamers[0].id); }
        if (spinners.length > 0 && !used.has(spinners[0].id)) { bowlerPicks.push(spinners[0]); used.add(spinners[0].id); }
        if (seamers.length > 1 && !used.has(seamers[1].id)) { bowlerPicks.push(seamers[1]); used.add(seamers[1].id); }
        if (spinners.length > 1 && !used.has(spinners[1].id)) { bowlerPicks.push(spinners[1]); used.add(spinners[1].id); }
        if (seamers.length > 2 && !used.has(seamers[2].id) && bowlerPicks.length < 5) { bowlerPicks.push(seamers[2]); used.add(seamers[2].id); }
        if (spinners.length > 2 && !used.has(spinners[2].id) && bowlerPicks.length < 5) { bowlerPicks.push(spinners[2]); used.add(spinners[2].id); }
        // Priority 2: All-rounders (batters who can bowl) — fills gaps if not enough designated bowlers
        for (const ar of allRounders) {
            if (bowlerPicks.length >= 5) break;
            if (!used.has(ar.id)) { bowlerPicks.push(ar); used.add(ar.id); }
        }

        // Step 4: Pick captain (highest captaincy + experience in lineup)
        const lineup = [keeper, ...topBatsmen, ...bowlerPicks].filter(Boolean);

        // Ensure ALL bowlers are in the lineup (game requirement)
        // If a bowler was selected but not in topBatsmen, add them
        bowlerPicks.forEach(b => {
            if (!lineup.find(p => p.id === b.id)) {
                lineup.push(b);
            }
        });

        const captain = [...lineup].sort((a, b) => b.captainScore - a.captainScore)[0];
        if (captain) captain.isCaptain = true;

        // Assign roles
        lineup.forEach((p, i) => {
            if (p.role === 'WK' || (keeper && p.id === keeper.id)) p.role = 'WK';
            else if (bowlerPicks.find(b => b.id === p.id)) p.role = topBatsmen.find(b => b.id === p.id) ? 'AR' : 'BOWL';
            else if (p.isBowler && p.bowling >= MIN_BOWLING_FOR_BOWLERS) p.role = 'AR'; // batter who can bowl
            else p.role = 'BAT';
        });

        // Fill to 11 if needed
        const fillers = ranked.filter(p => !used.has(p.id)).sort((a, b) => b.batScore - a.batScore);
        while (lineup.length < 11 && fillers.length > 0) {
            const p = fillers.shift();
            lineup.push({ ...p, role: (p.bowlerCategory !== 'none' || p.bowling >= MIN_BOWLING_FOR_BOWLERS) ? 'AR' : 'BAT' });
            used.add(p.id);
        }

        return dedupePlayers(lineup).slice(0, 11);
    }

    // ============================================================
    // BATTING ORDER (with LH/RH mixing for partnerships)
    // ============================================================
    // FTP game tactics: 2=Normal, 4=Defensive, 5=Aggressive
    // T20 and OD require different phase strategies — the game engine
    // penalises defensive batting in T20 (too slow to set a chaseable
    // total) and aggressive batting early in OD (risk losing wickets
    // before establishing a platform).
    function recommendBattingOrder(lineup, context, opponentAnalysis) {
        lineup = dedupePlayers(lineup);
        // Wiki: LH/RH partnerships cause bowler penalty → mix them
        // Opener pairs: try to pair LH + RH
        // Best batsman at #3 or #4 (anchor)
        // Keeper in top 7
        // Bowlers at #8-#11 (tail)

        const isT20 = context && (context.matchType === 'T20' || context.matchType === 'YT20');
        const isOD = context && (context.matchType === 'OD' || context.matchType === 'YOD');
        const hasDangerousBowlers = (opponentAnalysis?.dangerousBowlerCount || 0) > 0;

        const hasTalent = (player, regex) => (player.talents || []).some(t => regex.test(t));
        const openerIds = new Set();
        const finisherIds = new Set();
        lineup.forEach(p => {
            if (hasTalent(p, /^opener$/i)) openerIds.add(p.id);
            if (hasTalent(p, /finisher/i)) finisherIds.add(p.id);
        });

        const ordered = [];
        const used = new Set();

        // Sort by batScore
        const sorted = [...lineup].sort((a, b) => b.batScore - a.batScore);

        // Position 1-2: Openers — prefer Opener talent, then best RH/LH
        const rhBatsmen = sorted.filter(p => !p.isLeftHanded && !used.has(p.id));
        const lhBatsmen = sorted.filter(p => p.isLeftHanded && !used.has(p.id));

        // Prefer Opener talent at position 1
        let pos1 = rhBatsmen.find(p => openerIds.has(p.id)) || lhBatsmen.find(p => openerIds.has(p.id));
        if (!pos1) pos1 = rhBatsmen[0] || lhBatsmen[0];
        if (pos1) {
            // T20 openers: Normal to survive new ball, then accelerate
            // OD openers: Normal to build platform
            ordered.push({ ...pos1, position: 1, battingTactic: 2 });
            used.add(pos1.id);
        }

        // Position 2: Opposite hand if possible, also prefer Opener talent
        const remainingRH = sorted.filter(p => !p.isLeftHanded && !used.has(p.id));
        const remainingLH = sorted.filter(p => p.isLeftHanded && !used.has(p.id));
        let pos2;
        const preferOpposite = pos1 && pos1.isLeftHanded;
        if (preferOpposite) {
            pos2 = remainingRH.find(p => openerIds.has(p.id)) || remainingRH[0];
        } else {
            pos2 = remainingLH.find(p => openerIds.has(p.id)) || remainingLH[0];
        }
        if (!pos2) pos2 = remainingRH[0] || remainingLH[0]; // fallback if no opposite hand
        if (pos2) {
            ordered.push({ ...pos2, position: 2, battingTactic: 2 });
            used.add(pos2.id);
        }

        // Position 3: Best remaining batsman (anchor)
        // OD: Defensive (anchor the innings, build a platform)
        // T20: Normal (accelerate from the start — can't afford to
        //   dot-ball through the powerplay)
        const remaining = sorted.filter(p => !used.has(p.id));
        if (remaining.length > 0) {
            const anchor = remaining.shift();
            ordered.push({ ...anchor, position: 3, battingTactic: isT20 ? 2 : 4 });
            used.add(anchor.id);
        }

        // Position 4: Next best, alternate LH/RH
        // OD: Normal — rotate strike, build partnerships
        // T20: Aggressive — attack from ball 1 in the middle overs
        {
            const nextRH = sorted.find(p => !p.isLeftHanded && !used.has(p.id));
            const nextLH = sorted.find(p => p.isLeftHanded && !used.has(p.id));
            const pick = (ordered.length % 2 === 0 ? nextRH : nextLH) || nextRH || nextLH;
            if (pick) {
                ordered.push({ ...pick, position: 4, battingTactic: isT20 ? 5 : 2 });
                used.add(pick.id);
            }
        }

        // Position 5-8: Finisher preference zone — experienced-player
        // feedback puts Finisher talent at 5-7 (lower middle order: arrives
        // late enough to face the death overs but not buried in the tail),
        // so the finisher-preference window starts at position 5 instead of
        // the old 7. Keeper is slotted at #6 (still top 7, per the existing
        // keeper-in-top-7 convention).
        // OD: bowlers Aggressive (slog), batters Normal — late-order hitting
        // T20: Aggressive — death overs hitting (Finisher talent shines here)
        const keeper = lineup.find(p => p.role === 'WK' && !used.has(p.id));
        let remaining2 = sorted.filter(p => !used.has(p.id));
        while (ordered.length < 8 && remaining2.length > 0) {
            const pos = ordered.length + 1;
            let pick;
            if (keeper && pos === 6 && !used.has(keeper.id)) {
                pick = keeper;
                remaining2 = remaining2.filter(p => p.id !== keeper.id);
            } else {
                const finisher = remaining2.find(p => finisherIds.has(p.id));
                if (finisher) {
                    pick = finisher;
                    remaining2 = remaining2.filter(p => p.id !== finisher.id);
                } else {
                    pick = remaining2.shift(); // only one shift
                }
            }
            if (!pick) break;
            const isBowler = pick.bowlerCategory !== 'none' || pick.bowling >= MIN_BOWLING_FOR_BOWLERS;
            // T20: everyone aggressive in death overs
            // OD: bowlers Aggressive (slog), batters Normal; dangerous lower order is protected
            // Against triggered delivery talents, protect the actual lower
            // order in OD: surviving the dangerous spell is more valuable
            // than asking #8 to #11 to slog. T20 keeps its death-over
            // aggression because defensive batting there gives up too much
            // scoring rate; the warning below explains that trade-off.
            const protectLowerOrder = isOD && hasDangerousBowlers && pos >= 8;
            const tactic = isT20 ? 5 : (protectLowerOrder ? 4 : (isBowler ? 5 : 2));
            ordered.push({ ...pick, position: pos, battingTactic: tactic });
            used.add(pick.id);
        }

        // Position 9-11: Bowlers/sloggers. Normally the tail swings for the
        // boundary; in an OD against dangerous delivery talents, preserving
        // wickets through the threat is the safer recommendation.
        remaining2 = sorted.filter(p => !used.has(p.id));
        while (ordered.length < 11 && remaining2.length > 0) {
            const p = remaining2.shift();
            if (!p) break;
            const position = ordered.length + 1;
            const tactic = isOD && hasDangerousBowlers ? 4 : 5;
            ordered.push({ ...p, position, battingTactic: tactic });
            used.add(p.id);
        }

        return dedupePlayers(ordered).map((player, index) => ({ ...player, position: index + 1 }));
    }

    // ============================================================
    // BOWLING SPELL ALLOCATION
    // ============================================================
    function allocateBowlingSpells(lineup, context, opponentAnalysis) {
        const totalOvers = context.overs;
        const isT20 = context.matchType === 'T20' || context.matchType === 'YT20';
        // Confirmed verbatim (rules.htm?rulespage=competitions): "There are
        // 5-10 bowlers who can each bowl a maximum of 10 overs each" (Senior
        // OD), "...4 overs each" (Senior T20), "...8 overs each" (Youth OD —
        // NOT 10, a real format difference from Senior OD), "...4 overs
        // each" (Youth T20). This used to be a flat isT20 ? 4 : 10, which
        // silently let Youth OD bowling plans allocate up to 10 overs to a
        // single bowler — 2 more than the format actually allows.
        // Min spell (2 OD / 1 T20) is also manual-confirmed; there is no
        // stated MAX-per-spell rule for any format, so the per-spell cap
        // below is a heuristic margin (never hand a bowler their entire
        // match quota in one continuous burst), kept proportionate to each
        // format's real per-bowler max rather than a flat 8.
        const MAX_OVERS_PER_BOWLER = { OD: 10, YOD: 8, T20: 4, YT20: 4 };
        const maxPerBowler = MAX_OVERS_PER_BOWLER[context.matchType] || (isT20 ? 4 : 10);
        const maxPerSpell = isT20 ? maxPerBowler : Math.max(2, maxPerBowler - 2);
        const minPerSpell = isT20 ? 1 : 2;
        const perEnd = totalOvers / 2;

        const pitchEffect = PITCH_EFFECTS[context.pitch] || PITCH_EFFECTS.Sporting;
        const weatherEffect = WEATHER_EFFECTS[context.weather] || WEATHER_EFFECTS.Sunny;

        // Forum guidance (Bowling Orders: Tips thread): fatigue/endurance
        // matter for spell planning, not just who to pick — a tired
        // bowler given a long continuous spell will fade badly by the
        // end of it. Cap how long any single spell can run based on the
        // bowler's current fatigue, independent of the pitch/skill score.
        // Sturdy talent: recovers from fatigue faster → longer spell allowed.
        function fatigueSpellCap(bowler) {
            const hasSturdy = (bowler.talents || []).some(t => /sturdy/i.test(t));
            if (bowler.fatigue <= 1) return Math.ceil(maxPerSpell / 4); // Shattered/dead: minimal burst only
            if (bowler.fatigue <= 3) return Math.ceil(maxPerSpell / 2); // Listless/exhausted: half a normal spell
            if (bowler.fatigue <= 5) return maxPerSpell - (isT20 ? 1 : 2); // Moderate: slightly shortened
            return hasSturdy ? maxPerSpell + 1 : maxPerSpell; // Sturdy: can bowl +1 over per spell
        }

        // "A fresh, high-endurance bowler against the tail can work
        // wonders" — real community bowling tactic (user-supplied,
        // consistent with the manual's own "energy is partially
        // replenished during drinks breaks" note already used for the
        // v8.32 rest-across-break check). Endurance is already part of
        // calculateBowlingScore's base formula, but WHO gets handed the
        // death-overs slot was picked by raw skill rank alone — this adds
        // a modest endurance-weighted nudge among genuinely death-capable
        // candidates, not a skill override (max +8% for a Legendary(15)
        // endurance bowler, same conservative-estimate philosophy as the
        // unquantified triggered-talent bonuses elsewhere in this file).
        // Shared by the 6+ and 5-bowler allocation paths so the formula
        // lives in exactly one place.
        function rankForDeathOvers(candidates) {
            const deathScore = (b) => b.bowlScore * (1 + (b.endurance || 0) / 15 * 0.08);
            return [...candidates].sort((a, b) => deathScore(b) - deathScore(a));
        }

        const bowlers = lineup.filter(p => {
            const isKeeper = p.role === 'WK' || (p.keeping >= 4 && p.keeping > p.bowling);
            if (isKeeper) return false;
            return p.bowlerCategory !== 'none' || p.bowling >= MIN_BOWLING_FOR_BOWLERS;
        }).map(p => {
            let bs = calculateBowlingScore(p, pitchEffect, weatherEffect, isT20, context.isYouthOnly, context.isHome);
            // Apply opponent analysis adjustments — same logic as
            // recommendLineup's post-hoc adjustments, so the allocation
            // ranking is consistent with the XI selection.
            if (opponentAnalysis) {
                if (opponentAnalysis.pitchVulnerability === 'seam' && p.bowlerCategory === 'seam') bs *= 1.25;
                if (opponentAnalysis.pitchVulnerability === 'spin' && p.bowlerCategory === 'spin') bs *= 1.25;
                if (opponentAnalysis.isFatigued) bs *= 1.1;
                // Opponent batting weakness: if they have more Seam
                // Specialist batters, they're LESS vulnerable to seam →
                // spin gets an edge (and vice versa)
                if (opponentAnalysis.oppSeamSpecialistBatters > opponentAnalysis.oppSpinSpecialistBatters && p.bowlerCategory === 'spin') bs *= 1.1;
                if (opponentAnalysis.oppSpinSpecialistBatters > opponentAnalysis.oppSeamSpecialistBatters && p.bowlerCategory === 'seam') bs *= 1.1;
            }
            return { ...p, bowlScore: bs };
        }).sort((a, b) => b.bowlScore - a.bowlScore);

        // Talent-aware bowler ranking: New Ball Bowler gets priority for opening spells
        const hasTalent = (player, regex) => (player.talents || []).some(t => regex.test(t));
        const newBallBowlers = bowlers.filter(b => hasTalent(b, /new ball bowler/i));
        const oldBallBowlers = bowlers.filter(b => hasTalent(b, /old ball bowler/i));

        const cap = {};
        bowlers.forEach(b => { cap[b.id] = maxPerBowler; });

        const gSpells = [];
        const sSpells = [];

        function addSpellTo(end, bowler, overs, phase, endName) {
            const capLeft = cap[bowler.id] || 0;
            if (capLeft < minPerSpell) return 0;
            const c = Math.min(overs, fatigueSpellCap(bowler), capLeft);
            if (c < minPerSpell) return 0;
            end.push({ player: bowler, overs: c, phase, end: endName });
            cap[bowler.id] -= c;
            return c;
        }

        function endTotal(spells) { return spells.reduce((s, x) => s + x.overs, 0); }

        // v8.81 attempt #1 (reverted): tried removing fillEnd() entirely so
        // fixEndTotal()'s smarter extend-existing-spell-first Strategy 1
        // would run instead of fillEnd's simpler "always add a new spell"
        // loop — motivated by a real user report of a bowler getting THREE
        // separate spells (3+2+3) instead of a clean two-spell 5-before/3-
        // after split. That removal broke a genuinely different case:
        // fillEnd's one-shot "give the whole deficit to one new spell"
        // approach never leaves a stuck partial remainder, but
        // fixEndTotal's Strategy 1 (PARTIAL extension of an existing spell)
        // can — e.g. taking 2 of a 3-over deficit via extension can strand
        // exactly 1 over that's too small for any strategy to legally turn
        // into a new spell (minPerSpell=2), even though a single untouched
        // bowler could have absorbed the full 3-over deficit as one clean
        // new spell. Confirmed via harness: an under-resourced 7-bowler OD
        // lineup went from a full 25/25 allocation to a stuck 24/25 the
        // moment fillEnd was removed. fillEnd is restored below. The
        // ACTUAL fragmentation fix lives one layer up, in the drinks-break
        // partitionSideSpells() rewrite (see its own v8.81 comment) — it
        // now MERGES a bowler's spells on an end by player before deciding
        // how to split across the break, so it produces at most 2 pieces
        // per bowler regardless of how many fragments the base allocator
        // (fillEnd + fixEndTotal, unchanged) happened to produce — the
        // fragmentation source turned out not to matter once the layer
        // that actually renders the before/after split normalizes it.
        function fillEnd(spells, target, endName) {
            let need = target - endTotal(spells);
            if (need <= 0) return;
            const otherEnd = endName === 'Gibson' ? sSpells : gSpells;
            const lastOtherBowler = otherEnd.length > 0 ? otherEnd[otherEnd.length - 1].player.id : null;
            for (const b of bowlers) {
                if (need <= 0) break;
                const capLeft = cap[b.id] || 0;
                if (capLeft < minPerSpell) continue;
                if (b.id === lastOtherBowler) continue;
                const c = Math.min(need, fatigueSpellCap(b), capLeft);
                if (c >= minPerSpell) {
                    spells.push({ player: b, overs: c, phase: 'Death overs', end: endName }); cap[b.id] -= c; need -= c;
                }
            }
        }

        const nb = bowlers.length;

        if (nb >= 6) {
            // Talent-aware selection: prefer New Ball Bowler for opening spells
            // sel[0], sel[1] = opening bowlers; sel[2], sel[3] = middle; sel[4], sel[5] = death
            let sel = bowlers.slice(0, 6);

            // If we have a New Ball Bowler talent, prioritize them for opening
            if (newBallBowlers.length > 0) {
                const opener = newBallBowlers[0];
                // Move opener to front if not already there
                if (sel[0].id !== opener.id && sel[1].id !== opener.id) {
                    // Replace the lowest-scoring opener
                    if (opener.bowlScore > sel[1].bowlScore) {
                        sel[1] = opener;
                    } else if (opener.bowlScore > sel[0].bowlScore) {
                        sel[0] = opener;
                    }
                }
            }
            // Death-overs freshness — re-pick sel[4]/sel[5] from a
            // slightly wider pool (next few candidates after the
            // openers/middle overs bowlers, not strictly the next-best
            // skill rank) using rankForDeathOvers(). Runs BEFORE the Old
            // Ball Bowler override below so a real talent match still
            // wins over the generic endurance nudge.
            const deathUsedIds = new Set([sel[0].id, sel[1].id, sel[2].id, sel[3].id]);
            const deathPool = bowlers.filter(b => !deathUsedIds.has(b.id)).slice(0, 4);
            if (deathPool.length >= 2) {
                const rankedDeath = rankForDeathOvers(deathPool);
                sel[4] = rankedDeath[0];
                sel[5] = rankedDeath[1];
            }
            // If we have an Old Ball Bowler talent, prioritize for death overs
            if (oldBallBowlers.length > 0) {
                const closer = oldBallBowlers[0];
                if (sel[4].id !== closer.id && sel[5].id !== closer.id) {
                    if (closer.bowlScore > sel[4].bowlScore) {
                        sel[4] = closer;
                    } else if (closer.bowlScore > sel[5].bowlScore) {
                        sel[5] = closer;
                    }
                }
            }

            if (isT20) {
                addSpellTo(gSpells, sel[0], Math.min(4, perEnd), 'New ball', 'Gibson');
                addSpellTo(gSpells, sel[2], Math.min(4, perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
                addSpellTo(gSpells, sel[4], perEnd - endTotal(gSpells), 'Death overs', 'Gibson');
                addSpellTo(sSpells, sel[1], Math.min(4, perEnd), 'New ball', 'Southern');
                addSpellTo(sSpells, sel[3], Math.min(4, perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
                addSpellTo(sSpells, sel[5], perEnd - endTotal(sSpells), 'Death overs', 'Southern');
            } else {
                addSpellTo(gSpells, sel[0], Math.min(6, perEnd), 'New ball', 'Gibson');
                addSpellTo(gSpells, sel[2], Math.min(maxPerSpell, perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
                addSpellTo(gSpells, sel[4], perEnd - endTotal(gSpells), 'Death overs', 'Gibson');
                addSpellTo(sSpells, sel[1], Math.min(6, perEnd), 'New ball', 'Southern');
                addSpellTo(sSpells, sel[3], Math.min(maxPerSpell, perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
                addSpellTo(sSpells, sel[5], perEnd - endTotal(sSpells), 'Death overs', 'Southern');
            }
            fillEnd(gSpells, perEnd, 'Gibson');
            fillEnd(sSpells, perEnd, 'Southern');

        } else if (nb >= 5) {
            const shared = bowlers[0];
            const halfMax = Math.floor(maxPerSpell / 2);

            let midBowler, deathBowler;
            if (pitchEffect.seam > 1.1) {
                midBowler = bowlers.find(b => b.bowlerCategory === 'seam' && b.id !== shared.id && b.id !== bowlers[1].id) || bowlers[2];
            } else {
                midBowler = bowlers[2];
            }
            // Death-overs freshness — see rankForDeathOvers().
            const deathCandidates = bowlers.filter(b => b.id !== shared.id && b.id !== bowlers[1].id && b.id !== midBowler.id);
            deathBowler = deathCandidates.length > 0 ? rankForDeathOvers(deathCandidates)[0] : bowlers[3];

            addSpellTo(gSpells, shared, Math.min(halfMax, perEnd), 'New ball', 'Gibson');
            addSpellTo(gSpells, midBowler, Math.min(maxPerSpell, perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
            addSpellTo(gSpells, deathBowler, perEnd - endTotal(gSpells), 'Death overs', 'Gibson');

            addSpellTo(sSpells, bowlers[1], Math.min(maxPerSpell, perEnd), 'New ball', 'Southern');
            addSpellTo(sSpells, bowlers[4], Math.min(maxPerSpell, perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
            addSpellTo(sSpells, shared, perEnd - endTotal(sSpells), 'Death overs', 'Southern');
            fillEnd(gSpells, perEnd, 'Gibson');
            fillEnd(sSpells, perEnd, 'Southern');

        } else if (nb >= 4) {
            const halfMax = Math.floor(maxPerSpell / 2);

            addSpellTo(gSpells, bowlers[0], Math.min(halfMax, perEnd), 'New ball', 'Gibson');
            addSpellTo(gSpells, bowlers[2], Math.min(maxPerSpell, perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
            addSpellTo(gSpells, bowlers[1], perEnd - endTotal(gSpells), 'Death overs', 'Gibson');

            addSpellTo(sSpells, bowlers[1], Math.min(halfMax, perEnd), 'New ball', 'Southern');
            addSpellTo(sSpells, bowlers[3], Math.min(maxPerSpell, perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
            addSpellTo(sSpells, bowlers[0], perEnd - endTotal(sSpells), 'Death overs', 'Southern');
            fillEnd(gSpells, perEnd, 'Gibson');
            fillEnd(sSpells, perEnd, 'Southern');

        } else if (nb >= 3) {
            addSpellTo(gSpells, bowlers[0], Math.min(Math.floor(maxPerSpell / 2), perEnd), 'New ball', 'Gibson');
            addSpellTo(gSpells, bowlers[1], Math.min(Math.floor(maxPerSpell / 2), perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
            addSpellTo(gSpells, bowlers[2], perEnd - endTotal(gSpells), 'Death overs', 'Gibson');

            addSpellTo(sSpells, bowlers[2], Math.min(Math.floor(maxPerSpell / 2), perEnd), 'New ball', 'Southern');
            addSpellTo(sSpells, bowlers[0], Math.min(Math.floor(maxPerSpell / 2), perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
            addSpellTo(sSpells, bowlers[1], perEnd - endTotal(sSpells), 'Death overs', 'Southern');
            fillEnd(gSpells, perEnd, 'Gibson');
            fillEnd(sSpells, perEnd, 'Southern');

        } else {
            for (let end = 0; end < 2; end++) {
                const target = end === 0 ? gSpells : sSpells;
                const endName = end === 0 ? 'Gibson' : 'Southern';
                for (const b of bowlers) {
                    const rem = perEnd - endTotal(target);
                    if (rem <= 0) break;
                    addSpellTo(target, b, rem, end === 0 ? 'New ball' : 'Middle overs', endName);
                }
            }
        }

        // ---- Final safety net: fix any remaining deficit by extending existing spells ----
        // In OD/YOD, minimum 2 overs per spell is a hard rule.
        // We never create a 1-over spell. Instead, extend an existing spell of a
        // bowler who still has cap room, or rebalance earlier spells.
        function fixEndTotal(spells, target, endName) {
            let deficit = target - endTotal(spells);
            if (deficit <= 0) return;

            // Strategy 1: extend an existing spell of a bowler who has cap room
            // (and who isn't the last bowler on the other end — adjacency)
            const otherEnd = endName === 'Gibson' ? sSpells : gSpells;
            const lastOtherBowler = otherEnd.length > 0 ? otherEnd[otherEnd.length - 1].player.id : null;

            // Sort spells by bowlScore descending (extend best bowlers first)
            const sortedSpells = [...spells].sort((a, b) => b.bowlScore - a.bowlScore);
            for (const spell of sortedSpells) {
                if (deficit <= 0) break;
                const capLeft = cap[spell.player.id] || 0;
                if (capLeft <= 0) continue;
                // v8.81: also clamp to fatigueSpellCap, not just maxPerSpell —
                // this is now the ONLY place that closes a same-end deficit
                // by extending (fillEnd(), which used fatigueSpellCap but ran
                // BEFORE this and could preempt it, was removed — see the
                // fillEnd() removal note below). Without this clamp, a
                // moderately/heavily fatigued bowler's spell could be
                // extended past what their fatigue realistically allows in
                // one continuous burst, purely because maxPerSpell alone
                // permitted it.
                const canAdd = Math.min(deficit, capLeft, maxPerSpell - spell.overs, fatigueSpellCap(spell.player) - spell.overs);
                if (canAdd > 0) {
                    spell.overs += canAdd;
                    cap[spell.player.id] -= canAdd;
                    deficit -= canAdd;
                }
            }

            // Strategy 2: if still deficit, add a new spell (at least minPerSpell)
            // by taking from bowlers who haven't bowled on this end yet
            if (deficit > 0) {
                const lastThisEnd = spells.length > 0 ? spells[spells.length - 1].player.id : null;
                for (const b of bowlers) {
                    if (deficit <= 0) break;
                    const capLeft = cap[b.id] || 0;
                    if (b.id === lastOtherBowler) continue;
                    if (b.id === lastThisEnd) continue;
                    // REAL BUG (found via automated verification, fixed): this
                    // used to "lift" a bowler's remaining cap up to minPerSpell
                    // whenever it was below that — cap[b.id] = minPerSpell —
                    // as a side effect of merely being scanned here, even for
                    // a bowler this loop never ends up selecting. Since a
                    // bowler who's already bowled their full match allocation
                    // legitimately has capLeft=0, this silently manufactured
                    // 2 overs of capacity back for them, corrupting the
                    // shared cap tracker for the REST of the allocation — a
                    // later Strategy 1 call (on a different end) would then
                    // read that fabricated capacity as real and extend an
                    // already-at-cap bowler past their manual-confirmed
                    // per-match over limit. Confirmed with a synthetic 11-
                    // player Youth OD lineup: a bowler ended up with 9 overs
                    // against an 8-over cap. Correct behaviour: a bowler
                    // below minPerSpell genuinely can't take a normal-length
                    // new spell here — skip them, don't fabricate room.
                    if (capLeft < minPerSpell) continue;
                    const c = Math.min(deficit, capLeft, maxPerSpell);
                    if (c >= minPerSpell) {
                        spells.push({ player: b, overs: c, phase: 'Death overs', end: endName });
                        cap[b.id] -= c;
                        deficit -= c;
                    }
                }
            }

            // Strategy 2.5: still deficit — retry EVERY bowler with cap
            // room, ignoring the end-adjacency exclusion this time. This
            // catches exactly the case Strategy 2 misses: a weaker bowler
            // who was skipped there only because they happened to be the
            // last bowler on the other end at that moment, not because
            // they were actually unavailable. Any adjacency issue this
            // introduces is caught by the "no consecutive overs" fixup
            // pass that already runs after this function.
            //
            // v8.79 — REAL BUG (found via automated verification against a
            // real match report, not inspection): this used to accept ANY
            // c > 0, explicitly allowing "a short top-up spell below the
            // normal minPerSpell" on the premise that "real matches do
            // sometimes give someone a single closing over." That premise
            // was wrong — the manual-confirmed minimum spell length (2 OD
            // / 1 T20, already enforced in Strategy 2 just above and
            // everywhere else in this file) has no exception; a 1-over
            // spell is never legal. A tight 5-real-bowler OD lineup (all 5
            // at their exact 10-over cap) reliably produced exactly this:
            // a genuine 1-over spell for one bowler. Fixed to require
            // c >= minPerSpell here too, same guard as Strategy 2. Any
            // deficit this can't clear falls through to Strategy 3, which
            // extends an EXISTING legal spell past its bowler's over cap
            // instead — an already-known, already-flagged tradeoff
            // ("squad has too few bowling options... recruit/train
            // another bowler") for genuinely under-resourced squads, and
            // a real over-cap overrun is a far smaller, more honestly-
            // surfaced problem than a silently illegal spell length.
            if (deficit > 0) {
                for (const b of bowlers) {
                    if (deficit <= 0) break;
                    const capLeft = cap[b.id] || 0;
                    if (capLeft < minPerSpell) continue;
                    const c = Math.min(deficit, capLeft, maxPerSpell);
                    if (c >= minPerSpell) {
                        spells.push({ player: b, overs: c, phase: 'Death overs', end: endName });
                        cap[b.id] -= c;
                        deficit -= c;
                    }
                }
            }

            // Strategy 3: absolute last resort — if STILL deficit (every
            // eligible bowler is genuinely capped out, e.g. a squad with
            // too few bowling options for this format), extend any spell
            // regardless of cap (exceed maxPerBowler). This should now
            // only trigger when there really is no legal allocation left.
            if (deficit > 0) {
                const before = deficit;
                for (const spell of spells) {
                    if (deficit <= 0) break;
                    const canAdd = Math.min(deficit, maxPerSpell - spell.overs);
                    if (canAdd > 0) {
                        spell.overs += canAdd;
                        deficit -= canAdd;
                    }
                }
                if (before > deficit) {
                    console.warn(`[FTP Advisor] ${endName} end: squad has too few bowling options for this format — exceeded a bowler's per-match over limit by ${before - deficit} to fill the innings. Consider recruiting/training another bowler.`);
                }
            }

            if (deficit > 0) {
                console.warn(`[FTP Advisor] Could not fully allocate ${endName} end: ${endTotal(spells)}/${target}`);
            }
        }
        fixEndTotal(gSpells, perEnd, 'Gibson');
        fixEndTotal(sSpells, perEnd, 'Southern');

        const gFinal = endTotal(gSpells);
        const sFinal = endTotal(sSpells);
        if (gFinal !== perEnd || sFinal !== perEnd) {
            console.warn(`[FTP Advisor] Bowling allocation: Gibson=${gFinal}/${perEnd}, Southern=${sFinal}/${perEnd}. Bowlers: ${nb}`);
        }

        // ---- Interleave into flat plan ----
        // Alternate Gibson/Southern, but check for adjacency (same bowler in consecutive slots)
        let plan = [];
        let gi = 0, si = 0;
        while (gi < gSpells.length || si < sSpells.length) {
            if (gi < gSpells.length) {
                plan.push(gSpells[gi]);
                gi++;
            }
            if (si < sSpells.length) {
                plan.push(sSpells[si]);
                si++;
            }
        }

        // Shared by the initial build and the drinks-break rebuild (which only
        // has to produce a valid spell LIST — numbering/adjacency stay here so
        // the rebuild can't accidentally introduce collisions or end/parity
        // mismatches).
        function fixAdjacency(list) {
            // Fix adjacency violations: no bowler may bowl consecutive overs.
            // Run multiple passes since a swap can introduce new violations.
            // Manual-confirmed per-bowler max overs (rules.htm?rulespage=
            // competitions): Senior OD 10, Senior T20 4, Youth OD 8, Youth T20
            // 4 — see MAX_OVERS_PER_BOWLER above. No consecutive overs is also
            // manual-confirmed (rulespage=matchorders).
            for (let pass = 0; pass < 3; pass++) {
                let fixed = false;
                for (let i = 1; i < list.length; i++) {
                    if (list[i].player.id === list[i - 1].player.id) {
                        let swapped = false;
                        for (let j = i + 1; j < list.length; j++) {
                            const prevId = i >= 2 ? list[i - 2].player.id : null;
                            if (list[j].player.id !== list[i - 1].player.id && list[j].player.id !== prevId) {
                                const nextId = j + 1 < list.length ? list[j + 1].player.id : null;
                                if (list[i - 1].player.id !== nextId) {
                                    [list[i], list[j]] = [list[j], list[i]];
                                    swapped = true;
                                    fixed = true;
                                    break;
                                }
                            }
                        }
                        if (!swapped) {
                            console.warn(`[FTP Advisor] Adjacency violation: ${list[i].player.name} bowls consecutive overs at slot ${i}`);
                        }
                    }
                }
                if (!fixed) break;
            }
        }

        function numberAndTactics(list, opts) {
            // Assign startOver and tactics. Gibson spells get odd over numbers,
            // Southern even ones — this end<->parity invariant is what the
            // drinks-break rebuild's re-numbering relies on. When opts.breakOver
            // is set (drinks-break rebuild), numbering is side-aware instead:
            // each spell's side ('before'/'after', set by the rebuild) picks a
            // per-end counter that only walks that side of the break, so a
            // before-spell can never land after the break and vice versa, and
            // collisions are impossible (each counter is strictly monotonic over
            // that end's own parity).
            const seamBoost = pitchEffect.seam > 1.1;
            const spinBoost = pitchEffect.spin > 1.1;
            const battingFriendly = pitchEffect.bat > 1.1;
            const captain = lineup.find(p => p.isCaptain);
            const captaincy = captain ? (captain.captaincy || 5) : 5;
            const captainCanExec = captaincy >= 8;
            const captainIsWeak = captaincy < 5;
            const breakOver = opts && opts.breakOver;

            let gibsonNext = 1;
            let southernNext = 2;
            const counters = {
                Gibson: { before: 1, after: breakOver != null ? (breakOver % 2 === 0 ? breakOver + 1 : breakOver + 2) : null },
                Southern: { before: 2, after: breakOver != null ? (breakOver % 2 === 0 ? breakOver + 2 : breakOver + 1) : null }
            };

            list.forEach((spell) => {
                const bowler = spell.player;
                const isSeamer = bowler.bowlerCategory === 'seam';
                const isSpinner = bowler.bowlerCategory === 'spin';

                let tactic = 2;
                if (spell.phase === 'New ball') {
                    tactic = 1;
                } else if (spell.phase === 'Death overs') {
                    tactic = battingFriendly ? (captainIsWeak ? 2 : 1) : 1;
                } else if (spell.phase === 'Middle overs') {
                    if (seamBoost && isSeamer && captainCanExec) tactic = 1;
                    else if (spinBoost && isSpinner && captainCanExec) tactic = 1;
                    else if (battingFriendly) tactic = captainIsWeak ? 2 : 3;
                }
                spell.tactic = tactic;

                if (breakOver != null) {
                    const side = spell.side === 'after' ? 'after' : 'before';
                    spell.startOver = counters[spell.end][side];
                    counters[spell.end][side] += spell.overs * 2;
                } else if (spell.end === 'Gibson') {
                    spell.startOver = gibsonNext;
                    gibsonNext += spell.overs * 2;
                } else {
                    spell.startOver = southernNext;
                    southernNext += spell.overs * 2;
                }
            });
        }

        fixAdjacency(plan);
        numberAndTactics(plan);

        // ---- Rest across the drinks break (all four formats) ----
        // Manual-confirmed mechanic: "Energy is partially replenished
        // during drinks breaks and during the change of innings"
        // (rulespage=matchengine) — the manual text has no format
        // qualifier, so this applies to T20/Youth T20 exactly as much as
        // OD/Youth OD. Giving a bowler some overs before the halfway break
        // and some after is a real rest window, instead of bowling their
        // whole allocation in one continuous block.
        //
        // v8.80 — previously OD/YOD-only (`!isT20` gate), on the reasoning
        // that "T20 spells are short (max 4) and the manual treats the
        // break as a minor factor there." That reasoning wasn't actually
        // manual-sourced (a judgment call, not a quote) and the user
        // pushed back on it directly. Mechanically nothing blocks it: T20's
        // own `minPerSpell` is 1 (not 2), so a 4-over T20 spell can legally
        // split into two 2-over halves around the over-10 halfway point of
        // a 20-over innings, using the exact same partition/verification
        // machinery already built for OD. Gate removed; the pass now runs
        // for every format, with `breakOver = totalOvers / 2` naturally
        // landing on over 10 for T20/YT20.
        //
        // v8.79 — a spell can only be split if BOTH resulting halves still
        // meet the manual-confirmed minimum spell length (`minPerSpell`,
        // already enforced elsewhere in this function — 2 overs for OD).
        // The original v8.32-era design let LOW-endurance bowlers split
        // from as little as 2 overs ("it's fine to bowl everyone 50/50" —
        // real user feedback at the time), but 2 overs split "50/50" is
        // 1+1, which is not a legal spell length at all — that case was
        // never actually reachable without breaking the game's own rule,
        // so the low-endurance carve-out is gone; every candidate now
        // needs >= 2*minPerSpell overs to split, endurance or not.
        //
        // v8.61: this is a REBUILD, not a patch. The pre-v8.61 approach
        // tried to insert a split spell's far-side part at a "free" over
        // number of the same end on the other side of the break. That
        // cannot work in a full innings: every odd over belongs to Gibson
        // and every even one to Southern, so on the far side of the break
        // every over number of that end's parity is already taken — the
        // search either returned a slot of the WRONG parity (silently
        // colliding with the other end's overs) or none at all (a valid
        // rest plan not applied). A real split has to RE-ALLOCATE over
        // numbers, not find a free one. So this pass partitions each end's
        // spell list into a before-break group and an after-break group
        // whose overs sums exactly match how many over-numbers of that
        // end's parity exist on each side of the break (50-over: Gibson 13
        // before + 12 after, Southern 12 before + 13 after), splits every
        // spell with overs >= 2*minPerSpell across the boundary so its
        // bowler bowls both sides (each half kept >= minPerSpell — see
        // v8.79 note above), then reuses the same adjacency/numbering
        // helpers as the main allocator — numbering side-aware so a
        // before-spell can never land after the break and vice versa. The
        // bowler's total overs never changes, so per-bowler over limits
        // hold. If the budget can't be balanced exactly, the un-split plan
        // is kept (the display's no-rest warning covers the residual).
        if (plan.length > 0) {
            const breakOver = totalOvers / 2;

            // Partition one end's spell list into before/after parts whose
            // before-side total is exactly beforeTarget overs.
            //
            // v8.81 — operates on spells MERGED per bowler, not the base
            // allocator's raw spell list. Real user report: a bowler with
            // (say) 8 total overs on one end, who the base allocator had
            // already split into two spells (6 + 2) purely because a single
            // spell can't exceed maxPerSpell, ended up with a THIRD piece
            // here — this pass didn't know about the bowler's other spell,
            // so it independently decided the 6-over piece was itself
            // "splittable" (>= 2*minPerSpell) and split IT too, producing a
            // pointless 3-piece 3+2+3 shape when the bowler's existing 6/2
            // spells (once placed on opposite sides of the break) already
            // gave a real rest window with no extra fragmentation needed.
            // Merging first means the split decision is made on the
            // bowler's TRUE total, matching how a human would actually plan
            // it: one continuous-as-possible block before the break, one
            // after, using exactly as many pieces as maxPerSpell forces —
            // never more.
            const partitionSideSpells = (endSpells, beforeTarget) => {
                const merged = new Map(); // player.id -> { sp, total }
                endSpells.forEach(sp => {
                    const m = merged.get(sp.player.id);
                    if (m) m.total += sp.overs;
                    else merged.set(sp.player.id, { sp, total: sp.overs });
                });
                // A bowler's total can only split if BOTH halves can still
                // meet minPerSpell — anything shorter has to stay one
                // continuous block (splitting a 2-over OD spell "50/50"
                // would mean two 1-over spells, which the game doesn't
                // allow at all).
                const candidate = (total) => total >= minPerSpell * 2;
                const parts = Array.from(merged.values()).map(({ sp, total }) => {
                    if (candidate(total)) {
                        // Each half must also stay within maxPerSpell — always
                        // true here since total <= maxPerBowler <= 2*maxPerSpell
                        // for every format, so no half ever needs a further
                        // 3-way split.
                        const pre = Math.max(minPerSpell, Math.floor(total / 2));
                        return { sp, before: pre, after: total - pre, candidate: true };
                    }
                    return { sp, before: total, after: 0, candidate: false };
                });

                let delta = parts.reduce((s, p) => s + p.before, 0) - beforeTarget;
                if (delta > 0) {
                    // Too much before: move overs to the after side, working
                    // from the END of the list in. Candidates can move a
                    // PARTIAL amount but must keep at least minPerSpell on
                    // the shrinking side. Non-candidates (spells excluded
                    // from splitting because they're too short) can ONLY be
                    // relocated WHOLESALE — moving them partially would
                    // silently manufacture the exact illegal sub-minPerSpell
                    // fragment they were excluded to avoid (a real bug: a
                    // realistic 8-bowler lineup's leftover 3-over spell got
                    // sliced to e.g. 2+1 here, and every permutation the
                    // search tried downstream inherited that same illegal
                    // fragment, so NOTHING ever verified clean and the split
                    // silently never happened).
                    for (let i = parts.length - 1; i >= 0 && delta > 0; i--) {
                        const p = parts[i];
                        if (p.candidate) {
                            const available = p.before - minPerSpell;
                            if (available > 0) {
                                const move = Math.min(available, delta);
                                p.before -= move;
                                p.after += move;
                                delta -= move;
                            }
                        } else if (p.before > 0 && p.before <= delta) {
                            delta -= p.before;
                            p.after += p.before;
                            p.before = 0;
                        }
                    }
                } else if (delta < 0) {
                    // Too little before: move overs from after to before —
                    // same wholesale-only rule for non-candidates.
                    for (let i = 0; i < parts.length && delta < 0; i++) {
                        const p = parts[i];
                        if (p.candidate) {
                            const available = p.after - minPerSpell;
                            if (available > 0) {
                                const move = Math.min(available, -delta);
                                p.after -= move;
                                p.before += move;
                                delta += move;
                            }
                        } else if (p.after > 0 && p.after <= -delta) {
                            delta += p.after;
                            p.before += p.after;
                            p.after = 0;
                        }
                    }
                }
                if (delta !== 0) return null;

                const out = [];
                for (const p of parts) {
                    if (p.before > 0) out.push({ ...p.sp, overs: p.before, side: 'before' });
                    if (p.after > 0) out.push({ ...p.sp, overs: p.after, side: 'after' });
                }
                return out;
            };

            const gibsonSpells = plan.filter(sp => sp.end === 'Gibson');
            const southernSpells = plan.filter(sp => sp.end !== 'Gibson');
            const beforeGibsonMax = Math.ceil(breakOver / 2);      // odd numbers <= breakOver
            const beforeSouthernMax = Math.floor(breakOver / 2);   // even numbers <= breakOver

            const gParts = partitionSideSpells(gibsonSpells, beforeGibsonMax);
            const sParts = partitionSideSpells(southernSpells, beforeSouthernMax);

            if (gParts && sParts) {
                const gBefore = gParts.filter(p => p.side === 'before');
                const sBefore = sParts.filter(p => p.side === 'before');
                const gAfterBase = gParts.filter(p => p.side === 'after');
                const sAfterBase = sParts.filter(p => p.side === 'after');

                // Before-break spells first (alternating ends, preserving per-end
                // order), then after-break spells — numbering is side-aware, so
                // list order only affects which spell gets the lower over numbers
                // on its own side, never which side.
                const buildAndVerify = (gAfter, sAfter) => {
                    const rebuilt = [];
                    for (let i = 0; i < Math.max(gBefore.length, sBefore.length); i++) {
                        if (i < gBefore.length) rebuilt.push(gBefore[i]);
                        if (i < sBefore.length) rebuilt.push(sBefore[i]);
                    }
                    for (let i = 0; i < Math.max(gAfter.length, sAfter.length); i++) {
                        if (i < gAfter.length) rebuilt.push(gAfter[i]);
                        if (i < sAfter.length) rebuilt.push(sAfter[i]);
                    }
                    const candidate = rebuilt.slice();
                    fixAdjacency(candidate);
                    numberAndTactics(candidate, { breakOver });
                    fixAdjacency(candidate);
                    numberAndTactics(candidate, { breakOver });

                    // Verify the candidate is well-formed: no collisions,
                    // nothing out of range, no bowler bowling consecutive
                    // over numbers. `fixAdjacency` alone can't guarantee this
                    // — it only reorders LIST position, but the drinks-break
                    // rebuild numbers Gibson/Southern's after-side
                    // independently via their own monotonic counters, so two
                    // entries that are far apart in list order can still end
                    // up on numerically adjacent real overs (e.g. Southern's
                    // over 42 and Gibson's over 43 both landing on the same
                    // bowler even though neither end alone has a problem —
                    // a real case found via harness, not hypothetical).
                    const overMap = new Map();
                    let collides = false;
                    for (const sp of candidate) {
                        for (let o = sp.startOver; o <= sp.startOver + (sp.overs - 1) * 2; o += 2) {
                            if (overMap.has(o)) collides = true;
                            overMap.set(o, sp.player.id);
                        }
                    }
                    const outOfRange = candidate.some(sp => sp.startOver < 1 || sp.startOver + (sp.overs - 1) * 2 > totalOvers);
                    let adjacent = false;
                    for (let o = 1; o < totalOvers; o++) {
                        if (overMap.get(o) && overMap.get(o) === overMap.get(o + 1)) adjacent = true;
                    }
                    // v8.79: partitionSideSpells is built to never produce a
                    // spell shorter than minPerSpell, but this is cheap to
                    // double-check here too — a silent minPerSpell violation
                    // (e.g. a future edit to the partition math) would be a
                    // real rules violation, not just a cosmetic issue, and
                    // wouldn't be caught by collides/outOfRange/adjacent.
                    const tooShort = candidate.some(sp => sp.overs < minPerSpell);
                    return { ok: !collides && !outOfRange && !adjacent && !tooShort, candidate };
                };

                // Reordering entries WITHIN one end's after-list only changes
                // WHICH of that end's own sequential over-slots a bowler
                // gets — never their total overs — so trying other orderings
                // can't violate a per-bowler cap. Small lists (splittable
                // spells per end are rare — 2-5 is typical), so a bounded,
                // fully DETERMINISTIC permutation search (same input always
                // produces the same output — no Math.random anywhere in
                // this file, and that's deliberate, see the training-sim
                // determinism note elsewhere) is cheap and far more likely
                // to find a valid split than the single fixed interleave.
                const permutations = (arr) => {
                    if (arr.length <= 1) return [arr];
                    const out = [];
                    for (let i = 0; i < arr.length; i++) {
                        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
                        for (const p of permutations(rest)) out.push([arr[i], ...p]);
                    }
                    return out;
                };
                const gPerms = gAfterBase.length <= 5 ? permutations(gAfterBase) : [gAfterBase];
                const sPerms = sAfterBase.length <= 5 ? permutations(sAfterBase) : [sAfterBase];

                let found = null;
                outer:
                for (const gp of gPerms) {
                    for (const sp of sPerms) {
                        const res = buildAndVerify(gp, sp);
                        if (res.ok) { found = res.candidate; break outer; }
                    }
                }

                if (found) {
                    plan = found;
                } else {
                    console.warn('[FTP Advisor] Drinks-break rebuild could not find a valid split after searching all end orderings — keeping the un-split allocation.');
                }
            } else {
                console.warn('[FTP Advisor] Drinks-break rest plan could not be balanced — keeping the un-split allocation.');
            }
        }

        return plan;
    }

    // ============================================================
    // ORDERS PAGE SCRAPER + UI
    // ============================================================
    function scrapeAvailablePlayers() {
        const players = [];
        const seen = new Set();
        const selects = document.querySelectorAll('select.batsmen, select.bowler');
        selects.forEach(select => {
            if (select.id === 'captain' || select.id === 'keeper' || select.id === 'gameTeam.tossCallHeads' || select.id === 'gameTeam.tossBatFirst') return;
            Array.from(select.options).forEach(opt => {
                if (opt.value && !seen.has(opt.value)) {
                    seen.add(opt.value);
                    players.push({ id: opt.value, name: escapeHtml(opt.textContent.trim()) });
                }
            });
        });
        return players;
    }

    // ============================================================
    // UI
    // ============================================================
    function createOrdersUI() {
        createPanel({
            title: 'Tactical Advisor', icon: '\u{1F3CF}',
            buttons: [
                { id: 'ftp-refresh', label: '\u21BB', title: 'Refresh analysis' }
            ],
            sections: [
                { id: 'ftp-context', label: 'Match Context', icon: '\u{1F4CA}', iconColor: 'blue' },
                { id: 'ftp-data-status', label: 'Data Status', icon: '\u{1F4BE}', iconColor: 'teal' },
                { id: 'ftp-toss', label: 'Toss Decision', icon: '\u{1FA99}', iconColor: 'amber' },
                { id: 'ftp-batting', label: 'Batting Order', icon: '\u{1F3CF}', iconColor: 'green' },
                { id: 'ftp-bowling', label: 'Bowling Spells', icon: '\u{1F3C3}', iconColor: 'blue' },
                { id: 'ftp-load-opponent-section', label: 'Opponent', icon: '\u{1F50D}', iconColor: 'purple',
                  content: '<button id="ftp-load-opponent" class="ftp-button ftp-button-primary" style="width:100%;">Load Opponent Squad</button>' }
            ],
            footer: 'FTP Advisor v7.0 \u00B7 Drag to move'
        });
    }

    function updateOrdersAdvisor() {
        try {
        const availablePlayers = scrapeAvailablePlayers();
        if (availablePlayers.length === 0) {
            document.getElementById('ftp-context').innerHTML = '<div class="ftp-alert info">No order-selection form found on this page \u2014 this match\'s tactics are likely already locked in, in progress, or complete.</div>';
            return;
        }

        const context = scrapeMatchContext();
        const pitchEffect = PITCH_EFFECTS[context.pitch] || PITCH_EFFECTS.Sporting;
        const weatherEffect = WEATHER_EFFECTS[context.weather] || WEATHER_EFFECTS.Sunny;

        // Context display
        document.getElementById('ftp-context').innerHTML = `
            <div class="vj-flex vj-gap-6 vj-mb-4" style="flex-wrap:wrap;">
                <span class="ftp-stat-badge blue">${context.matchType}${context.matchTypeKnown ? '' : ' (fallback)'} \u00B7 ${context.overs}ov</span>
                <span class="ftp-stat-badge neutral">${context.pitch}</span>
                <span class="ftp-stat-badge neutral">${context.weather}</span>
            </div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Venue</span><span class="ftp-stat-value">${context.venue}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Pitch favours</span><span class="ftp-stat-value">${pitchEffect.favor}</span></div>
            <div class="vj-text-xs vj-text-muted vj-mt-4">${weatherEffect.desc || ''}</div>
        `;

        // Data status
        document.getElementById('ftp-data-status').innerHTML = buildDataStatusHTML();

        // Cache check
        const cache = loadPlayerCache();
        let cacheHtml = '';
        if (!cache) {
            cacheHtml = '<div class="ftp-alert danger" style="margin:0;">No cached player data. Visit squad page first.</div>';
        } else {
            cacheHtml = `<div class="ftp-stat-row"><span class="ftp-stat-label">Your squad</span><span class="ftp-stat-badge green">${getCacheAgeText(cache.ageDays)}</span></div>`;
        }

        // Opponent cache check
        const opponentTeamId = getOpponentTeamId();
        const opponentCache = opponentTeamId ? loadOpponentCache(opponentTeamId) : null;
        if (!opponentTeamId) {
            cacheHtml += '<div class="ftp-stat-row"><span class="ftp-stat-label">Opponent</span><span class="vj-text-xs vj-text-muted">No opponent detected</span></div>';
        } else if (!opponentCache) {
            cacheHtml += '<div class="ftp-stat-row"><span class="ftp-stat-label">Opponent</span><span class="ftp-stat-badge red">Not loaded</span></div>';
        } else if (opponentCache.players.length === 0) {
            cacheHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Opponent</span><span class="ftp-stat-badge red">0 players \u2014 squad page returned no rows</span></div>`;
        } else {
            const fullSkillCount = opponentCache.players.filter(p => p.hasFullSkills).length;
            const skillsNote = fullSkillCount === 0 ? ' \u00B7 skills hidden (opponent view)' : fullSkillCount < opponentCache.players.length ? ` \u00B7 ${fullSkillCount}/${opponentCache.players.length} with skills` : '';
            cacheHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Opponent</span><span class="ftp-stat-badge green">${getCacheAgeText(opponentCache.ageDays)} \u00B7 ${opponentCache.players.length} players${skillsNote}</span></div>`;
        }

        document.getElementById('ftp-data-status').innerHTML += cacheHtml;

        // Confidence badge shown in the context header — computed here
        // (after cache/opponentCache are declared) and injected into the
        // already-rendered context container.
        try {
            const tacticsConf = computeConfidence({
                cacheAgeHours: cache ? cache.ageHours : null,
                playersWithSkills: cache ? cache.players.filter(p => (p.batting || 0) > 0).length : 0,
                totalPlayers: availablePlayers.length,
                hasAcademyInfo: false,
                hasFinanceInfo: false,
                hasOpponentData: !!opponentCache && opponentCache.players.length > 0,
                matchTypeKnown: context.matchTypeKnown === true,
            });
            const ctxEl = document.getElementById('ftp-context');
            if (ctxEl) {
                ctxEl.insertAdjacentHTML('afterbegin', `<div class="vj-flex vj-gap-6 vj-mb-4" style="flex-wrap:wrap;">${renderConfidenceBadge(tacticsConf)}</div>`);
            }
        } catch (e) {
            console.warn('[FTP Advisor] Could not render confidence badge:', e);
        }

        // Enrich players with cached data
        let enrichedPlayers = availablePlayers.map(p => {
            const cached = cache ? cache.players.find(cp => cp.id === p.id) : null;
            return cached || {
                id: p.id, name: p.name,
                batting: 4, bowling: 4, technique: 4, power: 4, keeping: 3,
                fielding: 4, endurance: 5, experience: 4, captaincy: 3,
                fatigue: 8, form: 5,
                bowlerType: '', bowlerCategory: 'none', bowlerPace: 0,
                isLeftHanded: false, age: 25, isSenior: true, isYouth: false
            };
        });

        // Age filtering for youth matches.
        // Official manual: "Only players aged 20 and under are eligible to
        // play in these matches" (rulespage=competitions) and "At the end
        // of each week, all players turning 21 are moved from your youth
        // squad and are promoted to your senior squad" (rulespage=
        // youthacademy). The second rule is the important one here: a
        // player still sitting in the youth squad has by definition NOT
        // turned 21, so the game's own squad classification is proof of
        // eligibility — and it's more trustworthy than our derived
        // decimal age at the exact year boundary. (Originally a player
        // displayed as "20.14" parsed to 20 + 14/14 = exactly 21.0, so
        // the old `age < maxAge + 1` test dropped them as 21 even though
        // the game still listed them as a 20-year-old youth player.
        // Since v8.64 the parser is 1-based — 20.14 reads 20.93, so the
        // pure age test agrees with the game and this flag is now a
        // belt-and-suspenders guard rather than the only correct path.)
        // Squad membership is only used to INCLUDE, never to exclude:
        // a 20yo already promoted/held in the senior squad is still
        // eligible on age, so those fall through to the age test.
        // (Safe against a stale flag: the orders page force-refreshes
        // squad data on every visit — see forceRefresh in init().)
        let ageWarning = '';
        if (context.isYouthOnly) {
            const beforeCount = enrichedPlayers.length;
            enrichedPlayers = enrichedPlayers.filter(p => {
                if (p.isYouth === true) return true;
                if (p.age !== undefined && p.age !== null) return Math.floor(p.age) <= context.maxAge;
                return !p.isSenior;
            });
            if (enrichedPlayers.length < 11) {
                ageWarning = `<div class="ftp-alert danger" style="margin:4px 0 0 0;">Only ${enrichedPlayers.length} eligible youth players (U${context.maxAge}). ${11 - enrichedPlayers.length} short of full squad — fill with youth recruits.</div>`;
                // Keep only eligible youth — do NOT fall back to seniors
            } else if (enrichedPlayers.length < beforeCount) {
                ageWarning = `<div class="ftp-alert warning" style="margin:4px 0 0 0;">Youth match: ${enrichedPlayers.length} eligible players (max age ${context.maxAge})</div>`;
            }
        }

        // Opponent analysis
        const opponentAnalysis = opponentCache ? analyzeOpposition(opponentCache.players, enrichedPlayers) : null;

        // Generate recommendations
        const tossRec = recommendTossDecision(context, opponentAnalysis);
        const lineup = recommendLineup(enrichedPlayers, context, opponentAnalysis);
        const battingOrder = recommendBattingOrder(lineup, context, opponentAnalysis);
        const bowling = allocateBowlingSpells(lineup, context, opponentAnalysis);

        // Display toss
        const tossIcon = tossRec.decision === 'bat' ? '\u{1F3CF}' : '\u{1F3C3}';
        let dangerHtml = '';
        if (opponentAnalysis && opponentAnalysis.dangerousBowlerCount > 0) {
            const names = opponentAnalysis.dangerousBowlerNames.join(', ');
            const isLimitedOversT20 = context && (context.matchType === 'T20' || context.matchType === 'YT20');
            const dangerAdvice = isLimitedOversT20
                ? `These have triggered delivery talents (Yorker/Bouncer/Swing/etc). Keep the tail aggressive in ${context.matchType} for scoring rate, but avoid exposing weak batters earlier than necessary.`
                : `These have triggered delivery talents (Yorker/Bouncer/Swing/etc). The recommended ${context.matchType} tactics set positions 8–11 defensively to preserve wickets through the threat.`;
            dangerHtml = `<div class="ftp-alert danger" style="margin:6px 0 0 0;"><span>\ud83d\udea8</span><div><strong>Opponent has ${opponentAnalysis.dangerousBowlerCount} dangerous bowler${opponentAnalysis.dangerousBowlerCount > 1 ? 's' : ''}:</strong> ${names} — ${dangerAdvice}</div></div>`;
        }
        if (opponentAnalysis && opponentAnalysis.inForm) {
            dangerHtml += `<div class="ftp-alert warning" style="margin:4px 0 0 0;"><span>\u26A0</span><div>Opponent is in strong form (avg form ${(opponentAnalysis.avgForm || 0).toFixed(1)}/10). Expect aggressive play.</div></div>`;
        }
        // Real-match evidence from the pasted Match Review history \u2014 cross
        // references the opponent's actual squad names first (most precise),
        // falls back to a team-name-level aggregate. Silently renders nothing
        // when no pasted matches touch this opponent yet.
        dangerHtml += buildPastedScoutingHtml(opponentCache ? opponentCache.players : null, getOpponentTeamName());

        document.getElementById('ftp-toss').innerHTML = `
            <div class="ftp-info-box success" style="text-align:center;">
                <div style="font-size:22px;margin-bottom:4px;">${tossIcon}</div>
                <div style="font-weight:700;font-size:16px;color:var(--vj-text);">${tossRec.decision === 'bat' ? 'Bat First' : 'Bowl First'}</div>
                <div class="vj-text-xs vj-text-secondary vj-mt-4">${tossRec.reason}</div>
            </div>
            ${dangerHtml}
            ${ageWarning}
        `;

        // Display batting order
        displayBattingOrder(battingOrder, opponentAnalysis, context);

        // Display bowling
        displayBowling(bowling, opponentAnalysis, context.overs, context.matchType);
        } catch (err) {
            console.error('[FTP Advisor] Error in updateOrdersAdvisor:', err);
            const ctx = document.getElementById('ftp-context');
            if (ctx) ctx.innerHTML = `<div class="ftp-alert danger">Error: ${err.message}<div class="vj-text-xs vj-mt-4">Check console (F12) for details.</div></div>`;
        }
    }

    function displayBattingOrder(battingOrder, opponentAnalysis, context) {
        const isT20 = context && (context.matchType === 'T20' || context.matchType === 'YT20');

        // Opponent bowling composition — what our batters are facing
        let oppBowlingHtml = '';
        if (opponentAnalysis) {
            const parts = [];
            parts.push(`<strong>${opponentAnalysis.seamerCount} seam</strong>, <strong>${opponentAnalysis.spinnerCount} spin</strong>`);
            if (opponentAnalysis.dangerousBowlerCount > 0) {
                parts.push(`${opponentAnalysis.dangerousBowlerCount} dangerous (${opponentAnalysis.dangerousBowlerNames.join(', ')})`);
            }
            if (opponentAnalysis.keyBowler) {
                parts.push(`Key: ${opponentAnalysis.keyBowler.name} (exp ${opponentAnalysis.keyBowler.experience})`);
            }
            const tacticTip = opponentAnalysis.seamerCount > opponentAnalysis.spinnerCount
                ? 'More seam attack — LH batters get variety advantage; Seam Specialist talent triggers more.'
                : opponentAnalysis.spinnerCount > opponentAnalysis.seamerCount
                ? 'More spin attack — RH batters get variety advantage; Spin Specialist talent triggers more.'
                : 'Balanced attack — no specific matchup edge.';
            oppBowlingHtml = `<div class="ftp-alert info" style="margin-bottom:6px;"><span>\u{1F3CF}</span><div><strong>Opponent bowling:</strong> ${parts.join(' \u00B7 ')}<div class="vj-text-xs vj-mt-4">${tacticTip}</div></div></div>`;
        }

        let html = oppBowlingHtml;
        html += '<table class="ftp-table"><thead><tr><th>#</th><th>Player</th><th>Bat</th><th>Form</th><th>L/R</th><th>Tac</th></tr></thead><tbody>';
        battingOrder.forEach(p => {
            const captainMark = p.isCaptain ? ' <span class="ftp-stat-badge amber" style="font-size:9px;padding:1px 5px;">C</span>' : '';
            const keeperMark = p.role === 'WK' ? ' <span class="ftp-stat-badge orange" style="font-size:9px;padding:1px 5px;background:var(--vj-orange-bg);color:var(--vj-orange);">WK</span>' : '';
            const tacticLabel = p.battingTactic === 5 ? 'A' : p.battingTactic === 4 ? 'D' : 'N';
            const tacticClass = 'ftp-tactic-' + tacticLabel;
            const handedness = p.isLeftHanded ? 'L' : 'R';
            html += `<tr>
                <td style="font-weight:700;">${p.position}</td>
                <td style="font-weight:600;">${p.name}${captainMark}${keeperMark}</td>
                <td>${skillLabel(p.batting).slice(0,3)}</td>
                <td>${skillLabel(p.form).slice(0,3)}</td>
                <td><span class="vj-text-xs">${handedness}</span></td>
                <td><span class="${tacticClass}">${tacticLabel}</span></td>
            </tr>`;
        });
        html += '</tbody></table>';
        const pitchSlow = context && ['Sticky', 'Crumbling', 'Slow'].includes(context.pitch);
        let tacticNote = isT20
            ? `N=Normal D=Defensive A=Aggressive · ${context.matchType}: aggressive middle/death to maximise scoring rate`
            : `C = Captain · WK = Wicketkeeper · N=Normal D=Defensive A=Aggressive · ${context.matchType}: anchor at #3, threat-aware tail`;
        // Experienced-player guidance: Normal aggression is perfectly fine —
        // aim for ~60%+ of the overs on Normal (e.g. 30 of 50) rather than
        // over-aggressing; the top order already does exactly that here.
        tacticNote += ' \u00B7 Guidance: keep ~60%+ of overs on Normal (30 of 50) — over-aggression rarely pays';
        if (opponentAnalysis && opponentAnalysis.dangerousBowlerCount > 0 && !isT20) {
            tacticNote += ' \u00B7 Dangerous-bowler adjustment: ' + context.matchType + ' positions 8–11 set Defensive';
        }
        html += `<div class="vj-text-xs vj-text-muted vj-mt-4" style="text-align:center;">${tacticNote}</div>`;

        // Slow pitches generate more dot balls, and Accumulator / Boundary
        // Hitter trigger on what would otherwise be dot balls (experienced-
        // player feedback) — so those players are worth more here and are
        // best used on Defensive as the innings anchor.
        if (pitchSlow) {
            html += `<div class="ftp-alert info" style="margin:6px 0 0 0;"><span>\u{1F3AF}</span><div>${context.pitch} pitch → more dot balls. Accumulator / Boundary Hitter players trigger on dot balls — best used on <strong>Defensive</strong> as the #3 innings anchor.</div></div>`;
        }

        // Batting-strength by phase — mirrors the game's own Match Ratings
        // split (Top Order 1-4 / Middle 5-8 / Tail 9-11) so you can see at a
        // glance whether the recommended XI has a top-heavy or balanced
        // batting profile, and whether a phase looks thin.
        const battingRaw = battingOrder.map(p => ({ pos: p.position, v: p.batting || 0, n: p.name }));
        if (battingRaw.length >= 11) {
            const sections = [
                { label: 'Top 1-4', rows: battingRaw.filter(r => r.pos <= 4) },
                { label: 'Middle 5-8', rows: battingRaw.filter(r => r.pos >= 5 && r.pos <= 8) },
                { label: 'Tail 9-11', rows: battingRaw.filter(r => r.pos >= 9) }
            ];
            const avg = rows => rows.length ? rows.reduce((s, r) => s + r.v, 0) / rows.length : 0;
            const badges = sections.map(s => {
                const a = avg(s.rows);
                const color = a >= 7 ? 'green' : a >= 5 ? 'amber' : 'red';
                return `<span class="ftp-stat-badge ${color}" title="${s.rows.map(r => `${r.n} (${skillLabel(r.v)})`).join(', ')}" style="font-size:9px;cursor:help;">${s.label}: ${a.toFixed(1)}</span>`;
            }).join(' ');
            html += `<div class="vj-text-xs vj-text-muted vj-mt-4" style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;">${badges}</div>`;
        }

        document.getElementById('ftp-batting').innerHTML = html;
    }

    function displayBowling(bowlingSpells, opponentAnalysis, totalOvers, matchType) {
        let html = '';
        const isT20 = matchType === 'T20' || matchType === 'YT20';
        const minPerSpell = isT20 ? 1 : 2;

        // Rest-across-the-break check. Real user feedback, and manual-
        // confirmed mechanic: "Energy is partially replenished during
        // drinks breaks and during the change of innings" (rulespage=
        // matchengine) — the manual text has no format qualifier. Splitting
        // a bowler's overs into a spell before the halfway-point break and
        // another after gives them an actual rest window, instead of one
        // continuous block. The allocator ITSELF does this split for every
        // format since v8.80 (see allocateBowlingSpells()'s "Rest across
        // the drinks break" pass), so this warning only fires when the
        // split genuinely couldn't help — a bowler whose spell was too
        // short to split at all, or one who couldn't be split without
        // breaking the over limits.
        if (totalOvers) {
            const breakOver = totalOvers / 2;
            const perBowler = {};
            bowlingSpells.forEach(s => {
                if (!s || !s.player) return;
                if (!perBowler[s.player.id]) perBowler[s.player.id] = { name: s.player.name, before: 0, after: 0, total: 0, endurance: s.player.endurance || 0, isYouth: s.player.isYouth === true || (s.player.age || 0) < 21 };
                const b = perBowler[s.player.id];
                const spellEndOver = s.startOver + (s.overs - 1) * 2;
                if (spellEndOver <= breakOver) {
                    b.before += s.overs;                    // entirely before
                } else if (s.startOver > breakOver) {
                    b.after += s.overs;                     // entirely after
                } else {
                    // STRADDLES the break: this spell already bowls some
                    // overs before AND some after the break, so this bowler
                    // genuinely gets a rest window mid-innings (the delivery
                    // over numbers on an end step by 2, so the spell lands
                    // on both sides of the halfway point). Split its overs
                    // across before/after so it's NOT mislabeled "all
                    // before, no rest" by the check below.
                    const perOverStep = 2;
                    const oversBefore = Math.ceil((breakOver - s.startOver + 1) / perOverStep);
                    const oversAfter = s.overs - oversBefore;
                    b.before += oversBefore;
                    b.after += oversAfter;
                }
                b.total += s.overs;
            });
            // v8.79/v8.80: the allocator's own split candidacy threshold is
            // simply overs >= 2*minPerSpell (2 OD / 2 T20 — same number,
            // different reason: minPerSpell is 1 for T20 so 2 overs is the
            // floor either way) — there's no separate low-endurance
            // carve-out any more (removed in v8.79; a 2-over spell split
            // "50/50" for a low-endurance bowler used to mean two illegal
            // 1-over spells). So a bowler still flagged here genuinely
            // couldn't be split without violating minPerSpell or another
            // hard constraint — a real, unavoidable edge case, not a gap in
            // the allocator. "all AFTER" bowlers are NOT worth flagging —
            // they're fresh death-overs bowlers who rested before bowling,
            // which is the whole point. Only warn when a bowler's block is
            // entirely BEFORE the break with no break-window recovery
            // afterwards.
            const noRest = Object.values(perBowler).filter(b => {
                return b.total >= 2 * minPerSpell && b.before > 0 && b.after === 0 && b.before === b.total;
            });
            if (noRest.length > 0) {
                html += `<div class="ftp-alert warning" style="margin-bottom:6px;"><span>⚠</span><div><strong>No rest across the drinks break:</strong> ${noRest.map(b => `${b.name} (${b.total} overs, all ${b.before === 0 ? 'after' : 'before'})`).join(', ')} — these couldn't be split without breaking the over limits; if a break happens, they'll still get whatever recovery the game grants between their spells in other overs.</div></div>`;
            }
            // v8.80 explainer — every format now gets the same treatment
            // (T20/YT20 included since this version), shown as a one-line
            // note so the resulting plan reads as intended rather than
            // looking like arbitrary spell placement.
            html += `<div class="vj-text-xs vj-text-muted vj-mb-4" style="text-align:center;">\u{1F6C0} Rest across the drinks break: bowlers with a long enough spell (${2 * minPerSpell}+ overs) get it split before/after the halfway point for a real recovery window — applies to every format.</div>`;
        }

        // Endurance/freshness for the death overs (v8.41) — see
        // rankForDeathOvers() in allocateBowlingSpells(): the plan above
        // already leans toward a fresher, higher-endurance bowler for the
        // closing spells where possible, since a bowler still firing at
        // full effort late in the innings troubles the tail more than one
        // who's been ground down by an earlier long spell. Shown here as
        // a one-line explainer, not a separate recommendation, since it's
        // baked into the allocation itself rather than a manual choice.
        html += `<div class="vj-text-xs vj-text-muted vj-mb-4" style="text-align:center;">\u{1F4A8} Death-overs bowler selection favors freshness/endurance among close options — a sharp bowler against the tail beats a tired one with marginally better figures.</div>`;

        // Spell variety summary
        const seamerSpells = bowlingSpells.filter(s => s && s.player && s.player.bowlerCategory === 'seam');
        const spinnerSpells = bowlingSpells.filter(s => s && s.player && s.player.bowlerCategory === 'spin');
        const varietyParts = [];
        if (seamerSpells.length > 0) varietyParts.push(`${seamerSpells.length} seam spells`);
        if (spinnerSpells.length > 0) varietyParts.push(`${spinnerSpells.length} spin spells`);
        if (varietyParts.length > 0) {
            html += `<div class="vj-text-xs vj-text-muted vj-mb-4" style="text-align:center;">Bowling variety: ${varietyParts.join(' + ')}</div>`;
        }

        html += '<table class="ftp-table"><thead><tr><th>#</th><th>End</th><th>Over</th><th>Bowler</th><th>Bowl</th><th>Ovs</th><th>Tac</th><th>Phase</th></tr></thead><tbody>';
        bowlingSpells.forEach((spell, index) => {
            if (!spell || !spell.player) return;
            const end = spell.end || (index % 2 === 0 ? 'Gibson' : 'Southern');
            const tacLabel = spell.tactic === 1 ? 'A' : spell.tactic === 3 ? 'D' : 'N';
            const tacClass = 'ftp-tactic-' + tacLabel;
            const bowlLabel = skillLabel(spell.player.bowling).slice(0,3);
            const phaseIcon = spell.phase === 'New ball' ? '\u{1F535}' : spell.phase === 'Death overs' ? '\u{1F534}' : '\u26AA';
            html += `<tr>
                <td style="font-weight:700;">${index + 1}</td>
                <td><span class="vj-text-xs" style="font-weight:600;">${end === 'Gibson' ? '\u25B6' : '\u25C0'} ${end}</span></td>
                <td>${spell.startOver}</td>
                <td style="font-weight:600;">${spell.player.name}</td>
                <td>${bowlLabel}</td>
                <td style="font-weight:700;">${spell.overs}</td>
                <td><span class="${tacClass}">${tacLabel}</span></td>
                <td><span class="vj-text-xs">${phaseIcon} ${spell.phase}</span></td>
            </tr>`;
        });
        html += '</tbody></table>';
        document.getElementById('ftp-bowling').innerHTML = html;
    }

    // ============================================================
    // DRAGGABLE PANEL
    // ============================================================
    function makeDraggable(panel, handle) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        if (!handle || !panel) {
            console.warn('[FTP Advisor] makeDraggable: missing handle or panel');
            return;
        }

        handle.style.cursor = 'move';
        handle.style.userSelect = 'none';
        handle.setAttribute('data-drag-handle', 'true');

        // Restore position from storage
        try {
            const savedPos = GM_getValue('ftp_panel_position', null);
            if (savedPos) {
                const pos = JSON.parse(savedPos);
                if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
                    panel.style.left = pos.left + 'px';
                    panel.style.top = pos.top + 'px';
                    panel.style.right = 'auto';
                }
            }
        } catch (e) { /* ignore */ }

        handle.addEventListener('mousedown', (e) => {
            // Don't drag if clicking buttons or inputs
            const tag = e.target.tagName;
            if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' || tag === 'SELECT') return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            panel.style.opacity = '0.85';
            e.preventDefault();
        });

        // Clean up old listeners if panel was recreated
        if (panel._ftpMouseMove) document.removeEventListener('mousemove', panel._ftpMouseMove);
        if (panel._ftpMouseUp) document.removeEventListener('mouseup', panel._ftpMouseUp);

        const mouseMoveHandler = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newLeft = Math.max(0, Math.min(window.innerWidth - 100, startLeft + dx));
            const newTop = Math.max(0, Math.min(window.innerHeight - 50, startTop + dy));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
        };

        const mouseUpHandler = () => {
            if (isDragging) {
                isDragging = false;
                panel.style.opacity = '1';
                const rect = panel.getBoundingClientRect();
                try {
                    GM_setValue('ftp_panel_position', JSON.stringify({ left: rect.left, top: rect.top }));
                } catch (e) { /* ignore */ }
            }
        };

        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
        panel._ftpMouseMove = mouseMoveHandler;
        panel._ftpMouseUp = mouseUpHandler;
    }

    // ============================================================
    // GROUND PAGE UI - Pitch Recommendations
    // ============================================================
    function createGroundUI() {
        createPanel({
            title: 'Pitch Advisor', icon: '\u26F3',
            buttons: [
                { id: 'ftp-refresh-squad', label: '\u21BB All Data', title: 'Fetch fresh data' },
                { id: 'ftp-refresh', label: '\u21BB', title: 'Recalculate' }
            ],
            sections: [
                { id: 'ftp-cache-status', label: 'Data Status', icon: '\u{1F4BE}', iconColor: 'teal' },
                { id: 'ftp-squad-strengths', label: 'Squad Strengths', icon: '\u{1F4AA}', iconColor: 'green' },
                { id: 'ftp-pitch-recs', label: 'Recommended Pitches', icon: '\u2B50', iconColor: 'amber' },
                { id: 'ftp-current-pitches', label: 'Current vs Recommended', icon: '\u{1F4CD}', iconColor: 'red' },
                { id: 'ftp-capacity-recs', label: 'Ground Capacity', icon: '\u{1F3E0}', iconColor: 'teal' }
            ]
        });

        setTimeout(() => {
            document.getElementById('ftp-refresh-squad').addEventListener('click', async () => {
                const btn = document.getElementById('ftp-refresh-squad');
                btn.disabled = true; btn.textContent = 'Loading...';
                try {
                    await fetchAllData({ force: true, onProgress: (msg) => { btn.textContent = msg; } });
                    updateGroundAdvisor();
                } catch (err) { alert('Failed to refresh: ' + err.message); }
                finally { btn.disabled = false; btn.textContent = '\u21BB All Data'; }
            });
            document.getElementById('ftp-refresh').addEventListener('click', async () => {
                await fetchAllData({ force: true }); updateGroundAdvisor();
            });
        }, 100);
    }

    function updateGroundAdvisor() {
        const cache = loadPlayerCache();
        const cacheStatusEl = document.getElementById('ftp-cache-status');
        if (!cache) {
            cacheStatusEl.innerHTML = '<div class="ftp-alert danger">No cached squad data! Visit the Senior Squad page first to load skill data.</div>';
            ['ftp-squad-strengths','ftp-pitch-recs','ftp-current-pitches'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
            return;
        }

        const isStaleCache = cache.ageDays >= 7;
        cacheStatusEl.innerHTML = `<div class="ftp-stat-row"><span class="ftp-stat-label">Squad data</span><span class="vj-flex vj-gap-6"><span class="ftp-stat-badge ${isStaleCache ? 'red' : 'green'}">${isStaleCache ? 'Stale' : 'Fresh'}</span><span class="vj-text-xs vj-text-muted">${getCacheAgeText(cache.ageDays)} \u00B7 ${cache.players.length} players</span></span></div>`;

        const players = cache.players;
        const seniors = players.filter(p => p.isSenior);
        const youth = players.filter(p => p.isYouth);

        const seniorSeamers = seniors.filter(p => p.bowlerCategory === 'seam');
        const seniorSpinners = seniors.filter(p => p.bowlerCategory === 'spin');
        const youthSeamers = youth.filter(p => p.bowlerCategory === 'seam');
        const youthSpinners = youth.filter(p => p.bowlerCategory === 'spin');

        const avg = (arr, key) => arr.length > 0 ? arr.reduce((s, p) => s + p[key], 0) / arr.length : 0;
        const seniorSeamRating = avg(seniorSeamers, 'bowling');
        const seniorSpinRating = avg(seniorSpinners, 'bowling');
        const seniorBatRating = avg(seniors, 'batting');
        const seniorPowerRating = avg(seniors, 'power');
        const youthSeamRating = avg(youthSeamers, 'bowling');
        const youthSpinRating = avg(youthSpinners, 'bowling');
        const youthBatRating = avg(youth, 'batting');
        const youthPowerRating = avg(youth, 'power');

        let strengthsHtml = `
            <div class="ftp-info-box">
                <div class="vj-flex vj-gap-8 vj-mb-4" style="flex-wrap:wrap;">
                    <span class="ftp-stat-badge green">Seniors: ${seniors.length}</span>
                    <span class="ftp-stat-badge blue">Seam: ${seniorSeamers.length}</span>
                    <span class="ftp-stat-badge purple">Spin: ${seniorSpinners.length}</span>
                </div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Senior ratings</span><span class="vj-text-xs">Bat ${seniorBatRating.toFixed(1)} \u00B7 Seam ${seniorSeamRating.toFixed(1)} \u00B7 Spin ${seniorSpinRating.toFixed(1)} \u00B7 Pwr ${seniorPowerRating.toFixed(1)}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Youth ratings</span><span class="vj-text-xs">Bat ${youthBatRating.toFixed(1)} \u00B7 Seam ${youthSeamRating.toFixed(1)} \u00B7 Spin ${youthSpinRating.toFixed(1)} \u00B7 Pwr ${youthPowerRating.toFixed(1)}</span></div>
            </div>`;
        document.getElementById('ftp-squad-strengths').innerHTML = strengthsHtml;

        const seniorT20BatRating = seniorBatRating * 0.7 + seniorPowerRating * 0.3;
        const youthT20BatRating = youthBatRating * 0.7 + youthPowerRating * 0.3;

        // Official manual (rules.htm?rulespage=ground): "Your groundspeople
        // have five pitches available, one for each league competition
        // your club competes in and one specially set aside for Matt Krevs
        // Memorial Cup matches" — and changing one takes real time ("flat
        // to slow might take about 2 days, flat to green about 4 days").
        // This is NOT a per-match lever: each competition's pitch should
        // be set to match whichever squad (senior/youth) and format
        // actually plays there most, then left alone. Below, recommendations
        // are computed per REAL competition class scraped from the page
        // (not invented categories) so they line up 1:1 with the pitches
        // you can actually set.
        let recHtml = `<div class="ftp-alert info" style="margin-bottom:6px;"><span>⏳</span><div><strong>Pitch changes take real time</strong> — official manual: changing pitch condition takes roughly 2 days for a small shift (e.g. Flat→Slow) up to 4+ days for a bigger one (e.g. Flat→Green). This isn't something to flip before each match — set each competition's pitch to fit your squad's actual strength (batting/seam/spin) and leave it, planning changes days ahead of a big fixture if you do need one.</div></div>`;

        const currentPitches = document.querySelectorAll('table.data tbody tr');
        let currentHtml = '<table class="ftp-table"><thead><tr><th>Class</th><th>Current</th><th>Recommended</th></tr></thead><tbody>';
        let matchedAnyClass = false;
        currentPitches.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
                const className = escapeHtml(cells[0]?.textContent.trim() || '');
                const pitchSpan = cells[1]?.querySelector('.popuphelp');
                const currentPitch = escapeHtml(pitchSpan ? pitchSpan.textContent.trim() : cells[1]?.textContent.trim() || '');

                // Best-effort match of this real competition class to a
                // squad/format so the recommendation uses the right player
                // pool — falls back to senior OD if nothing matches, since
                // that's the default/most common competition type.
                const cn = className.toLowerCase();
                const isYouthClass = /youth|junior|u-?20|u-?18/.test(cn);
                const isT20Class = /t20|twenty ?20/.test(cn);
                const seam = isYouthClass ? youthSeamRating : seniorSeamRating;
                const spin = isYouthClass ? youthSpinRating : seniorSpinRating;
                const bat = isT20Class
                    ? (isYouthClass ? youthT20BatRating : seniorT20BatRating)
                    : (isYouthClass ? youthBatRating : seniorBatRating);
                const rec = recommendPitchForSquad(seam, spin, bat);
                const isMatch = currentPitch && rec.pitch && currentPitch.toLowerCase() === rec.pitch.toLowerCase();
                if (className) matchedAnyClass = true;

                currentHtml += `<tr><td style="font-weight:600;">${className}</td><td><span class="ftp-stat-badge ${isMatch ? 'green' : 'neutral'}">${currentPitch}</span></td><td><span class="ftp-stat-badge ${isMatch ? 'green' : 'amber'}">${rec.pitch}</span></td></tr>`;
                if (className) {
                    // Real pasted-match evidence for the CURRENT pitch, if any
                    // exists — only shown when there's actually a Pitch: row
                    // in history for it (raw-HTML pastes only), never guessed.
                    const pitchEvidence = getPitchHistoryStats(currentPitch);
                    const evidenceLine = pitchEvidence
                        ? `<div class="vj-text-xs vj-mt-4" style="color:var(--vj-blue);">📋 ${pitchEvidence.matches} pasted match${pitchEvidence.matches > 1 ? 'es' : ''} on ${currentPitch}: seam econ ${pitchEvidence.seamEcon ?? '—'} vs spin econ ${pitchEvidence.spinEcon ?? '—'}</div>`
                        : '';
                    recHtml += `<div class="ftp-rec ${isMatch ? 'low' : 'medium'}" style="margin:5px 0;">
                        <div class="vj-flex-between"><span class="vj-fw-700">${className}</span>${isMatch ? '<span class="ftp-stat-badge green">Already set</span>' : `<span class="ftp-stat-badge amber">Consider: ${rec.pitch}</span>`}</div>
                        <div class="vj-text-xs vj-text-secondary vj-mt-4">${rec.reason}</div>
                        ${evidenceLine}
                    </div>`;
                }
            }
        });
        currentHtml += '</tbody></table>';
        document.getElementById('ftp-current-pitches').innerHTML = currentHtml;

        if (!matchedAnyClass) {
            // No real class rows found on this page load (e.g. ground.htm
            // hasn't rendered its pitch table yet) — fall back to the old
            // senior/youth x OD/T20 breakdown so there's still useful
            // output, just not tied to real settable pitch slots.
            const fallback = [
                { type: 'Senior (most matches)', ...recommendPitchForSquad(seniorSeamRating, seniorSpinRating, seniorBatRating) },
                { type: 'Senior T20', ...recommendPitchForSquad(seniorSeamRating, seniorSpinRating, seniorT20BatRating) },
                { type: 'Youth', ...recommendPitchForSquad(youthSeamRating, youthSpinRating, youthBatRating) },
                { type: 'Youth T20', ...recommendPitchForSquad(youthSeamRating, youthSpinRating, youthT20BatRating) }
            ];
            fallback.forEach(rec => {
                recHtml += `<div class="ftp-rec low" style="margin:5px 0;">
                    <div class="vj-flex-between"><span class="vj-fw-700">${rec.type}</span><span class="ftp-stat-badge green">${rec.pitch}</span></div>
                    <div class="vj-text-xs vj-text-secondary vj-mt-4">${rec.reason}</div>
                </div>`;
            });
        }
        document.getElementById('ftp-pitch-recs').innerHTML = recHtml;

        const groundCache = loadGroundCache();
        const financeCache = loadFinanceCache();
        const teamInfoCache = loadTeamInfoCache();
        const divInfo = teamInfoCache?.division || 4;

        if (groundCache) {
            const capRec = recommendCapacity(groundCache, financeCache, divInfo, teamInfoCache);
            let capHtml = '<div class="ftp-info-box">';

            capHtml += `<div class="vj-flex-between vj-mb-4"><span class="vj-fw-700">${groundCache.groundName || 'Ground'}</span><span class="ftp-stat-badge ${capRec.action === 'expand' ? 'amber' : capRec.action === 'reduce' ? 'red' : 'green'}">${capRec.action === 'expand' ? 'Expand' : capRec.action === 'reduce' ? 'Reduce' : 'Maintain'}</span></div>`;

            capRec.details.forEach(d => { capHtml += `<div class="ftp-stat-row"><span class="vj-text-xs vj-text-secondary">\u2022 ${d}</span></div>`; });

            if (capRec.reason) {
                capHtml += `<div class="vj-mt-4" style="padding:6px 8px;background:rgba(255,255,255,.06);border-radius:4px;font-size:11px;color:#c5c8cd;">${capRec.reason}</div>`;
            }

            if (capRec.warnings.length > 0) {
                capHtml += '<div style="margin-top:6px;">';
                capRec.warnings.forEach(w => { capHtml += `<div style="color:#f59e0b;font-size:11px;margin-bottom:2px;">\u26A0 ${w}</div>`; });
                capHtml += '</div>';
            }

            capHtml += '</div>';
            document.getElementById('ftp-capacity-recs').innerHTML = capHtml;
        } else {
            document.getElementById('ftp-capacity-recs').innerHTML = '<div class="vj-text-sm vj-text-muted">Visit the Ground page to load capacity data.</div>';
        }
    }

    // ============================================================
    // MATCH REVIEW (v8.72) — paste a scorecard, get reasoning about
    // why batters/bowlers/tactics worked or didn't.
    // The game's scorecard copy is tab/whitespace-delimited and carries
    // enough info to reason WITHOUT the skill sheet: runs, balls, SR,
    // wickets, economy, the bowler's style (rws/rfs/... in parens, so we
    // can split seam vs spin), the fall-of-wickets (collapse detection)
    // and the chase pacing. This is deliberately input-only (no scraping)
    // so you can also analyse opponent / world-cup / any pasted results.
    // ============================================================
    const MATCH_BAT_HEADER = /^(.*?)\tRuns\tBalls\t4s\t6s\tSR/i;
    const MATCH_BOWL_HEADER = /^Bowling\tOvers\tMaidens\tRuns\tWickets\tEcon/i;

    function oversToDecimal(text) {
        const m = String(text || '').trim().match(/^(\d+)(?:\.(\d))?$/);
        if (!m) return parseFloat(text) || 0;
        return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) / 6 : 0);
    }

    function parseBattingRow(cells) {
        // non-empty cells; trailing 5 = runs, balls, 4s, 6s, SR
        if (cells.length < 6) return null;
        const n = cells.length;
        return {
            name: cells[0].trim(),
            dismissal: cells.slice(1, n - 5).join(' ').trim(),
            runs: parseInt(cells[n - 5], 10), balls: parseInt(cells[n - 4], 10),
            fours: parseInt(cells[n - 3], 10), sixes: parseInt(cells[n - 2], 10),
            sr: parseFloat(cells[n - 1]),
            // Matches "(wk)" alone AND combos like "(c,wk)"/"(wk,c)" — a
            // captain-wicketkeeper is common in real scorecards (e.g. "B.
            // McCullum (c,wk)") and the old exact-"(wk)" match silently
            // missed them, dropping the keeper line from that innings'
            // review with no indication anything was skipped.
            isKeeper: /\([^)]*\bwk\b[^)]*\)/i.test(cells[0]),
            isNotOut: /not out/i.test(cells.slice(1, n - 5).join(' '))
        };
    }

    function parseBowlingRow(cells) {
        if (cells.length < 6) return null;
        const name = cells[0].trim();
        const tm = name.match(/\(([^)]+)\)/);
        const type = tm ? tm[1] : '';
        return {
            name: name.replace(/\s*\([^)]*\)/, '').trim(),
            type, category: BOWLER_CATEGORY[type] || 'none',
            oversText: cells[1], overs: oversToDecimal(cells[1]),
            maidens: parseInt(cells[2], 10), runs: parseInt(cells[3], 10),
            wickets: parseInt(cells[4], 10), econ: parseFloat(cells[5]),
            noballs: parseInt(cells[6] || 0, 10), wides: parseInt(cells[7] || 0, 10)
        };
    }

    function parseMatchTeams(header) {
        let seg = header.match(/\((.+?)\s*>>\s*Scorecard/i);
        seg = seg ? seg[1] : (header.match(/\((.+?)\)/i) || [null, header])[1];
        const parts = String(seg || '').split(/\s+v\s+/i).map(s => s.trim()).filter(Boolean);
        return parts.length >= 2 ? parts : [seg || '', ''];
    }

    function parseMatchChunk(chunk) {
        const innings = [];
        let active = null, inBowling = false;
        let result = '', toss = '', motm = '';
        for (const raw of chunk.lines) {
            let line = raw;
            if (line.indexOf('\t') === -1) line = line.replace(/\s{2,}/g, '\t'); // tolerate space-aligned paste
            const tl = line.trim();
            if (!tl) continue;
            if (/^Result:/i.test(tl)) { result = tl.replace(/^Result:\s*/i, ''); continue; }
            if (/^Toss:/i.test(tl)) { toss = tl.replace(/^Toss:\s*/i, ''); continue; }
            if (/^Man of the match:/i.test(tl)) { motm = tl.replace(/^Man of the match:\s*/i, ''); continue; }

            const bh = line.match(MATCH_BAT_HEADER);
            if (bh) { if (active) innings.push(active); active = { battingTeam: bh[1].trim(), battingPlayers: [], bowlingPlayers: [], runs: 0, wickets: 0, overs: '', extras: '', fall: [], rr: null }; inBowling = false; continue; }
            if (MATCH_BOWL_HEADER.test(line)) { if (active) inBowling = true; continue; }
            if (!active) continue;

            if (/^Extras:/i.test(tl)) { active.extras = tl; continue; }
            if (/^Fall of wickets:/i.test(tl)) {
                active.fall = (tl.replace(/^Fall of wickets:\s*/i, '').match(/\d+-\d+\s*\([^)]*\)/g) || []).map(it => {
                    const m = it.match(/(\d+)-(\d+)\s*\(([^)]*?),?\s*([\d.]+?)\s*ov\)/i);
                    return m ? { wk: +m[1], score: +m[2], over: m[4] } : null;
                }).filter(Boolean);
                continue;
            }
            const tm = tl.match(/^Total:\s*\((\d+)\s+wickets?,\s*([\d.]+)\s+overs?\)\s*(\d+)(?:\s*RR:\s*([\d.]+))?/i);
            if (tm) { active.wickets = +tm[1]; active.overs = tm[2]; active.runs = +tm[3]; active.rr = tm[4] ? +tm[4] : null; continue; }

            const cells = line.split('\t').map(c => c.trim()).filter(c => c !== '');
            if (cells.length === 0) continue;
            const row = inBowling ? parseBowlingRow(cells) : parseBattingRow(cells);
            if (row) {
                if (inBowling) active.bowlingPlayers.push(row);
                else active.battingPlayers.push(row);
            }
        }
        if (active) innings.push(active);
        if (innings.length === 0) return null;
        if (innings.length >= 2) {
            innings[0].bowlingTeam = innings[1].battingTeam;
            innings[1].bowlingTeam = innings[0].battingTeam;
        }
        return { teams: parseMatchTeams(chunk.header), result, toss, motm, innings };
    }

    // Parses ONE innings <div> from a real scorecard.htm page — the div
    // contains two tables (batting stats, then bowling figures against
    // that innings). Mirrors parseMatchChunk's output shape exactly so
    // the history/scouting lookups work unchanged whether the match came
    // from a tab-paste or raw HTML.
    function parseInningsDivFromHTML(div) {
        const tables = div.querySelectorAll('table.data.stats');
        if (tables.length < 1) return null;
        const battingTable = tables[0];
        const bowlingTable = tables[1];

        const headerTh = battingTable.querySelector('thead th');
        const battingTeam = headerTh ? headerTh.textContent.trim() : '';

        const battingPlayers = [];
        battingTable.querySelectorAll('tbody tr').forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 8) return; // DNB row (2 empty + 1 colspan placeholder)
            const nameLink = tds[0].querySelector('a.player');
            if (!nameLink) return;
            const roleText = tds[0].textContent.replace(nameLink.textContent, '').trim();
            const name = escapeHtml(nameLink.textContent.trim());
            const dismissalText = (tds[1].textContent.trim() + ' ' + tds[2].textContent.trim()).trim();
            const runs = parseInt(tds[3].textContent.trim(), 10);
            if (isNaN(runs)) return;
            battingPlayers.push({
                name, dismissal: dismissalText,
                runs, balls: parseInt(tds[4].textContent.trim(), 10),
                fours: parseInt(tds[5].textContent.trim(), 10), sixes: parseInt(tds[6].textContent.trim(), 10),
                sr: parseFloat(tds[7].textContent.trim()),
                // "wk" as a token anywhere in the role suffix — matches
                // both "(wk)" and combo roles like "(c,wk)" (see the
                // matching fix in parseBattingRow for the tab-paste path).
                isKeeper: /\bwk\b/i.test(roleText),
                isNotOut: /not out/i.test(dismissalText)
            });
        });

        // Extras/Total/Fall of wickets live in <tfoot> rows keyed by <th> label.
        let wickets = 0, overs = '', runsTotal = 0, rr = null, fall = [];
        battingTable.querySelectorAll('tfoot tr').forEach(tr => {
            const th = tr.querySelector('th');
            if (!th) return;
            const label = th.textContent.trim();
            if (/^Total:/i.test(label)) {
                const rowText = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()).join(' ');
                const m = rowText.match(/\((\d+)\s+wickets?,\s*([\d.]+)\s+overs?\)\s*(\d+)(?:\s*RR:\s*([\d.]+))?/i);
                if (m) { wickets = +m[1]; overs = m[2]; runsTotal = +m[3]; rr = m[4] ? +m[4] : null; }
            } else if (/^Fall of wickets:/i.test(label)) {
                const rowText = Array.from(tr.querySelectorAll('td')).map(td => td.textContent).join(' ');
                fall = (rowText.match(/\d+-\d+\s*\([^)]*\)/g) || []).map(it => {
                    const m = it.match(/(\d+)-(\d+)\s*\(([^)]*?),?\s*([\d.]+?)\s*ov\)/i);
                    return m ? { wk: +m[1], score: +m[2], over: m[4] } : null;
                }).filter(Boolean);
            }
        });

        const bowlingPlayers = [];
        if (bowlingTable) {
            bowlingTable.querySelectorAll('tbody tr').forEach(tr => {
                const tds = tr.querySelectorAll('td');
                if (tds.length < 6) return;
                const nameLink = tds[0].querySelector('a.player');
                if (!nameLink) return;
                const typeSpan = tds[0].querySelector('span.bowlerType');
                const typeMatch = typeSpan ? typeSpan.textContent.match(/\(([a-z]+)\)/i) : null;
                const type = typeMatch ? typeMatch[1].toLowerCase() : '';
                const name = escapeHtml(nameLink.textContent.trim());
                const oversText = tds[1].textContent.trim();
                bowlingPlayers.push({
                    name, type, category: BOWLER_CATEGORY[type] || 'none',
                    oversText, overs: oversToDecimal(oversText),
                    maidens: parseInt(tds[2].textContent.trim(), 10), runs: parseInt(tds[3].textContent.trim(), 10),
                    wickets: parseInt(tds[4].textContent.trim(), 10), econ: parseFloat(tds[5].textContent.trim()),
                    noballs: parseInt((tds[6] && tds[6].textContent.trim()) || '0', 10),
                    wides: parseInt((tds[7] && tds[7].textContent.trim()) || '0', 10)
                });
            });
        }

        return { battingTeam: escapeHtml(battingTeam), battingPlayers, bowlingPlayers, runs: runsTotal, wickets, overs, extras: '', fall, rr };
    }

    // Parses a real scorecard.htm page (raw HTML, e.g. pasted from
    // "view source" or a saved page) into the same {teams, result, toss,
    // motm, innings} shape parseMatchChunk() produces from the tab-
    // delimited copy-paste text, so the history/scouting lookups work
    // identically regardless of which format the user pasted. Real HTML is
    // far more reliably structured than trying to reconstruct fake tab-delimited
    // lines from it, so this parses the actual DOM directly via
    // DOMParser rather than converting HTML to text first.
    function parseScorecardFromHTMLDoc(doc) {
        const h1 = doc.querySelector('#middle h1, h1');
        const titleText = (h1 ? h1.textContent : (doc.querySelector('title') ? doc.querySelector('title').textContent : '')).trim();
        const teams = parseMatchTeams(titleText);

        let result = '', toss = '', motm = '', ground = '', pitch = '', weather = '';
        doc.querySelectorAll('table.data tr').forEach(tr => {
            const th = tr.querySelector('th');
            const td = tr.querySelector('td');
            if (!th || !td) return;
            const label = th.textContent.trim();
            if (/^Result:/i.test(label)) result = td.textContent.trim();
            else if (/^Toss:/i.test(label)) toss = td.textContent.trim();
            else if (/^Man of the match:/i.test(label)) motm = td.textContent.trim();
            // Ground/Pitch/Weather aren't always present on every scorecard
            // layout — best-effort only, left blank (not fabricated) when
            // the page doesn't expose them, so aggregation just skips those
            // matches rather than working off a guessed value.
            else if (/^Ground:/i.test(label)) ground = td.textContent.trim();
            else if (/^Pitch:/i.test(label)) pitch = td.textContent.trim();
            else if (/^Weather:/i.test(label)) weather = td.textContent.trim();
        });

        // Each innings is one of the plain (non-"marg-bottom"-table)
        // wrapper <div>s inside #middle that contains a batting stats
        // table — using this containment check (rather than a fixed
        // selector) since the page has no dedicated innings wrapper class.
        const innings = [];
        const middle = doc.getElementById('middle') || doc;
        middle.querySelectorAll(':scope > div').forEach(div => {
            if (div.querySelector('table.data.stats.marg-bottom')) {
                const parsed = parseInningsDivFromHTML(div);
                if (parsed) innings.push(parsed);
            }
        });

        if (innings.length >= 2) {
            innings[0].bowlingTeam = innings[1].battingTeam;
            innings[1].bowlingTeam = innings[0].battingTeam;
        }
        if (innings.length === 0) return null;
        return { teams, result, toss, motm, innings, ground: ground || undefined, pitch: pitch || undefined, weather: weather || undefined };
    }

    function parseMatchScorecard(text) {
        const raw = String(text || '');
        // HTML input (a real scorecard.htm page pasted, possibly several
        // back to back) — detected by a real document boundary rather
        // than a loose tag sniff, so a tab-pasted result that happens to
        // mention an HTML-looking word isn't misrouted here.
        if (/<html[\s>]/i.test(raw) && /<\/html\s*>/i.test(raw)) {
            const docs = raw.match(/<html[\s\S]*?<\/html\s*>/gi) || [];
            const parser = new DOMParser();
            return docs.map(docHtml => {
                try {
                    const doc = parser.parseFromString(docHtml, 'text/html');
                    return parseScorecardFromHTMLDoc(doc);
                } catch (e) { return null; }
            }).filter(Boolean);
        }

        const chunks = [];
        let cur = null;
        for (const line0 of raw.replace(/\r/g, '').split('\n')) {
            const line = line0.trimEnd();
            const isHeader = /match\s+\d+\s*\(/i.test(line) || (/scorecard/i.test(line) && /\sv\s+/i.test(line));
            if (isHeader) { if (cur) chunks.push(cur); cur = { header: line, lines: [] }; }
            else if (cur) cur.lines.push(line);
        }
        if (cur) chunks.push(cur);
        return chunks.map(parseMatchChunk).filter(Boolean);
    }

    // ── Pasted-match history persistence + scouting lookups ──
    // The point of the Match Review paste box isn't the one-off report — it's
    // feeding real observed evidence (who actually bowled/batted well, at what
    // economy/SR) forward into the tactics advisor for future team setup.
    // Every parsed match is stored (compact — just the scorecard numbers
    // already on `match`, no HTML) so a later visit to Match Orders / Ground
    // can look up any named player or team that's shown up in a pasted match.
    function loadMatchHistory() {
        try {
            const raw = GM_getValue(MATCH_HISTORY_KEY, null);
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    function saveMatchesToHistory(matches) {
        if (!matches || !matches.length) return;
        try {
            let hist = loadMatchHistory();
            // Dedupe on (teams+result+both innings' final score) so re-analyzing
            // the same paste (e.g. re-clicking Analyze) doesn't duplicate it.
            const sig = m => [m.teams.join('|'), m.result, ...m.innings.map(i => `${i.battingTeam}:${i.runs}/${i.wickets}`)].join('~');
            const known = new Set(hist.map(sig));
            matches.forEach(m => {
                if (!known.has(sig(m))) { hist.push(Object.assign({ savedAt: Date.now() }, m)); known.add(sig(m)); }
            });
            if (hist.length > MATCH_HISTORY_MAX) hist = hist.slice(hist.length - MATCH_HISTORY_MAX);
            GM_setValue(MATCH_HISTORY_KEY, JSON.stringify(hist));
        } catch (e) { /* non-fatal; ignore storage failures */ }
    }

    // Aggregates every pasted-match appearance of a named player (case/
    // whitespace-insensitive) into overall bowling/batting figures. Returns
    // null when the name has never appeared, so callers can tell "no
    // evidence" apart from "evidence of a weak player".
    function getPlayerHistoryStats(name, history) {
        if (!name) return null;
        const target = String(name).trim().toLowerCase();
        if (!target) return null;
        const hist = history || loadMatchHistory();
        let bOvers = 0, bRuns = 0, bWkts = 0, bMatches = 0;
        let batRuns = 0, batBalls = 0, batInnings = 0, batBest = 0;
        hist.forEach(m => {
            (m.innings || []).forEach(inn => {
                (inn.bowlingPlayers || []).forEach(bp => {
                    if (bp.name && bp.name.trim().toLowerCase() === target) {
                        bOvers += bp.overs || 0; bRuns += bp.runs || 0; bWkts += bp.wickets || 0; bMatches++;
                    }
                });
                (inn.battingPlayers || []).forEach(bp => {
                    if (bp.name && bp.name.trim().toLowerCase() === target) {
                        batRuns += bp.runs || 0; batBalls += bp.balls || 0; batInnings++;
                        if (bp.runs > batBest) batBest = bp.runs;
                    }
                });
            });
        });
        if (bMatches === 0 && batInnings === 0) return null;
        return {
            bowling: bMatches > 0 ? { overs: +bOvers.toFixed(1), runs: bRuns, wickets: bWkts, econ: bOvers > 0 ? +(bRuns / bOvers).toFixed(2) : 0, matches: bMatches } : null,
            batting: batInnings > 0 ? { runs: batRuns, balls: batBalls, sr: batBalls > 0 ? +(batRuns / batBalls * 100).toFixed(1) : 0, innings: batInnings, best: batBest } : null
        };
    }

    // Team-level fallback for when the opponent's current squad isn't
    // cached (so individual names can't be cross-referenced) but the team
    // NAME shown up in a pasted match — aggregates seam/spin economy for
    // their bowling and average SR for their batting.
    function getTeamHistoryStats(teamName, history) {
        if (!teamName) return null;
        const target = String(teamName).trim().toLowerCase();
        if (!target) return null;
        const hist = history || loadMatchHistory();
        let matchesFound = 0;
        const bowlers = {}; // name -> {overs,runs,wickets}
        const batters = {}; // name -> {runs,balls}
        hist.forEach(m => {
            // Match against each innings' own battingTeam/bowlingTeam rather
            // than m.teams — the tab-paste header parser can leave trailing
            // junk (e.g. "Team >> Scorecard") on the second team name, while
            // the innings team names (read straight off the stats table
            // header) are always clean.
            const involved = (m.innings || []).some(inn =>
                (inn.battingTeam && inn.battingTeam.trim().toLowerCase() === target) ||
                (inn.bowlingTeam && inn.bowlingTeam.trim().toLowerCase() === target));
            if (!involved) return;
            matchesFound++;
            (m.innings || []).forEach(inn => {
                if (inn.bowlingTeam && inn.bowlingTeam.trim().toLowerCase() === target) {
                    (inn.bowlingPlayers || []).forEach(bp => {
                        const e = bowlers[bp.name] || (bowlers[bp.name] = { overs: 0, runs: 0, wickets: 0 });
                        e.overs += bp.overs || 0; e.runs += bp.runs || 0; e.wickets += bp.wickets || 0;
                    });
                }
                if (inn.battingTeam && inn.battingTeam.trim().toLowerCase() === target) {
                    (inn.battingPlayers || []).forEach(bp => {
                        const e = batters[bp.name] || (batters[bp.name] = { runs: 0, balls: 0 });
                        e.runs += bp.runs || 0; e.balls += bp.balls || 0;
                    });
                }
            });
        });
        if (matchesFound === 0) return null;
        const bowlerList = Object.entries(bowlers).map(([name, e]) => ({ name, overs: +e.overs.toFixed(1), wickets: e.wickets, econ: e.overs > 0 ? +(e.runs / e.overs).toFixed(2) : 0 }))
            .filter(b => b.overs >= 2).sort((a, b) => (b.wickets - a.wickets) || (a.econ - b.econ));
        const batterList = Object.entries(batters).map(([name, e]) => ({ name, runs: e.runs, sr: e.balls > 0 ? +(e.runs / e.balls * 100).toFixed(1) : 0 }))
            .filter(b => b.runs >= 10).sort((a, b) => b.runs - a.runs);
        return { matchesFound, bowlers: bowlerList.slice(0, 3), batters: batterList.slice(0, 3) };
    }

    // Aggregates seam-vs-spin economy across every pasted match that recorded
    // a given pitch type (only present when the pasted input was raw HTML
    // with a Pitch: row — the tab-delimited copy has no pitch info, so those
    // matches are simply skipped here rather than guessed at). Returns null
    // below a small evidence floor (2 matches) to avoid a one-match fluke
    // reading as a real trend.
    function getPitchHistoryStats(pitchName, history) {
        if (!pitchName) return null;
        const target = String(pitchName).trim().toLowerCase();
        const hist = (history || loadMatchHistory()).filter(m => m.pitch && m.pitch.trim().toLowerCase() === target);
        if (hist.length < 2) return null;
        let seamOvers = 0, seamRuns = 0, spinOvers = 0, spinRuns = 0;
        hist.forEach(m => (m.innings || []).forEach(inn => (inn.bowlingPlayers || []).forEach(bp => {
            if (bp.category === 'seam') { seamOvers += bp.overs || 0; seamRuns += bp.runs || 0; }
            else if (bp.category === 'spin') { spinOvers += bp.overs || 0; spinRuns += bp.runs || 0; }
        })));
        if (seamOvers < 5 && spinOvers < 5) return null;
        return {
            matches: hist.length,
            seamEcon: seamOvers > 0 ? +(seamRuns / seamOvers).toFixed(2) : null,
            spinEcon: spinOvers > 0 ? +(spinRuns / spinOvers).toFixed(2) : null
        };
    }

    // Opponent name uses the same parsed fixture teams as opponent ID.
    function getOpponentTeamName() {
        const teams = parseFixtureTeams(document);
        if (teams.home && teams.home.id !== String(TEAM_ID)) return teams.home.name;
        if (teams.away && teams.away.id !== String(TEAM_ID)) return teams.away.name;
        return null;
    }

    // Builds the "real match evidence" alert for the Match Orders toss
    // section — cross-references named opponent squad players (if cached)
    // against pasted-match history first (most precise: same actual player),
    // falling back to a team-level aggregate keyed by opponent name when no
    // squad cache or no name matches are available.
    function buildPastedScoutingHtml(opponentPlayers, opponentName) {
        const history = loadMatchHistory();
        if (!history.length) return '';
        const playerHits = [];
        if (opponentPlayers && opponentPlayers.length) {
            opponentPlayers.forEach(p => {
                const stats = getPlayerHistoryStats(p.name, history);
                if (stats) playerHits.push({ name: p.name, stats });
            });
        }
        if (playerHits.length > 0) {
            const bowlLines = playerHits.filter(h => h.stats.bowling).sort((a, b) => a.stats.bowling.econ - b.stats.bowling.econ).slice(0, 3)
                .map(h => `${h.name} (${h.stats.bowling.wickets}wk @${h.stats.bowling.econ} econ over ${h.stats.bowling.matches}m)`);
            const batLines = playerHits.filter(h => h.stats.batting).sort((a, b) => b.stats.batting.sr - a.stats.batting.sr).slice(0, 3)
                .map(h => `${h.name} (SR ${h.stats.batting.sr}, best ${h.stats.batting.best})`);
            const parts = [];
            if (bowlLines.length) parts.push(`<strong>Bowlers to watch:</strong> ${bowlLines.join('; ')}`);
            if (batLines.length) parts.push(`<strong>Batters to watch:</strong> ${batLines.join('; ')}`);
            if (!parts.length) return '';
            return `<div class="ftp-alert info" style="margin:4px 0 0 0;"><span>📋</span><div>Real evidence from ${playerHits.length} squad player${playerHits.length > 1 ? 's' : ''} seen in pasted matches: ${parts.join(' · ')}</div></div>`;
        }
        // No per-player cross-reference (squad not cached, or none of these
        // names have shown up in a pasted match yet) — fall back to a
        // team-level aggregate if the opponent's name itself is in history.
        if (opponentName) {
            const teamStats = getTeamHistoryStats(opponentName, history);
            if (teamStats) {
                const parts = [];
                if (teamStats.bowlers.length) parts.push(`<strong>Bowlers:</strong> ${teamStats.bowlers.map(b => `${b.name} (${b.wickets}wk @${b.econ})`).join('; ')}`);
                if (teamStats.batters.length) parts.push(`<strong>Batters:</strong> ${teamStats.batters.map(b => `${b.name} (${b.runs}r, SR ${b.sr})`).join('; ')}`);
                if (!parts.length) return '';
                return `<div class="ftp-alert info" style="margin:4px 0 0 0;"><span>📋</span><div>Real evidence from ${teamStats.matchesFound} pasted match${teamStats.matchesFound > 1 ? 'es' : ''} of ${escapeHtml(opponentName)}: ${parts.join(' · ')}</div></div>`;
            }
        }
        return '';
    }

    // A bare paste-and-save box — deliberately NOT a report. Pasting a match
    // here only feeds the persisted history that Match Orders/Ground read
    // from (buildPastedScoutingHtml/getPitchHistoryStats above); there is no
    // on-screen analysis of the pasted match itself, per explicit user
    // instruction ("the match review part is not needed").
    function createMatchPasteUI() {
        if (document.getElementById('ftp-match-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'ftp-match-panel';
        panel.innerHTML = `
            <div style="position:fixed;right:12px;bottom:12px;z-index:2147483646;width:320px;background:var(--vj-surface);border:1px solid var(--vj-border);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);font:12px/1.5 system-ui;">
              <div id="ftp-match-head" style="padding:8px 10px;background:var(--vj-surface2,#eef1f4);border-radius:12px 12px 0 0;cursor:move;font-weight:700;display:flex;justify-content:space-between;align-items:center;">
                <span>\u{1F4CB} Match Data</span>
                <button id="ftp-match-toggle" style="background:none;border:none;cursor:pointer;font-size:12px;">▼</button>
              </div>
              <div id="ftp-match-body" style="padding:8px 10px;">
                <div class="vj-text-xs vj-text-muted" style="margin-bottom:4px;">Paste a completed scorecard (tab-copy or full page HTML) to feed real bowler/batter/pitch evidence into Match Orders and Ground.</div>
                <textarea id="ftp-match-input" spellcheck="false" style="width:100%;height:72px;box-sizing:border-box;font:11px/1.4 monospace;"></textarea>
                <button id="ftp-match-analyze" class="ftp-button ftp-button-primary" style="width:100%;margin-top:6px;">\u{1F4BE} Save</button>
                <div id="ftp-match-output" class="vj-text-xs vj-text-muted" style="margin-top:6px;"></div>
              </div>
            </div>`;
        document.body.appendChild(panel);
        addCommonStyles();
        makeDraggable(panel, panel.querySelector('#ftp-match-head'));
        panel.querySelector('#ftp-match-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            const body = panel.querySelector('#ftp-match-body');
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            e.target.textContent = hidden ? '▼' : '▲';
        });
        panel.querySelector('#ftp-match-analyze').addEventListener('click', () => {
            const input = panel.querySelector('#ftp-match-input');
            const matches = parseMatchScorecard(input.value);
            const output = panel.querySelector('#ftp-match-output');
            if (!matches.length) {
                output.textContent = 'Couldn’t parse any matches — paste a full scorecard (Result/Toss + two innings, or the full scorecard.htm HTML).';
                return;
            }
            saveMatchesToHistory(matches);
            output.textContent = `Saved ${matches.length} match${matches.length > 1 ? 'es' : ''} (${loadMatchHistory().length} total in history) — will surface as scouting evidence on Match Orders/Ground when these players/teams/pitches come up.`;
            input.value = '';
        });
    }

    function recommendPitchForSquad(seamRating, spinRating, batRating) {
        // Based on Admin team's expert guide from FTP forums
        // Team strength categories: Batting, Seam (F/FM), Spin
        // Find which areas we're strongest in (top 1-2)
        // All ratings are averages of ALL players' skills (comparable)
        // Returns { pitch, reason } so the UI can explain WHY

        const avgBowling = (seamRating + spinRating) / 2;
        const strengths = [
            { type: 'seam', rating: seamRating, label: 'Seam' },
            { type: 'spin', rating: spinRating, label: 'Spin' },
            { type: 'bat', rating: batRating, label: 'Batting' }
        ].sort((a, b) => b.rating - a.rating);

        const primary = strengths[0];
        const secondary = strengths[1];
        const weakest = strengths[2];
        const primaryAdvantage = primary.rating - weakest.rating;
        const batAdvantage = batRating - avgBowling;

        // Better Batting: Hard, Crumbling, Slow
        // Only recommend Hard if batting is CLEARLY dominant (1+ above avg bowling)
        if (primary.type === 'bat' && batAdvantage > 1.0) {
            if (secondary.type === 'seam' && secondary.rating > 5) {
                return { pitch: 'Hard', reason: `Batting (${batRating.toFixed(1)}) is strongest, with good seamers (${secondary.rating.toFixed(1)}). Hard rewards fast bowlers and batting — "neutralizes spin/mediums."` };
            } else if (secondary.type === 'spin' && secondary.rating > 5) {
                return { pitch: 'Crumbling', reason: `Batting (${batRating.toFixed(1)}) + strong spinners (${secondary.rating.toFixed(1)}). Crumbling: "wrist spinners single-handedly win games." Deep batting essential.` };
            } else if (primaryAdvantage > 2.5) {
                return { pitch: 'Hard', reason: `Batting is dominant (${batRating.toFixed(1)}, ${primaryAdvantage.toFixed(1)} above weakest). Hard favours batters — set a big total.` };
            } else {
                return { pitch: 'Slow', reason: `Batting (${batRating.toFixed(1)}) is strongest but no clear secondary strength. Slow slows run-scoring, rewards good batsmen. Late collapses common when chasing.` };
            }
        }

        // Better Seamers: Uneven (F/FM), Green (M)
        // Only recommend Uneven if seam is CLEARLY dominant
        if (primary.type === 'seam' && primary.rating > avgBowling + 1.0) {
            if (primaryAdvantage > 2 && primary.rating > 6) {
                return { pitch: 'Uneven', reason: `Seam (${primary.rating.toFixed(1)}) is dominant. Uneven: "F/FM get big advantage, particularly destructive around drinks." Favour fast/fast-medium bowlers.` };
            } else if (secondary.type === 'bat' && secondary.rating > 5) {
                return { pitch: 'Hard', reason: `Seam (${primary.rating.toFixed(1)}) + batting (${secondary.rating.toFixed(1)}). Hard rewards F/FM quicks and batting — use your fast bowlers aggressively.` };
            } else if (secondary.type === 'spin' && secondary.rating > 4) {
                return { pitch: 'Sticky', reason: `Seam (${primary.rating.toFixed(1)}) + spin (${secondary.rating.toFixed(1)}). Sticky: most balanced pitch, rewards balanced sides. Use RRR pressure route.` };
            } else {
                return { pitch: 'Green', reason: `Seam (${primary.rating.toFixed(1)}) is strongest. Green: medium pacers become MUCH more effective. Biggest Par Score variation (160-270).` };
            }
        }

        // Better Spinners: Dry, Crumbling, Slow
        // Only recommend Crumbling/Dry if spin is CLEARLY dominant
        if (primary.type === 'spin' && primary.rating > avgBowling + 1.0) {
            if (primaryAdvantage > 2 && primary.rating > 6) {
                return { pitch: 'Crumbling', reason: `Spin (${primary.rating.toFixed(1)}) is dominant. Crumbling: "all bowlers destructive, wrist spinners single-handedly win games." Deep batting essential.` };
            } else if (secondary.type === 'bat' && secondary.rating > 5) {
                return { pitch: 'Crumbling', reason: `Spin (${primary.rating.toFixed(1)}) + batting (${secondary.rating.toFixed(1)}). Crumbling: wrist spinners win games. Need deep batting lineup.` };
            } else if (primary.rating >= 6) {
                return { pitch: 'Dry', reason: `Spin (${primary.rating.toFixed(1)}) is strong. Dry: spinners become destructive AND economical. Need 3+ good spinners. Bat first to force grind.` };
            } else {
                return { pitch: 'Slow', reason: `Spin (${primary.rating.toFixed(1)}) is strongest but not dominant. Slow favours medium pace and spin. Good for balanced teams.` };
            }
        }

        // Balanced team (no clear dominant strength)
        if (Math.abs(seamRating - spinRating) < 1.5 && Math.abs(seamRating - batRating) < 1.5) {
            return { pitch: 'Sticky', reason: `Balanced team — Bat ${batRating.toFixed(1)}, Seam ${seamRating.toFixed(1)}, Spin ${spinRating.toFixed(1)} (all within 1.5). Sticky: most balanced pitch, rewards balanced sides.` };
        }

        // Default: Even
        return { pitch: 'Even', reason: `No clear strength advantage — Bat ${batRating.toFixed(1)}, Seam ${seamRating.toFixed(1)}, Spin ${spinRating.toFixed(1)}. Even: no advantage to anyone.` };
    }

    // ── Upcoming fixture fetcher (for training page integration) ──
    // Fetches teamfixtures.htm in background, returns next 1-2 upcoming
    // matches with format (T20/OD/YT20/YOD) so training can adapt.
    function fetchUpcomingFixtures() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.fromthepavilion.org/teamfixtures.htm?teamId=${TEAM_ID}#curr`,
                timeout: 10000,
                onload: function(response) {
                    if (response.status !== 200) { resolve([]); return; }
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(response.responseText, 'text/html');
                    const rows = doc.querySelectorAll('table.data tbody tr');
                    const upcoming = [];
                    const now = new Date();
                    rows.forEach(row => {
                        const cells = row.querySelectorAll('td');
                        if (cells.length < 3) return;
                        const dateText = cells[0].textContent.trim();
                        const matchDate = new Date(dateText.replace(/(\d+) (\w+) (\d+) (\d+):(\d+)/, '$2 $1, $3 $4:$5'));
                        if (isNaN(matchDate.getTime()) || matchDate < now) return;
                        const matchClass = (cells[1]?.querySelector('a')?.textContent.trim() || cells[1]?.textContent.trim() || '').trim();
                        const teams = cells[2]?.textContent.trim() || '';
                        // Determine format from match class text
                        let format = 'OD';
                        const mc = matchClass.toLowerCase();
                        if (mc.includes('twenty20') || mc.includes('t20')) format = mc.includes('youth') ? 'YT20' : 'T20';
                        else if (mc.includes('youth') || mc.includes('yod')) format = 'YOD';
                        else format = 'OD';
                        const gameLink = row.querySelector('a[href*="game.htm?gameId="]');
                        upcoming.push({ date: dateText, matchDate, matchClass, teams, format, gameLink: gameLink?.href || '' });
                    });
                    upcoming.sort((a, b) => a.matchDate - b.matchDate);
                    resolve(upcoming.slice(0, 3));
                },
                onerror: function() { resolve([]); },
                ontimeout: function() { resolve([]); }
            });
        });
    }

    // ============================================================
    // MATCHES PAGE UI - Quick Analyze buttons
    // ============================================================
    // ============================================================
    // MATCH SCHEDULE / ORDER-STATUS PAGE (teamfixtures.htm)
    // Detects which upcoming fixtures still need tactics set.
    // NOTE: this game does NOT use an "orders.htm" link — order status
    // is shown via a status icon per row, and the way to actually set
    // tactics is opening the match's game.htm?gameId=... page. The
    // detector below is intentionally multi-signal because the exact
    // icon markup wasn't available to test against directly: it tries
    // icon alt/title/class text first, then falls back to a generic
    // "has a result already been posted?" check so it never silently
    // mislabels a match. If status still looks wrong for your fixture
    // list, check the browser console for [FTP Matches] rows — that
    // log line makes it obvious which signal fired for each row.
    // ============================================================
    function getMatchGameLink(row) {
        // The team-name link is the canonical way into a match on this
        // game (game.htm?gameId=...); prefer that over any other link
        // in the row since that's what actually lets you set tactics.
        const gameLink = row.querySelector('a[href*="game.htm?gameId="]');
        if (gameLink) return gameLink.href;
        const anyLink = row.querySelector('td a');
        return anyLink ? anyLink.href : '#';
    }

    function getOrderStatus(row) {
        // Returns 'set' | 'needed' | 'complete' | 'unknown'
        // HTML uses <img src="resources/images/orders-set.png"> for set,
        // and <img src="resources/images/orders-set-not.png"> for not set.
        const resultCell = Array.from(row.querySelectorAll('td')).find(td =>
            /won by|match drawn|no result|tied/i.test(td.textContent));
        if (resultCell) return 'complete';

        // Check order icon images — these are the definitive indicators
        const orderImgs = row.querySelectorAll('img');
        for (const img of orderImgs) {
            const src = (img.getAttribute('src') || '').toLowerCase();
            if (src.includes('orders-set-not')) return 'needed';
            if (src.includes('orders-set')) return 'set';
        }

        // Fallback: check for orders.htm link (legacy/some page versions)
        if (row.querySelector('a[href*="orders.htm"]')) return 'set';

        // Icon-based detection: inspect every span/i element in the
        // row for alt/title/class text hinting at status.
        const iconEls = row.querySelectorAll('span, i, svg');
        for (const el of iconEls) {
            const hint = `${el.getAttribute('alt') || ''} ${el.getAttribute('title') || ''} ${el.className || ''}`.toLowerCase();
            if (/tick|check|green|confirm|ready/.test(hint)) return 'set';
            if (/warn|exclaim|alert|yellow|pending|missing/.test(hint)) return 'needed';
        }

        return 'unknown';
    }

    function createMatchesUI() {
        const rows = document.querySelectorAll('table.data tbody tr');
        rows.forEach(row => {
            const lastCell = row.querySelector('td:last-child');
            if (!lastCell) return;
            const status = getOrderStatus(row);
            if (status !== 'needed' && status !== 'unknown') return;

            const analyzeBtn = document.createElement('a');
            analyzeBtn.href = getMatchGameLink(row);
            analyzeBtn.textContent = '\u{1F4CA}';
            analyzeBtn.title = status === 'needed' ? 'Orders not yet set \u2014 open match with advisor' : 'Status unknown \u2014 open match to check';
            analyzeBtn.style.cssText = 'margin-left:5px; text-decoration:none; font-size:14px;';
            lastCell.appendChild(analyzeBtn);
        });

        createPanel({
            title: 'Match Schedule', icon: '\u{1F4C5}',
            buttons: [],
            sections: [
                { id: 'ftp-upcoming', label: 'Upcoming Matches', icon: '\u{1F4C6}', iconColor: 'blue' },
                { id: 'ftp-legend', label: 'Legend', icon: '\u{1F4D6}', iconColor: 'teal',
                  content: '<div class="vj-text-xs vj-text-secondary" style="line-height:1.8;"><span class="ftp-stat-badge red" style="font-size:9px;">Orders Needed</span> <span class="ftp-stat-badge amber" style="font-size:9px;">Orders Set</span> <span class="ftp-stat-badge green" style="font-size:9px;">Complete</span> <span class="ftp-stat-badge neutral" style="font-size:9px;">Unknown</span><br><span class="vj-text-muted">\u{1F4CA} = Click to open match with advisor</span></div>' }
            ]
        });
    }

    function updateMatchesAdvisor() {
        const rows = document.querySelectorAll('table.data tbody tr');
        const upcoming = [];
        const currentDate = new Date();

        rows.forEach(row => {
            const dateCell = row.querySelector('td');
            const classCell = row.querySelector('td:nth-child(2)');
            const teamsCell = row.querySelector('td:nth-child(3)');
            if (!dateCell || !teamsCell) return;

            const dateText = dateCell.textContent.trim();
            const matchDate = new Date(dateText.replace(/(\d+) (\w+) (\d+) (\d+):(\d+)/, '$2 $1, $3 $4:$5'));
            const matchClass = classCell?.querySelector('a')?.textContent.trim() || classCell?.textContent.trim() || '';
            const teams = teamsCell.textContent.trim();
            const status = getOrderStatus(row);

            if (status === 'complete' && matchDate < currentDate) return;

            upcoming.push({ date: dateText, matchClass, teams, status, link: getMatchGameLink(row) });
        });

        const priority = { needed: 0, unknown: 1, set: 2, complete: 3 };
        upcoming.sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9));

        let html = '';
        upcoming.slice(0, 10).forEach(m => {
            const isYouth = m.matchClass.toLowerCase().includes('youth');
            const statusBadge = { needed: '<span class="ftp-stat-badge red">Needed</span>', set: '<span class="ftp-stat-badge amber">Set</span>', complete: '<span class="ftp-stat-badge green">Done</span>', unknown: '<span class="ftp-stat-badge neutral">?</span>' }[m.status] || '<span class="ftp-stat-badge neutral">?</span>';
            html += `<div class="ftp-rec low" style="padding:8px 10px;">
                <div class="vj-flex-between">${statusBadge}<span class="vj-text-xs vj-text-muted">${m.date}</span></div>
                <a href="${m.link}" class="vj-fw-700" style="color:var(--vj-text);text-decoration:none;font-size:12px;display:block;margin-top:4px;">${m.teams}</a>
                <div class="vj-text-xs vj-text-muted vj-mt-4">${m.matchClass} ${isYouth ? '<span class="ftp-stat-badge amber" style="font-size:8px;">Youth</span>' : ''}</div>
            </div>`;
        });
        const statusEl = document.getElementById('ftp-upcoming');
        if (statusEl) statusEl.innerHTML = html || '<div class="ftp-alert info" style="margin:0;">No upcoming matches found.</div>';
    }

    // ============================================================
    // DESIGN SYSTEM — v7.0
    // ============================================================
    function addCommonStyles() {
        GM_addStyle(`
:root {
  /* Warmed the whole neutral scale off cool blue-grey toward a soft
     stone/cream tone (surface, border, text) — the navy+gold accents
     stay put, but a cool #f4f6f9 surface against them read clinical.
     Semantic status colors (green/red/amber/blue/purple/teal/orange)
     are untouched — their meaning is load-bearing across ~6 pages of
     badges/alerts, not worth the regression risk of retuning hue. */
  --vj-navy: #10172a; --vj-navy-mid: #1c2a48; --vj-navy-light: #263657;
  --vj-gold: #cda355; --vj-gold-dim: #a3833f;
  --vj-card: #ffffff; --vj-surface: #f7f5f1; --vj-border: #e7e2d8; --vj-border-light: #f1eee7;
  --vj-text: #2a2621; --vj-text-secondary: #726b62; --vj-text-muted: #a39a8d;
  --vj-green: #059669; --vj-green-bg: #ecfdf5; --vj-green-border: #a7f3d0;
  --vj-red: #dc2626; --vj-red-bg: #fef2f2; --vj-red-border: #fecaca;
  --vj-amber: #d97706; --vj-amber-bg: #fffbeb; --vj-amber-border: #fde68a;
  --vj-blue: #2563eb; --vj-blue-bg: #eff6ff; --vj-blue-border: #bfdbfe;
  --vj-purple: #7c3aed; --vj-purple-bg: #f5f3ff;
  --vj-teal: #0d9488; --vj-teal-bg: #f0fdfa;
  --vj-orange: #ea580c; --vj-orange-bg: #fff7ed;
  --vj-shadow-sm: 0 1px 2px rgba(42,38,33,0.05);
  --vj-shadow: 0 1px 3px rgba(42,38,33,0.08), 0 1px 2px rgba(42,38,33,0.04);
  --vj-shadow-md: 0 4px 6px rgba(42,38,33,0.07), 0 2px 4px rgba(42,38,33,0.04);
  --vj-shadow-lg: 0 10px 25px rgba(42,38,33,0.1), 0 4px 10px rgba(42,38,33,0.05);
  --vj-radius: 12px; --vj-radius-sm: 8px; --vj-radius-xs: 5px;
  /* Snappier: 0.2s -> 0.15s. Interactions should feel immediate, not
     leisurely, on a panel the user is clicking through quickly. */
  --vj-transition: 0.15s cubic-bezier(0.4,0,0.2,1);
}

/* Panel */
#ftp-advisor-panel {
  position: fixed; top: 50px; right: 20px; width: 440px; max-height: 88vh;
  background: var(--vj-surface); border-radius: var(--vj-radius);
  box-shadow: var(--vj-shadow-lg), 0 0 0 1px rgba(0,0,0,0.04);
  z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px; color: var(--vj-text); display: flex; flex-direction: column;
  overflow: hidden;
  animation: vjPanelIn 0.22s cubic-bezier(0.16,1,0.3,1);
}
@keyframes vjPanelIn { from { opacity:0; transform:translateY(-8px) scale(0.98); } to { opacity:1; transform:translateY(0) scale(1); } }

/* Header */
#ftp-advisor-header {
  padding: 14px 18px; cursor: move; user-select: none;
  background: linear-gradient(135deg, var(--vj-navy) 0%, var(--vj-navy-mid) 100%);
  color: #fff; display: flex; justify-content: space-between; align-items: center;
  position: relative; flex-shrink: 0;
}
#ftp-advisor-header::after {
  content: ''; position: absolute; bottom: 0; left: 0; right: 0;
  height: 2px; background: linear-gradient(90deg, transparent, var(--vj-gold), transparent);
}
#ftp-advisor-header h3 {
  margin: 0; font-size: 13.5px; font-weight: 700; letter-spacing: 0.8px;
  text-transform: uppercase; display: flex; align-items: center; gap: 8px;
}
#ftp-advisor-header button {
  background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.75); cursor: pointer; border-radius: var(--vj-radius-xs);
  font-size: 14px; width: 28px; height: 28px; display: flex; align-items: center;
  justify-content: center; transition: all var(--vj-transition);
}
#ftp-advisor-header button:hover {
  background: rgba(255,255,255,0.15); color: #fff; border-color: rgba(255,255,255,0.25);
}

/* Content */
#ftp-advisor-content {
  padding: 14px 16px; overflow-y: auto; flex: 1; background: var(--vj-card);
  line-height: 1.5;
}
#ftp-advisor-content::-webkit-scrollbar { width: 6px; }
#ftp-advisor-content::-webkit-scrollbar-track { background: transparent; }
#ftp-advisor-content::-webkit-scrollbar-thumb { background: var(--vj-border); border-radius: 10px; transition: background var(--vj-transition); }
#ftp-advisor-content::-webkit-scrollbar-thumb:hover { background: var(--vj-text-muted); }

/* Section */
.ftp-section { margin-bottom: 0; padding: 12px 16px; border-bottom: 1px solid var(--vj-border-light); }
.ftp-section:last-child { border-bottom: none; }
.ftp-section h4 {
  margin: 0 0 8px 0; color: var(--vj-text); font-size: 11.5px;
  font-weight: 700; text-transform: uppercase; letter-spacing: 1px;
  display: flex; align-items: center; gap: 7px;
}
details.ftp-collapsible { margin-bottom: 0; padding: 12px 16px; border-bottom: 1px solid var(--vj-border-light); list-style: none; }
details.ftp-collapsible:last-child { border-bottom: none; }
details.ftp-collapsible[open] { padding-bottom: 12px; }
details.ftp-collapsible summary { cursor: pointer; padding: 4px 0; list-style: none; display: flex; align-items: center; gap: 4px; }
details.ftp-collapsible summary::-webkit-details-marker { display: none; }
details.ftp-collapsible summary::before { content: '\u25B6'; font-size: 8px; color: var(--vj-text-muted); transition: transform 0.15s; flex-shrink: 0; }
details.ftp-collapsible[open] summary::before { transform: rotate(90deg); }
details.ftp-collapsible summary h4 { margin: 0; cursor: pointer; font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 7px; color: var(--vj-text); }
.ftp-section-icon {
  width: 20px; height: 20px; border-radius: var(--vj-radius-xs);
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; flex-shrink: 0;
}
.ftp-section-icon.green { background: var(--vj-green-bg); color: var(--vj-green); }
.ftp-section-icon.blue { background: var(--vj-blue-bg); color: var(--vj-blue); }
.ftp-section-icon.amber { background: var(--vj-amber-bg); color: var(--vj-amber); }
.ftp-section-icon.red { background: var(--vj-red-bg); color: var(--vj-red); }
.ftp-section-icon.purple { background: var(--vj-purple-bg); color: var(--vj-purple); }
.ftp-section-icon.teal { background: var(--vj-teal-bg); color: var(--vj-teal); }
.ftp-section-icon.orange { background: var(--vj-orange-bg); color: var(--vj-orange); }

/* Buttons */
.ftp-button {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 7px 14px; border-radius: var(--vj-radius-sm);
  font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid transparent;
  transition: all var(--vj-transition); font-family: inherit; letter-spacing: 0.2px;
}
.ftp-button:active { transform: scale(0.97); }
.ftp-button:hover { transform: translateY(-1px); }
.ftp-button:focus-visible, #ftp-advisor-header button:focus-visible {
  outline: 2px solid var(--vj-gold); outline-offset: 1px;
}
.ftp-button-primary {
  background: linear-gradient(135deg, var(--vj-navy), var(--vj-navy-mid));
  color: #fff; border-color: rgba(255,255,255,0.1);
}
.ftp-button-primary:hover { box-shadow: 0 4px 12px rgba(15,23,41,0.3); }
.ftp-button-gold {
  background: linear-gradient(135deg, var(--vj-gold), var(--vj-gold-dim));
  color: #fff; font-weight: 700;
}
.ftp-button-gold:hover { box-shadow: 0 4px 12px rgba(200,169,81,0.4); }
.ftp-button-success {
  background: linear-gradient(135deg, var(--vj-green), #047857); color: #fff;
}
.ftp-button-success:hover { box-shadow: 0 4px 12px rgba(5,150,105,0.3); }

/* Tables */
table.ftp-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  font-size: 11px; border: 1px solid var(--vj-border); border-radius: var(--vj-radius-sm);
  overflow: hidden;
}
.ftp-table th {
  background: var(--vj-surface); padding: 8px 10px; text-align: left;
  font-weight: 700; color: var(--vj-text-secondary); border-bottom: 1px solid var(--vj-border);
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px;
}
.ftp-table td {
  padding: 7px 10px; border-bottom: 1px solid var(--vj-border-light);
  transition: background var(--vj-transition);
}
.ftp-table tr:last-child td { border-bottom: none; }
.ftp-table tr:hover td { background: var(--vj-card); }

/* Tactic pills */
.ftp-tactic-N, .ftp-tactic-D, .ftp-tactic-A {
  padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 700;
  letter-spacing: 0.3px; display: inline-block;
}
.ftp-tactic-N { background: var(--vj-blue-bg); color: var(--vj-blue); }
.ftp-tactic-D { background: var(--vj-amber-bg); color: var(--vj-amber); }
.ftp-tactic-A { background: var(--vj-red-bg); color: var(--vj-red); }

/* Stat badges */
.ftp-stat-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 10px; border-radius: 20px;
  font-size: 11px; font-weight: 600; border: 1px solid transparent;
}
.ftp-stat-badge.green { background: var(--vj-green-bg); color: var(--vj-green); border-color: var(--vj-green-border); }
.ftp-stat-badge.red { background: var(--vj-red-bg); color: var(--vj-red); border-color: var(--vj-red-border); }
.ftp-stat-badge.amber { background: var(--vj-amber-bg); color: var(--vj-amber); border-color: var(--vj-amber-border); }
.ftp-stat-badge.blue { background: var(--vj-blue-bg); color: var(--vj-blue); border-color: var(--vj-blue-border); }
.ftp-stat-badge.neutral { background: var(--vj-surface); color: var(--vj-text-secondary); border-color: var(--vj-border); }

/* Info boxes */
.ftp-info-box {
  background: var(--vj-card); border: 1px solid var(--vj-border);
  border-radius: var(--vj-radius-sm); padding: 12px 14px; margin: 6px 0;
  transition: all var(--vj-transition);
}
.ftp-info-box:hover { box-shadow: var(--vj-shadow); }
.ftp-info-box.warn { border-left: 3px solid var(--vj-amber); background: var(--vj-amber-bg); }
.ftp-info-box.danger { border-left: 3px solid var(--vj-red); background: var(--vj-red-bg); }
.ftp-info-box.success { border-left: 3px solid var(--vj-green); background: var(--vj-green-bg); }
.ftp-info-box .label { font-weight: 700; color: var(--vj-text-secondary); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px; }
.ftp-info-box .value { font-weight: 700; color: var(--vj-text); }

/* Recommendation cards */
.ftp-rec {
  background: var(--vj-card); border: 1px solid var(--vj-border);
  border-left: 3px solid var(--vj-blue); border-radius: var(--vj-radius-sm);
  padding: 9px 11px; margin: 5px 0; transition: all var(--vj-transition);
}
.ftp-rec:hover { box-shadow: var(--vj-shadow-md); transform: translateX(1px) translateY(-1px); border-left-width: 4px; }
.ftp-rec.critical { border-left-color: var(--vj-red); background: var(--vj-red-bg); border-color: var(--vj-red-border); }
.ftp-rec.high { border-left-color: var(--vj-amber); background: var(--vj-amber-bg); border-color: var(--vj-amber-border); }
.ftp-rec.medium { border-left-color: var(--vj-blue); background: var(--vj-blue-bg); border-color: var(--vj-blue-border); }
.ftp-rec.low { border-left-color: var(--vj-text-muted); background: var(--vj-surface); border-color: var(--vj-border); }
.ftp-rec-name { font-weight: 700; color: var(--vj-text); font-size: 13px; display: flex; align-items: center; gap: 6px; }
.ftp-rec-program { color: var(--vj-blue); font-weight: 700; font-size: 12px; }
.ftp-rec-reason { color: var(--vj-text-secondary); font-size: 11.5px; margin-top: 4px; line-height: 1.5; }
.ftp-rec-warnings { color: var(--vj-red); font-size: 10.5px; margin-top: 4px; line-height: 1.4; }
.ftp-rec-current { color: var(--vj-text-muted); font-size: 10.5px; }
.ftp-rec-gains { color: var(--vj-green); font-size: 10px; margin-top: 2px; font-style: italic; }

/* Stat rows */
.ftp-stat-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 3px 0; font-size: 11.5px; border-bottom: 1px solid var(--vj-border-light);
}
.ftp-stat-row:last-child { border-bottom: none; }
.ftp-stat-label { color: var(--vj-text-secondary); }
.ftp-stat-value { font-weight: 700; color: var(--vj-text); font-variant-numeric: tabular-nums; }

/* Progress bars */
.ftp-progress { height: 5px; background: var(--vj-border-light); border-radius: 10px; overflow: hidden; margin: 4px 0; }
.ftp-progress-fill { height: 100%; border-radius: 10px; transition: width 0.6s cubic-bezier(0.4,0,0.2,1); }
.ftp-progress-fill.green { background: linear-gradient(90deg, var(--vj-green), #34d399); }
.ftp-progress-fill.amber { background: linear-gradient(90deg, var(--vj-amber), #fbbf24); }
.ftp-progress-fill.red { background: linear-gradient(90deg, var(--vj-red), #f87171); }
.ftp-progress-fill.blue { background: linear-gradient(90deg, var(--vj-blue), #60a5fa); }

/* Player cards */
.ftp-player-card {
  background: var(--vj-card); border: 1px solid var(--vj-border);
  border-radius: var(--vj-radius-sm); padding: 10px 12px; margin: 5px 0;
  border-left: 3px solid var(--vj-border); transition: all var(--vj-transition);
  box-shadow: var(--vj-shadow-sm);
}
.ftp-player-card:hover { background: var(--vj-card); box-shadow: var(--vj-shadow); }
.ftp-player-card.bat { border-left-color: var(--vj-green); }
.ftp-player-card.bowl { border-left-color: var(--vj-blue); }
.ftp-player-card.allround { border-left-color: var(--vj-gold); }
.ftp-player-card.wk { border-left-color: var(--vj-orange); }
.ftp-player-name { font-weight: 700; font-size: 13px; color: var(--vj-text); display: flex; align-items: center; gap: 6px; }
.ftp-player-meta { font-size: 11px; color: var(--vj-text-secondary); margin-top: 3px; line-height: 1.4; }

/* Alerts */
.ftp-alert {
  padding: 10px 14px; border-radius: var(--vj-radius-sm); margin: 6px 0;
  font-size: 12px; line-height: 1.6; display: flex; gap: 8px; align-items: flex-start;
}
.ftp-alert.info { background: var(--vj-blue-bg); border: 1px solid var(--vj-blue-border); color: #1e40af; }
.ftp-alert.warning { background: var(--vj-amber-bg); border: 1px solid var(--vj-amber-border); color: #92400e; }
.ftp-alert.success { background: var(--vj-green-bg); border: 1px solid var(--vj-green-border); color: #065f46; }
.ftp-alert.danger { background: var(--vj-red-bg); border: 1px solid var(--vj-red-border); color: #991b1b; }

/* Divider / Footer */
.ftp-divider { border: none; border-top: 1px solid var(--vj-border-light); margin: 12px 0; }
#ftp-advisor-footer {
  padding: 10px 16px; border-top: 1px solid var(--vj-border);
  font-size: 10.5px; color: var(--vj-text-muted); text-align: center;
  background: var(--vj-surface); flex-shrink: 0; letter-spacing: 0.3px;
}

/* Utility */
.vj-flex { display: flex; align-items: center; }
.vj-flex-between { display: flex; align-items: center; justify-content: space-between; }
.vj-gap-4 { gap: 4px; } .vj-gap-6 { gap: 6px; } .vj-gap-8 { gap: 8px; }
.vj-mt-4 { margin-top: 4px; } .vj-mt-8 { margin-top: 8px; } .vj-mt-12 { margin-top: 12px; }
.vj-mb-4 { margin-bottom: 4px; } .vj-mb-8 { margin-bottom: 8px; }
.vj-text-xs { font-size: 10px; } .vj-text-sm { font-size: 11px; }
.vj-text-muted { color: var(--vj-text-muted); }
.vj-text-secondary { color: var(--vj-text-secondary); }
.vj-fw-600 { font-weight: 600; } .vj-fw-700 { font-weight: 700; }
.vj-mono { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; }
        `);
    }

    // ============================================================
    // GENERIC PANEL BUILDER
    // Creates the standard panel shell (header + scrollable content)
    // with consistent styling. Each page passes its title and
    // section definitions.
    // ============================================================
    function createPanel({ title, icon, sections, footer, buttons }) {
        let existing = document.getElementById('ftp-advisor-panel');
        if (existing) existing.remove();

        const panel = document.createElement('div');
        panel.id = 'ftp-advisor-panel';

        const collapseBtn = { id: 'ftp-toggle', label: '\u25BC', title: 'Collapse/Expand' };
        const allButtons = [...(buttons || []), collapseBtn];

        const headerBtns = allButtons.map(b =>
            `<button id="${b.id}" title="${b.title || ''}">${b.label}</button>`
        ).join('');

        let sectionsHtml = '';
        (sections || []).forEach(s => {
            if (s.collapsible) {
                sectionsHtml += `<details class="ftp-section ftp-collapsible" ${s.id ? `id="${s.id}-section"` : ''} ${s.collapsed === true ? '' : 'open'}>
                    <summary><h4>${s.icon ? `<span class="ftp-section-icon ${s.iconColor || 'blue'}">${s.icon}</span>` : ''}${s.label}</h4></summary>
                    <div id="${s.id}">${s.content || ''}</div>
                </details>`;
            } else {
                sectionsHtml += `<div class="ftp-section" ${s.id ? `id="${s.id}-section"` : ''}>
                    <h4>${s.icon ? `<span class="ftp-section-icon ${s.iconColor || 'blue'}">${s.icon}</span>` : ''}${s.label}</h4>
                    <div id="${s.id}">${s.content || ''}</div>
                </div>`;
            }
        });

        panel.innerHTML = `
            <div id="ftp-advisor-header">
                <h3>${icon || ''} ${title}</h3>
                <div style="display:flex;gap:4px;align-items:center;">
                    ${headerBtns}
                </div>
            </div>
            <div id="ftp-advisor-content">${sectionsHtml}</div>
            ${footer ? `<div id="ftp-advisor-footer">${footer}</div>` : ''}
        `;

        document.body.appendChild(panel);
        addCommonStyles();
        const header = panel.querySelector('#ftp-advisor-header');
        if (header) makeDraggable(panel, header);

        // Auto-attach collapse/expand toggle if button id "ftp-toggle" was declared
        const toggleBtn = panel.querySelector('#ftp-toggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const content = panel.querySelector('#ftp-advisor-content');
                const isHidden = content.style.display === 'none';
                content.style.display = isHidden ? 'block' : 'none';
                toggleBtn.textContent = isHidden ? '\u25BC' : '\u25B2';
            });
        }

        return panel;
    }

    // ============================================================
    // SQUAD PAGE UI
    // ============================================================
    function createSquadUI() {
        createPanel({
            title: 'Squad Advisor', icon: '\u{1F465}',
            buttons: [
                { id: 'ftp-refresh', label: '\u21BB', title: 'Refresh' }
            ],
            sections: [
                { id: 'ftp-squad-plan', label: 'Squad Plan \u2014 who to sell vs who to buy', icon: '\u{1F4E9}', iconColor: 'amber' },
                { id: 'ftp-squad-stats', label: 'Squad Overview', icon: '\u{1F4CA}', iconColor: 'green' }
            ]
        });
        document.getElementById('ftp-refresh').addEventListener('click', updateSquadAdvisor);
    }

    function updateSquadAdvisor() {
        const urlParams = new URLSearchParams(window.location.search);
        const teamId = urlParams.get('teamId');
        const isMyTeam = !teamId || teamId === String(TEAM_ID);

        const firstRow = document.querySelector('table#squad tbody tr');
        const skillCellCount = firstRow ? firstRow.querySelectorAll('td.skills').length : 0;
        const isLimitedView = skillCellCount < 3;

        let players;
        if (isLimitedView) {
            players = scrapeOpponentSquad();
        } else {
            players = scrapeSquad();
        }

        if (players.length === 0) {
            document.getElementById('ftp-squad-stats').innerHTML = '<div class="ftp-alert warning">No players found. Make sure the squad table is loaded.</div>';
            return;
        }

        if (isMyTeam) {
            savePlayerCache(players);
        } else {
            saveOpponentCache(teamId, players);
        }

        const seamers = players.filter(p => p.bowlerCategory === 'seam').length;
        const spinners = players.filter(p => p.bowlerCategory === 'spin').length;
        const leftHanded = players.filter(p => p.isLeftHanded).length;
        const fatigued = players.filter(p => p.fatigue < 6);
        const teamName = document.querySelector('h1 a')?.textContent.trim() || 'Team';

        let html = `<div class="ftp-info-box success">
            <div class="vj-flex-between vj-mb-4"><span class="vj-fw-700" style="font-size:14px;">${teamName}</span><span class="ftp-stat-badge green">${isMyTeam ? 'Cached' : 'Opponent Cached'}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Players</span><span class="ftp-stat-value">${players.length}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Seamers / Spinners</span><span class="ftp-stat-value">${seamers} / ${spinners}</span></div>
            ${leftHanded > 0 ? `<div class="ftp-stat-row"><span class="ftp-stat-label">Left-handed</span><span class="ftp-stat-value">${leftHanded}</span></div>` : ''}
        </div>`;

        if (fatigued.length > 0) {
            html += `<div class="ftp-alert danger" style="margin-top:6px;"><span>\u26A0</span> <div><strong>Fatigued:</strong> ${fatigued.map(p => `${p.name} (${skillLabel(p.fatigue).slice(0,3)})`).join(', ')}</div></div>`;
        }

        if (isLimitedView) {
            html += '<div class="vj-text-xs vj-text-muted vj-mt-8">Limited view: BT/Exp/Fatg/Form/Rating only (opponent squad)</div>';
        } else {
            html += '<div class="vj-text-xs vj-text-muted vj-mt-8">Full skill data cached for tactical analysis.</div>';
        }

        document.getElementById('ftp-squad-stats').innerHTML = html;

        // Keep/sell recommendations for own team — all shown inside the
        // Squad Plan now (which embeds the ranked sell lists), so there are
        // no separate sell collapsibles to maintain.
        if (isMyTeam && !isLimitedView) {
            // Use the full cached squad (seniors + youth) for the Squad Plan
            // so you see youth sell candidates even while on the senior squad
            // page (and vice versa). The current page scrape is the freshest
            // single half; merge it over what the cache has for every player,
            // keeping any cached players the page doesn't show. Falls back to
            // just the page scrape if nothing's cached.
            const cache = loadPlayerCache();
            let roster = players;
            if (cache && cache.players && cache.players.length > 0) {
                const byId = new Map();
                players.forEach(p => byId.set(p.id, p));
                cache.players.forEach(cp => {
                    if (byId.has(cp.id)) {
                        // Page data wins for overlapping players (fresher);
                        // keep the page object but fill missing detail from cache.
                        byId.get(cp.id).talents = byId.get(cp.id).talents || cp.talents || [];
                    } else {
                        byId.set(cp.id, cp);
                    }
                });
                roster = Array.from(byId.values());
            }
            const planEl = document.getElementById('ftp-squad-plan');
            if (planEl) planEl.innerHTML = buildSquadPlan(roster);
        }
    }

    // ============================================================
    // TRAINING PROGRAMS
    // ============================================================
    const TRAINING_PROGRAMS = {
        'batting':     { name: 'Batting',          primary: 'batting',    skills: ['batting', 'technique', 'endurance'] },
        'bowling':     { name: 'Bowling',          primary: 'bowling',    skills: ['bowling', 'technique', 'endurance'] },
        'keeping':     { name: 'Keeping',          primary: 'keeping',    skills: ['keeping', 'technique', 'fielding', 'endurance'] },
        'fielding':    { name: 'Fielding',         primary: 'fielding',   skills: ['fielding', 'technique', 'endurance'] },
        'fitness':     { name: 'Fitness',          primary: 'endurance',  skills: ['endurance', 'power'] },
        'allrounder':  { name: 'All-rounder',      primary: 'batting',    skills: ['batting', 'bowling', 'technique', 'endurance'] },
        'battingtech': { name: 'Batting technique', primary: 'technique', skills: ['technique', 'batting', 'endurance'] },
        'bowlingtech': { name: 'Bowling technique', primary: 'technique', skills: ['technique', 'bowling', 'endurance'] },
        'strength':    { name: 'Strength',          primary: 'power',      skills: ['power', 'endurance'] },
        'rest':        { name: 'Rest',              primary: null,         skills: [] },
        'keeperbatting': { name: 'Keeper-Batting',  primary: 'keeping',    skills: ['keeping', 'batting', 'technique', 'fielding', 'endurance'] }
    };

    const TRAINING_PROGRAM_LABELS = {
        'batting': 'Batting', 'bowling': 'Bowling', 'keeping': 'Keeping',
        'fielding': 'Fielding', 'fitness': 'Fitness', 'allrounder': 'All-rounder',
        'battingtech': 'Batting technique', 'bowlingtech': 'Bowling technique',
        'strength': 'Strength', 'rest': 'Rest', 'keeperbatting': 'Keeper-Batting'
    };

    // Reverse map from display name to key
    const TRAINING_LABEL_TO_KEY = {};
    for (const [k, v] of Object.entries(TRAINING_PROGRAM_LABELS)) {
        TRAINING_LABEL_TO_KEY[v.toLowerCase()] = k;
    }

    // ============================================================
    // TRAINING PAGE SCRAPER
    // ============================================================
    function scrapeTrainingPage() {
        const players = [];
        const rows = document.querySelectorAll('table tbody tr');
        console.log('[FTP Training] Found rows:', rows.length);

        // Training page has NO skill columns — must get skills from squad cache
        const cache = loadPlayerCache();
        const cachedMap = {};
        if (cache) {
            cache.players.forEach(p => { cachedMap[p.id] = p; });
            console.log('[FTP Training] Squad cache loaded:', Object.keys(cachedMap).length, 'players');
        } else {
            console.warn('[FTP Training] No squad cache found! Visit squad page first to load skill data.');
        }

        rows.forEach((row, idx) => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 5) return;

            const nameLink = row.querySelector('a.player') || row.querySelector('a[href*="player.htm"]');
            if (!nameLink) return;

            const playerId = nameLink.href.match(/playerId=(\d+)/)?.[1] || '';
            const name = escapeHtml(nameLink.textContent.trim());

            // Training page columns: Player | Age | Fatigue | Form | Rating | Training Program | Previous Week
            // No skill columns — skills MUST come from squad cache

            // Extract age from second cell (format "25.05" — weeks out of
            // 14, not a decimal fraction; see parseGameAge()).
            const ageText = cells[1]?.textContent.trim() || '';
            const age = ageText ? parseGameAge(ageText) : 99;

            // Extract fatigue from td.fatigue
            const fatigueCell = row.querySelector('td.fatigue');
            const fatigue = fatigueCell ? parseFatigue(fatigueCell.textContent) : 6;

            // Extract form from td.form
            const formCell = row.querySelector('td.form');
            const form = formCell ? parseSkill(formCell.textContent) : 5;

            // Extract training program from select dropdown
            const select = row.querySelector('select');
            let currentTraining = '';
            if (select) {
                const selectedOption = select.options[select.selectedIndex];
                currentTraining = selectedOption ? selectedOption.textContent.trim() : '';
            }

            // Get skills from squad cache (primary source — training page has no skills)
            const cached = cachedMap[playerId];
            let endurance = 0, batting = 0, bowling = 0, technique = 0, power = 0, keeping = 0, fielding = 0;
            let bowlerType = '', bowlerCategory = 'none', isLeftHanded = false;

            if (cached) {
                endurance = cached.endurance || 0;
                batting = cached.batting || 0;
                bowling = cached.bowling || 0;
                technique = cached.technique || 0;
                power = cached.power || 0;
                keeping = cached.keeping || 0;
                fielding = cached.fielding || 0;
                bowlerType = cached.bowlerType || '';
                bowlerCategory = cached.bowlerCategory || 'none';
                isLeftHanded = cached.isLeftHanded || false;
                console.log('[FTP Training] Cache hit:', name, 'Bat:', batting, 'Bowl:', bowling, 'Field:', fielding);
            } else {
                console.warn('[FTP Training] No cache for:', name, '(id:', playerId, ') — visit squad page to load skills');
            }

            // Detect talents from row text (popup/tooltip may contain talent info)
            const talents = [];
            const rowText = row.textContent;
            const talentWords = ['Gifted', 'Prodigy', 'Sturdy', 'Natural Leader', 'Accumulator', 'Finisher', 'Specialist', 'Swing', 'Yorker', 'Slower Ball'];
            talentWords.forEach(talent => {
                if (rowText.includes(talent)) talents.push(talent);
            });

            const player = {
                id: playerId,
                name: name,
                age: age,
                endurance: endurance,
                batting: batting,
                bowling: bowling,
                technique: technique,
                power: power,
                keeping: keeping,
                fielding: fielding,
                fatigue: fatigue,
                form: form,
                currentTraining: currentTraining,
                talents: talents,
                bowlerType: bowlerType,
                bowlerCategory: bowlerCategory,
                isLeftHanded: isLeftHanded,
                selectElement: select
            };
            players.push(player);
        });

        return players;
    }

    // ============================================================
    // TRAINING PROGRAM SKILL GAINS (what each program trains)
    // ============================================================
    const TRAINING_SKILL_GAINS = {
        'batting':     { skills: ['batting', 'technique', 'endurance'], gains: ['B: +primary batting', 'T: +secondary technique', 'E: +tertiary endurance'], bestFor: 'Batsmen, all-rounders with batting > bowling' },
        'bowling':     { skills: ['bowling', 'technique', 'endurance'], gains: ['B: +primary bowling', 'T: +secondary technique', 'E: +tertiary endurance'], bestFor: 'Designated bowlers, part-timers with bowling >= 5' },
        'keeping':     { skills: ['keeping', 'technique', 'fielding', 'endurance'], gains: ['K: +primary keeping', 'T: +secondary technique', 'F: +tertiary fielding', 'E: +quaternary endurance'], bestFor: 'Wicketkeepers' },
        'fielding':    { skills: ['fielding', 'technique', 'endurance'], gains: ['F: +primary fielding', 'T: +secondary technique', 'E: +tertiary endurance'], bestFor: 'Everyone early (cheap pops), before fielding hits Capable(6)' },
        'fitness':     { skills: ['endurance', 'power'], gains: ['E: +primary endurance', 'P: +secondary power'], bestFor: 'Players with low endurance (< 5), aging players' },
        'allrounder':  { skills: ['batting', 'bowling', 'technique', 'endurance'], gains: ['B: +batting (15% rate)', 'B: +bowling (15% rate)', 'T: +technique', 'E: +endurance'], bestFor: 'True all-rounders (batting & bowling within 2 levels)' },
        'battingtech': { skills: ['technique', 'batting', 'endurance'], gains: ['T: +primary technique', 'B: +secondary batting', 'E: +tertiary endurance'], bestFor: 'Batsmen with technique lagging behind batting' },
        'bowlingtech': { skills: ['technique', 'bowling', 'endurance'], gains: ['T: +primary technique', 'B: +secondary bowling', 'E: +tertiary endurance'], bestFor: 'Bowlers with technique lagging behind bowling' },
        'strength':    { skills: ['power', 'endurance'], gains: ['P: +primary power', 'E: +secondary endurance'], bestFor: 'Players age 24-27 (power training peaks mid-20s)' },
        'rest':        { skills: [], gains: ['Recover 1 fatigue level', 'No skill gain this week'], bestFor: 'Exhausted/shattered/clinically dead players (fatigue <= 2)' },
        'keeperbatting': { skills: ['keeping', 'batting', 'technique', 'fielding', 'endurance'], gains: ['K: +primary keeping', 'B: +secondary batting', 'T: +technique', 'F: +fielding', 'E: +endurance'], bestFor: 'Wicketkeeper-batsmen' }
    };

    // ============================================================
    // TRAINING BASE RATES — weekly skill-point gain (out of 1000
    // points = 1 full skill level), at Minimal Academy (ACADEMY_SPEED
    // index 0), 100% training, no talents — from the "Base Level
    // Training" table in the user's FTP_Training model
    // (Refs!I26:Q37). Cross-checked against that table's own per-row
    // SUM total column. Baseline age in the source is 19 for most
    // programs, 23-27 for Fitness/Strength (per its footnote) — not
    // separately corrected for here; folded into the age-multiplier
    // curve below like everything else.
    // estimateWeeklyTrainingGain() rescales these against
    // ACADEMY_SPEED[0] (minimal = 1.0x, the reference point these
    // base rates were measured at), so they combine correctly with
    // that multiplier instead of double-counting the academy effect.
    // ============================================================
    const TRAINING_BASE_RATES = {
        batting:       { endurance: 25, batting: 75, technique: 55 },
        bowling:       { endurance: 25, bowling: 75, technique: 55 },
        battingtech:   { endurance: 25, batting: 55, technique: 85 },
        bowlingtech:   { endurance: 25, bowling: 55, technique: 85 },
        allrounder:    { endurance: 25, batting: 53, bowling: 53, technique: 46 },
        keeping:       { endurance: 25, technique: 55, keeping: 160, fielding: 40 },
        keeperbatting: { endurance: 25, batting: 60, technique: 55, keeping: 80, fielding: 30 },
        fielding:      { endurance: 25, technique: 30, fielding: 220 },
        fitness:       { endurance: 65, power: 190 },
        strength:      { endurance: 200, power: 70 },
        rest:          {}
    };

    /**
     * Estimated weekly gain (points out of 1000/level) for a training
     * program, folding in every multiplier the script already tracks:
     * academy speed, age curve, a matching training talent, and skill
     * slowdown above Outstanding. Returns null for unknown programs.
     */
    function estimateWeeklyTrainingGain(programKey, player, academySpeed, opts) {
        const rates = TRAINING_BASE_RATES[programKey];
        if (!rates) return null;
        const ageMult = getAgeTrainingMultiplier(player.age);
        const academyRatio = academySpeed / ACADEMY_SPEED[0];
        const talents = player.talents || [];
        // Prodigy is explicitly youth-only per the official game manual
        // (rules.htm?rulespage=playerother): "Trains faster in all
        // skills while in the youth squad." Gifted (X) talents have no
        // such restriction stated — they apply at any age.
        const isProdigy = (player.age || 0) < 21 && talents.some(t => t.toLowerCase().includes('prodigy'));
        // Fatigue training penalty from official manual: moderate=15%,
        // weary=30%, listless=45%, exhausted=60%, shattered=75%,
        // clinically dead=90%. Satisfactory and below = 0%.
        const FATIGUE_TRAINING_PENALTY = { 5: 0.15, 4: 0.30, 3: 0.45, 2: 0.60, 1: 0.75, 0: 0.90 };
        const fatiguePenalty = (opts && opts.fatiguePenalty !== undefined) ? opts.fatiguePenalty :
            (FATIGUE_TRAINING_PENALTY[player.fatigue] || 0);
        // Squad overcrowding penalty: 7.5% per extra player beyond 25.
        // Formula: efficiency% = 100 - ((players - 25) × 7.5), then
        // convert to multiplier (e.g. 30 players → 62.5% → 0.625).
        const squadMult = (opts && opts.squadSizePenalty !== undefined) ? opts.squadSizePenalty : 1;
        const result = {};
        for (const [skill, basePoints] of Object.entries(rates)) {
            const ageM = skill === 'power' ? ageMult.power : skill === 'endurance' ? ageMult.endurance : ageMult.primary;
            const hasGiftedMatch = isProdigy || talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes(skill));
            const talentM = hasGiftedMatch ? (1 + TRAINING_TALENT_BONUS) : 1;
            const slowdownM = getSkillSlowdownMultiplier(player[skill] || 0);
            result[skill] = Math.round(basePoints * academyRatio * ageM * talentM * slowdownM * (1 - fatiguePenalty) * squadMult);
        }
        return result;
    }

    /**
     * Friendly "~N weeks to next level" from a weekly point gain. The
     * game doesn't expose sub-level precision, so this assumes the
     * player is starting from the very top of their current level
     * (needs the full 1000 points) — a conservative (slower-than-
     * average) estimate, not a best case.
     */
    function weeksToNextLevel(weeklyPoints) {
        if (!weeklyPoints || weeklyPoints <= 0) return null;
        return Math.ceil(1000 / weeklyPoints);
    }

    /**
     * Multi-week training planner. Re-derives the weekly gain every
     * week (not just once) because skill-slowdown depends on the
     * player's CURRENT level, which can cross a threshold mid-
     * simulation — the same dynamic the spreadsheet's week-by-week
     * table captures, computed here from the verified per-week formula
     * instead of the workbook's own precomputed cell grid (that grid
     * — DB!$DB$6:$GL$15 — was not extracted; see CLAUDE.md). Starts
     * each skill at the TOP of the player's current level (0 progress),
     * same conservative assumption as weeksToNextLevel().
     * Returns { finalSkills, finalProgress, levelUps, weeks }, or null
     * for an unknown/rest program.
     */
    /**
     * Project a youth player's skills forward to age 20 using the
     * training simulation engine. Returns { projected, verdict } where
     * projected has the skill levels at age 20 and verdict is an
     * assessment of whether they'll reach useful levels.
     */
    function projectYouthToAge20(player, academySpeed) {
        const currentAge = player.age || 16;
        if (currentAge >= 20) return null; // already at final youth year
        const weeks = weeksToAge20(currentAge);
        // Use the adaptive training plan to project — it re-runs the
        // recommendation engine each week, which is the most accurate
        // simulation we have.
        const plan = simulateAdaptiveTrainingPlan(player, weeks, academySpeed, null);
        if (!plan) return null;
        const projected = plan.finalSkills;
        const primaryInfo = getPrimarySkillInfo(projected);
        const primaryAt20 = primaryInfo.value;
        return { projected, verdict: classifyProjectedPrimary(primaryAt20), weeksToAge20: weeks, primaryAt20 };
    }

    /**
     * "12wk outlook: Reasonable → Capable (wk8), 34% into Capable" —
     * turns a simulateTrainingPlan() result for one skill into one
     * short line for a rec card.
     */
    function formatTrainingOutlook(projection, primarySkill, currentValue) {
        if (!projection || !primarySkill) return '';
        const startLabel = skillLabel(Math.round(currentValue || 0));
        const endLevel = projection.finalSkills[primarySkill];
        const endLabel = skillLabel(endLevel);
        const progressPct = Math.round(((projection.finalProgress[primarySkill] || 0) / 1000) * 100);
        if (startLabel === endLabel) {
            return `${projection.weeks}wk outlook: stays ${endLabel} (${progressPct}% to next level)`;
        }
        const arrivals = projection.levelUps.filter(l => l.skill === primarySkill);
        const arrivalWeek = arrivals.length ? arrivals[arrivals.length - 1].week : null;
        return `${projection.weeks}wk outlook: ${startLabel} → ${endLabel}${arrivalWeek ? ` (wk${arrivalWeek})` : ''}, ${progressPct}% into ${endLabel}`;
    }

    function simulateTrainingPlan(player, programKey, weeks, academySpeed) {
        const rates = TRAINING_BASE_RATES[programKey];
        if (!rates) return null;
        const state = {};
        for (const skill of Object.keys(rates)) {
            state[skill] = { level: Math.min(15, Math.round(player[skill] || 0)), progress: 0 };
        }
        const levelUps = [];
        for (let week = 1; week <= weeks; week++) {
            const simPlayer = Object.assign({}, player);
            for (const skill of Object.keys(state)) simPlayer[skill] = state[skill].level;
            // Age must advance during the simulation — a multi-year
            // horizon (e.g. 16 -> 20) should see the age-training
            // multiplier decline over time (Refs' Age/Primary/Power/
            // Endur. curve), not stay frozen at the player's age today.
            // 14 weeks per age-year, not 52 — confirmed by the official
            // manual ("players age weekly, becoming one year older every
            // fourteen weeks") and matches the workbook's own Player-tab
            // layout (Wk0-Wk14 per age column). Using 52 here understated
            // aging by ~3.7x in every previous version of this simulation.
            simPlayer.age = player.age + (week - 1) / 14;
            // Week 1 uses real fatigue penalty; week 2+ assumes healthy
            // baseline (fatigue=8, no penalty) since we don't have a
            // match schedule to drive realistic fatigue dynamics.
            const weekFatiguePenalty = week === 1 ? undefined : 0;
            const gains = estimateWeeklyTrainingGain(programKey, simPlayer, academySpeed,
                weekFatiguePenalty !== undefined ? { fatiguePenalty: weekFatiguePenalty } : undefined);
            for (const skill of Object.keys(state)) {
                if (state[skill].level >= 15) continue; // Legendary — capped
                state[skill].progress += (gains && gains[skill]) || 0;
                while (state[skill].progress >= 1000 && state[skill].level < 15) {
                    state[skill].progress -= 1000;
                    state[skill].level += 1;
                    levelUps.push({ week, skill, newLevel: state[skill].level });
                }
            }
        }
        const finalSkills = {};
        const finalProgress = {};
        for (const skill of Object.keys(state)) {
            finalSkills[skill] = state[skill].level;
            finalProgress[skill] = state[skill].progress;
        }
        return { finalSkills, finalProgress, levelUps, weeks };
    }

    // Skills tracked across the whole adaptive plan (every skill any
    // training program can touch), independent of which program is
    // active in a given week.
    const ADAPTIVE_PLAN_SKILLS = ['endurance', 'batting', 'bowling', 'technique', 'power', 'keeping', 'fielding'];

    /**
     * Multi-week plan that actually switches training programs over
     * time, the way a real player would — re-runs the SAME staged
     * recommendation logic (recommendTraining(), which already decides
     * "fielding first if < Capable, then primary skill, etc.") fresh
     * every simulated week against the player's then-current simulated
     * skills, rather than locking in one program for the whole horizon
     * (see simulateTrainingPlan() for that simpler version). Age and
     * academy speed/talent/skill-slowdown multipliers all apply exactly
     * as they do for a real recommendation, every week.
     *
     * Fatigue is NOT dynamically modelled (no match simulation to drive
     * it) — week 1 uses the player's real current fatigue so "right
     * now" advice is accurate, but week 2+ assumes a healthy baseline
     * (8/10, "energetic") so a currently-tired snapshot doesn't lock a
     * multi-year development plan into permanent Rest. This is a
     * deliberate simplification, not an oversight — document it in any
     * UI that shows this plan's output.
     *
     * Returns { finalSkills, finalProgress, levelUps, timeline, weeklyPrograms, weeks }
     * where timeline is [{ program, fromWeek, toWeek }] (compressed
     * program-switch history) and weeklyPrograms is a 1-indexed array
     * (weeklyPrograms[1] = week 1's program) for a genuine week-by-week
     * breakdown, e.g. the Player Advisor's training table.
     */
    // Academy speed at a given simulated week of a multi-week projection.
    // The current scraped efficiency is TODAY's value; a long plan (e.g.
    // a 16yo projected to 25) spans several real years in which the
    // academy gets upgraded, so the player trains faster in later weeks
    // than earlier ones — that's what makes a better academy tomorrow
    // raise a player's projected rating. Linear ramp from the current
    // speed toward the max academy speed (Deluxe, level 10) over
    // ACADEMY_RAMP_YEARS real years (14-week years — the 14-not-52 rule)
    // from the plan's start. weeksElapsed = 0 ⇒ exactly today's speed:
    // the plan never invents a retroactive upgrade. ACADEMY_RAMP_YEARS
    // = 0 (or an unknown speed) disables the ramp entirely.
    function academySpeedAtWeek(academySpeed, weeksElapsed) {
        if (!(ACADEMY_RAMP_YEARS > 0) || !isFinite(academySpeed) || academySpeed <= 0) return academySpeed;
        const maxSpeed = ACADEMY_SPEED[ACADEMY_SPEED.length - 1];
        const t = Math.min(1, weeksElapsed / (ACADEMY_RAMP_YEARS * 14));
        return academySpeed + (maxSpeed - academySpeed) * t;
    }

    function simulateAdaptiveTrainingPlan(player, weeks, academySpeed, squadContext) {
        const state = {};
        ADAPTIVE_PLAN_SKILLS.forEach(skill => {
            state[skill] = { level: Math.min(15, Math.round(player[skill] || 0)), progress: 0 };
        });
        // Squad size penalty — constant across all simulated weeks since
        // we don't model squad composition changes during the plan.
        const ss = squadContext?.size || 0;
        const squadMult = squadPenaltyMultiplier(ss);

        const levelUps = [];
        const timeline = [];
        const weeklyPrograms = [null];
        let currentProgram = null;
        let programStartWeek = 1;

        for (let week = 1; week <= weeks; week++) {
            const simPlayer = Object.assign({}, player);
            ADAPTIVE_PLAN_SKILLS.forEach(skill => { simPlayer[skill] = state[skill].level; });
            // 14 weeks per age-year (see simulateTrainingPlan) — not 52.
            simPlayer.age = player.age + (week - 1) / 14;
            simPlayer.fatigue = week === 1 ? player.fatigue : 8;

            // Only rec.program is used here — the 12-week projection
            // recommendTraining() would otherwise compute is discarded
            // immediately, so skip it (see opts.skipProjection).
            const rec = recommendTraining(simPlayer, squadContext, { skipProjection: true });
            const program = rec.program;
            weeklyPrograms.push(program);

            if (program !== currentProgram) {
                if (currentProgram !== null) timeline.push({ program: currentProgram, fromWeek: programStartWeek, toWeek: week - 1 });
                currentProgram = program;
                programStartWeek = week;
            }

            if (program === 'rest') continue; // no skill gain this week
            const gainOpts = squadMult < 1 ? { squadSizePenalty: squadMult } : undefined;
            // Academy improves over the horizon — later weeks train at a
            // higher speed than earlier ones (see academySpeedAtWeek).
            const gains = estimateWeeklyTrainingGain(program, simPlayer, academySpeedAtWeek(academySpeed, week - 1), gainOpts);
            if (!gains) continue;
            Object.keys(gains).forEach(skill => {
                if (!state[skill] || state[skill].level >= 15) return;
                state[skill].progress += gains[skill] || 0;
                while (state[skill].progress >= 1000 && state[skill].level < 15) {
                    state[skill].progress -= 1000;
                    state[skill].level += 1;
                    levelUps.push({ week, skill, newLevel: state[skill].level });
                }
            });
        }
        if (currentProgram !== null) timeline.push({ program: currentProgram, fromWeek: programStartWeek, toWeek: weeks });

        const finalSkills = {}, finalProgress = {};
        ADAPTIVE_PLAN_SKILLS.forEach(skill => {
            finalSkills[skill] = state[skill].level;
            finalProgress[skill] = state[skill].progress;
        });
        return { finalSkills, finalProgress, levelUps, timeline, weeklyPrograms, weeks };
    }

    // ============================================================
    // TRAINING RECOMMENDATION ENGINE
    // ============================================================

    // Helper: detect player role + talent flags (shared by all paths)
    function _detectPlayerContext(player) {
        // Routed through the same getPrimarySkillInfo() every other
        // role-detection site in this file uses, rather than an
        // independent ad hoc comparison that merely happened to agree
        // with it (both used a keeping>=4 threshold) — this is the exact
        // kind of near-duplicate logic that has silently drifted apart
        // elsewhere in this file before (see evaluateYouthRecruit's fix,
        // same session). This function drives ALL training
        // recommendations (senior/aging/youth staging), so keeping it on
        // the one canonical implementation matters more here than most.
        const primaryInfo = getPrimarySkillInfo(player);
        const isBatsman = primaryInfo.name === 'batting';
        const isBowler = primaryInfo.name === 'bowling';
        const isKeeper = primaryInfo.name === 'keeping';
        const isAllrounder = !isKeeper && Math.abs(player.batting - player.bowling) <= 2 && player.batting >= 4 && player.bowling >= 4;
        const isWristSpinner = player.bowlerType === 'rws' || player.bowlerType === 'lws';
        const isProdigy = player.talents.some(t => t.toLowerCase().includes('prodigy'));
        const hasGiftedBatting = player.talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes('batting'));
        const hasGiftedBowling = player.talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes('bowling'));
        const hasGiftedTechnique = player.talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes('technique'));
        const hasGiftedFielding = player.talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes('fielding'));
        return { isBatsman, isBowler, isKeeper, isAllrounder, isWristSpinner, isProdigy,
                 hasGiftedBatting, hasGiftedBowling, hasGiftedTechnique, hasGiftedFielding };
    }

    // Youth training path (age < 21)
    function _recommendYouthTraining(rec, player, ctx) {
        const { academySpeed, setProgram } = ctx;
        const { isBowler, isKeeper, isAllrounder, isWristSpinner, hasGiftedBatting, hasGiftedBowling, hasGiftedTechnique, hasGiftedFielding, isProdigy } = ctx;

        // Fielding target: Reliable (7) normally, but Capable (6) if Gifted
        // (Fielding) — it pops faster as a secondary during other training.
        const fieldingTarget = hasGiftedFielding ? 6 : 7;
        if (player.fielding < fieldingTarget) {
            const targetLabel = fieldingTarget === 6 ? 'Capable' : 'Reliable';
            setProgram('fielding', `Youth: Fielding is ${skillLabel(player.fielding)}. Get fielding to ${targetLabel} first — early pops are cheap and fast.${hasGiftedFielding ? ' Gifted (Fielding) means it trains faster as a secondary, so Capable is enough.' : ''} Improves run-saving, catching, and runout opportunities. Academy speed: ${Math.round(academySpeed * 100)}%.`, 'high');
            return;
        }

        const ydEval = evaluateYouthDevelopment(player);
        if (ydEval && ydEval.overallStatus === 'behind') {
            const behindRow = ydEval.rows.find(r => r.status === 'behind');
            if (behindRow) {
                const skillKey = behindRow.label.includes('Primary') ? (isBowler ? 'bowling' : isKeeper ? 'keeping' : 'batting')
                    : behindRow.label.includes('Technique') ? 'technique'
                    : behindRow.label.includes('Fielding') ? 'fielding'
                    : behindRow.label.includes('Endurance') ? 'fitness' : null;
                if (skillKey) {
                    const progMap = { batting: 'batting', bowling: 'bowling', keeping: 'keeperbatting',
                        technique: isBowler ? 'bowlingtech' : 'battingtech', fielding: 'fielding', fitness: 'fitness' };
                    const skillLabelClean = behindRow.label.replace(/\s*\(.*\)/, '');
                    setProgram(progMap[skillKey] || 'batting',
                        `Youth development curve: ${skillLabelClean} is ${skillLabel(behindRow.value)} — behind the age-${player.age} target of ${skillLabel(behindRow.min)}. Training this skill now to keep pace with the development curve.`, 'high');
                    return;
                }
            }
        }

        const primarySkill = isBowler ? player.bowling : isKeeper ? player.keeping : player.batting;

        // Technique-to-Reliable is its own mandatory stage, not just a
        // catch-up when it lags the primary skill — same real-world feedback
        // as the fielding target above: build technique to Reliable BEFORE
        // pouring development into bowling/batting, not only when it's
        // already fallen behind. Keeper-Batting already trains technique
        // alongside keeping so it's excluded here.
        // EXCEPTION: Gifted (Technique) players — technique pops faster as a
        // secondary during fielding/bowling training, so skip the dedicated
        // technique stage and go straight to primary.
        if (!isKeeper && player.technique < 7 && !hasGiftedTechnique) {
            if (isBowler) {
                setProgram('bowlingtech', `Fielding is at target — now build technique (${skillLabel(player.technique)}) to Reliable before bowling. High bowling + low technique = takes wickets but bowls poor deliveries; this order avoids that.`, 'high');
            } else {
                setProgram('battingtech', `Fielding is at target — now build technique (${skillLabel(player.technique)}) to Reliable before batting. High batting + low technique = inconsistent batting; this order avoids that.`, 'high');
            }
            return;
        }

        if (isAllrounder && player.batting >= 4 && player.bowling >= 4) {
            setProgram('allrounder', `Youth all-rounder: Batting (${skillLabel(player.batting)}) and bowling (${skillLabel(player.bowling)}) are close. AR training develops both equally.${isProdigy ? ' PRODIGY: all skills train faster — maximise breadth while in youth.' : ''}`, 'high');
        } else if (isProdigy && player.age < 19 && !isKeeper) {
            // Prodigy youth benefit from breadth — all skills train faster,
            // so AR training in early youth builds a wider base before
            // specialising. Only recommend if both bat/bowl are ≥3 (not
            // completely lopsided).
            if (player.batting >= 3 && player.bowling >= 3) {
                setProgram('allrounder', `Youth PRODIGY: All skills train faster. AR training builds breadth — batting (${skillLabel(player.batting)}) and bowling (${skillLabel(player.bowling)}) both benefit. Specialise after 18.`, 'high');
            } else {
                // One discipline is too weak for AR — train the stronger one
                const prog = player.batting >= player.bowling ? 'batting' : 'bowling';
                setProgram(prog, `Youth PRODIGY: One discipline too weak for AR. Train ${prog} (${skillLabel(player[prog])}) while prodigy bonus is active.`, 'high');
            }
        } else if (isKeeper) {
            setProgram('keeperbatting', `Youth keeper: Keeping (${skillLabel(player.keeping)}) is primary. Keeper-Batting trains keeping, batting, technique, and fielding together.`, 'high');
        } else if (isBowler) {
            if (player.bowling < 4 && player.batting > player.bowling) {
                setProgram('batting', `Bowling (${skillLabel(player.bowling)}) is below Average. Batting (${skillLabel(player.batting)}) is stronger. Train batting as primary.`, 'high');
            } else {
                let bowlReason = `Youth bowler: Bowling (${skillLabel(player.bowling)}) is primary. Bowl training develops bowling, technique, and endurance.`;
                if (isWristSpinner) bowlReason += ' Wrist spinners are particularly valuable on Crumbling/Dry pitches.';
                setProgram('bowling', bowlReason, 'high');
            }
        } else {
            setProgram('batting', `Youth batsman: Batting (${skillLabel(player.batting)}) is primary. Bat training develops batting, technique, and endurance. Build a strong foundation early.`, 'high');
        }

        if (hasGiftedBatting && rec.program !== 'batting') rec.warnings.push(`Has Gifted (Batting) talent — trains batting faster. Consider Batting.`);
        if (hasGiftedBowling && rec.program !== 'bowling') rec.warnings.push(`Has Gifted (Bowling) talent — trains bowling faster. Consider Bowling.`);
        if (hasGiftedTechnique) rec.warnings.push(`Has Gifted (Technique) talent — Bat/Bowl tech programs will be extra effective.`);
        if (isProdigy) rec.warnings.push(`Has PRODIGY talent — trains ALL skills faster while in youth squad. Maximize development window!`);
        if (player.endurance < 4 && rec.program !== 'fitness') rec.warnings.push(`Endurance is ${skillLabel(player.endurance)} — low endurance means less starting energy. Consider Fitness.`);
    }

    // Senior training path (age 21-29)
    function _recommendSeniorTraining(rec, player, ctx) {
        const { age, setProgram } = ctx;
        const { isBowler, isKeeper, isAllrounder } = ctx;
        const primarySkill = isBowler ? player.bowling : isKeeper ? player.keeping : player.batting;

        if (player.fielding < 7) {
            setProgram('fielding', `Senior: Fielding is ${skillLabel(player.fielding)}. Push to Reliable before age slows training. Wiki: fielding to Reliable/Capable first is best ROI.`, 'medium');
            return;
        }

        // Experienced-player training schedule (real community input, same
        // source as the v8.7 youth staging order): 1) fielding to Reliable
        // in youth (done above), 2) primary/tech to ~21, 3) a SECOND
        // fielding stage to Spectacular (11) or Exceptional (12) — the
        // higher tier for batsmen, medium bowlers and finger spinners (they
        // field most, so run-saving pops count for more), pace/wrist bowlers
        // get 11, 4) primary/tech to ~25, 5) Strength and Endurance each to
        // Exceptional by ~29, then free choice. Gated on the primary skill
        // being at least Reliable so a late-blooming weak primary isn't
        // starved while fielding climbs.
        const isPaceOrWrist = ['rf', 'lf', 'rfm', 'lfm', 'rws', 'lws'].includes(player.bowlerType || '');
        const fieldingTier = isPaceOrWrist ? 11 : 12;
        if (player.fielding < fieldingTier && primarySkill >= 7) {
            setProgram('fielding', `Age ${age}: Fielding second stage — ${skillLabel(player.fielding)} → ${skillLabel(fieldingTier)}. ${isPaceOrWrist ? 'Spectacular is the target for pace/wrist bowlers.' : 'Exceptional — batsmen, medium bowlers and finger spinners field most.'} Community schedule: primary to ~21, fielding to ${skillLabel(fieldingTier)}, primary to ~25, then strength/endurance.`, 'medium');
            return;
        }

        // Community-sourced staging order (real experienced-user input,
        // not workbook-verified): fielding trains fastest so most players
        // get it to their target level as early as possible (the youth
        // fielding-to-Reliable staging and the second fielding stage above
        // already handle that), then primary skill/technique is the focus
        // through the mid-20s, THEN Strength and Fitness starting around 25
        // running until power AND endurance each hit Exceptional (12) — the
        // community schedule expects that to land around 28-29, just before
        // the aging path below switches to maintenance-only at 30. Actual
        // pace depends heavily on academy training speed, which this doesn't
        // otherwise adjust for — a slow academy may need to start earlier.
        if (age >= 25 && age <= 29 && (player.power < 12 || player.endurance < 12)) {
            if (player.power >= 12) {
                setProgram('fitness', `Age ${age}: Endurance phase — power is done (${skillLabel(player.power)}), endurance is ${skillLabel(player.endurance)}. Community schedule: Strength and Endurance each to Exceptional by ~29. Fitness trains endurance (and power as secondary).`, 'medium');
            } else {
                setProgram('strength', `Age ${age}: Strength/Endurance phase — community schedule: both to Exceptional by ~29. Strength trains power (${skillLabel(player.power)}) and endurance (${skillLabel(player.endurance)}) together. Actual pace depends on your academy speed.`, 'medium');
            }
            return;
        }

        if (isAllrounder) {
            setProgram('allrounder', `Senior all-rounder: Batting (${skillLabel(player.batting)}) and bowling (${skillLabel(player.bowling)}) are balanced.`, 'medium');
        } else if (isKeeper) {
            setProgram('keeperbatting', `Senior keeper: Keeping (${skillLabel(player.keeping)}) is primary. Keeper-Batting develops keeping, batting, technique, and fielding.`, 'medium');
        } else if (isBowler) {
            setProgram('bowling', `Senior bowler: Bowling (${skillLabel(player.bowling)}) is primary. Continue developing bowling skill and technique.`, 'medium');
        } else {
            setProgram('batting', `Senior batsman: Batting (${skillLabel(player.batting)}) is primary. Continue developing batting skill and technique.`, 'medium');
        }

        if (player.technique < primarySkill - 2) {
            rec.warnings.push(`Technique (${skillLabel(player.technique)}) is significantly behind primary skill (${skillLabel(primarySkill)}). Consider Bat/Bowl technique training.`);
        }
    }

    // Aging player path (age 30+)
    function _recommendAgingTraining(rec, player, ctx) {
        const { age, setProgram } = ctx;
        const { isBowler, isKeeper } = ctx;

        if (player.endurance < 5) {
            setProgram('fitness', `Age ${age}: Endurance (${skillLabel(player.endurance)}) is declining. Fitness maintains endurance and power.`, 'medium');
            return;
        }
        if (player.power < 5) {
            setProgram('strength', `Age ${age}: Power (${skillLabel(player.power)}) is declining. Strength maintains power and endurance.`, 'low');
            return;
        }
        if (isBowler) {
            setProgram('bowling', `Age ${age}: Maintain bowling skill. Training can slow decline but not stop it.`, 'low');
        } else if (isKeeper) {
            setProgram('keeping', `Age ${age}: Maintain keeping skill. Training can slow decline but not stop it.`, 'low');
        } else {
            setProgram('batting', `Age ${age}: Maintain batting skill. Training can slow decline but not stop it.`, 'low');
        }
    }

    // opts.skipProjection — omit the 12-week outlook simulation at the
    // end. That projection exists purely to render the "📅 12wk outlook"
    // line on the Training page; when this function is called from
    // INSIDE a simulation loop (simulateAdaptiveTrainingPlan re-runs it
    // once per simulated week) the projection is computed and thrown
    // away immediately. Measured: a 16yo transfer candidate ran 784
    // weekly-gain calculations, of which ~92% came from these discarded
    // inner projections (56 simulated weeks x a 12-week throwaway sim
    // each). Across 20 youth rows that was ~15,700 calculations,
    // synchronously, while building an innerHTML string.
    function recommendTraining(player, squadContext, opts) {
        const rec = { program: 'batting', reason: '', priority: 'medium', warnings: [], skillGains: [] };

        const FATIGUE_TRAINING_PENALTY = { 5: 15, 4: 30, 3: 45, 2: 60, 1: 75, 0: 90 };
        const academyInfo = squadContext?.academyInfo || null;
        const academySpeed = getAcademySpeedForPlayer(player, academyInfo);

        // 1. REST if exhausted/shattered/clinically dead
        if (player.fatigue <= 2) {
            const penalty = FATIGUE_TRAINING_PENALTY[player.fatigue] || 90;
            rec.program = 'rest';
            rec.reason = `Fatigue is ${SKILL_LABELS[player.fatigue] || player.fatigue} (${player.fatigue}/10). Rest to recover 1 fatigue level. Training at this fatigue level has a ${penalty}% penalty — almost no progress.`;
            rec.priority = 'critical';
            rec.skillGains = TRAINING_SKILL_GAINS['rest'].gains;
            return rec;
        }

        // 2. Common warnings
        if (player.fatigue <= 5) {
            const penalty = FATIGUE_TRAINING_PENALTY[player.fatigue] || 0;
            rec.warnings.push(`Fatigue is ${player.fatigue}/10. Training penalty: ${penalty}%.${player.fatigue <= 4 ? ' Consider Rest if match is imminent.' : ''}`);
        }
        if (academyInfo && academyInfo.levelNum <= 1) {
            rec.warnings.push(`Academy level is ${academyInfo.level} — training is only ${Math.round(academySpeed * 100)}% speed.`);
        }
        const squadSize = squadContext?.size || 0;
        if (squadSize > 25) {
            rec.warnings.push(`Squad has ${squadSize} players (>${MAX_EFFICIENT_SQUAD} limit). Training penalty: ${squadPenaltyPct(squadSize).toFixed(1)}%.`);
        }
        const ageMult = getAgeTrainingMultiplier(player.age);
        if (ageMult.primary <= 0.5) {
            rec.warnings.push(`Age ${player.age}: primary-skill training at ~${Math.round(ageMult.primary * 100)}% of a youth's rate. Prioritise the skills you still need most.`);
        }
        ['batting', 'bowling', 'keeping', 'fielding'].forEach(skill => {
            const val = player[skill];
            if (val > SKILL_SLOWDOWN_THRESHOLD) {
                const mult = getSkillSlowdownMultiplier(val);
                rec.warnings.push(`${skillLabel(val)} ${skill} — above Outstanding, trains ~${Math.round(mult * 100)}% base rate. Diminishing returns.`);
            }
        });
        const giftedNames = player.talents.filter(t => t.toLowerCase().includes('gifted'))
            .map(t => t.replace(/gifted/i, '').replace(/[()]/g, '').trim()).filter(Boolean);
        if (giftedNames.length) {
            rec.warnings.push(`Gifted talent grants +${Math.round(TRAINING_TALENT_BONUS * 100)}% speed on: ${giftedNames.join(', ')}.`);
        }

        // 3. Build shared context and delegate to age path
        const pd = _detectPlayerContext(player);
        const setProgram = (key, reason, priority) => {
            rec.program = key; rec.reason = reason; rec.priority = priority;
            const g = TRAINING_SKILL_GAINS[key]; if (g) rec.skillGains = g.gains;
        };
        const ctx = { age: player.age, academySpeed, setProgram, ...pd };

        if (player.age < 21) _recommendYouthTraining(rec, player, ctx);
        else if (player.age < 30) _recommendSeniorTraining(rec, player, ctx);
        else _recommendAgingTraining(rec, player, ctx);

        // Estimated weekly point gain + weeks-to-next-level, from the
        // FTP_Training model's base rates combined with the multipliers
        // already computed above (academy/age/talent/slowdown/fatigue/squad).
        if (rec.program !== 'rest') {
            // Fatigue penalty: already handled by estimateWeeklyTrainingGain's
            // default (reads player.fatigue). Squad size penalty: compute from
            // squadContext.size and pass explicitly since the function has no
            // access to squadContext.
            const ss = squadContext?.size || 0;
            const squadMult = squadPenaltyMultiplier(ss);
            const gainOpts = squadMult < 1 ? { squadSizePenalty: squadMult } : undefined;
            rec.weeklyGain = estimateWeeklyTrainingGain(rec.program, player, academySpeed, gainOpts);
            const programDef = TRAINING_PROGRAMS[rec.program];
            if (rec.weeklyGain && programDef && programDef.primary) {
                rec.primarySkill = programDef.primary;
                rec.weeksToNextLevel = weeksToNextLevel(rec.weeklyGain[programDef.primary]);
                // 12-week outlook: keeps training this program and shows
                // where the primary skill actually lands, not just the
                // next single level-up. UI-only — skipped when called
                // from inside a simulation loop (see opts.skipProjection).
                if (!opts || !opts.skipProjection) {
                    rec.projection = simulateTrainingPlan(player, rec.program, 12, academySpeed);
                }
            }
        }

        return rec;
    }

    // ============================================================
    // TRAINING UI
    // ============================================================
    function createTrainingUI() {
        createPanel({
            title: 'Training Advisor', icon: '\u{1F3CB}',
            buttons: [],
            sections: [
                { id: 'ftp-academy-info', label: 'Academy & Finances', icon: '\u{1F3EB}', iconColor: 'green',
                  content: '<div class="vj-text-sm vj-text-muted">Loading academy & finance data...</div>' },
                { id: 'ftp-training-stats', label: 'Squad Analysis', icon: '\u{1F4CA}', iconColor: 'blue' },
                { id: 'ftp-youth-curve', label: 'Youth Development Curve', icon: '\u{1F331}', iconColor: 'teal' },
                { id: 'ftp-training-recs', label: 'Recommendations', icon: '\u2B50', iconColor: 'amber' },
                { id: 'ftp-academy-rec', label: 'Academy Upgrade', icon: '\u2B06', iconColor: 'purple' },
                { id: 'ftp-training-actions', label: '', icon: '',
                  content: '<div style="text-align:center;padding:4px 0;"><button id="ftp-apply-training" class="ftp-button ftp-button-success" style="margin-right:4px;">Apply All</button><button id="ftp-refresh" class="ftp-button ftp-button-primary">\u21BB Refresh</button></div>' }
            ]
        });

        document.getElementById('ftp-refresh').addEventListener('click', updateTrainingAdvisor);
        document.getElementById('ftp-apply-training').addEventListener('click', () => {
            if (window._ftpTrainingRecs && window._ftpTrainingRecs.length > 0) {
                if (confirm(`Apply ${window._ftpTrainingRecs.length} training recommendations?`)) {
                    applyTrainingRecommendations(window._ftpTrainingRecs);
                }
            } else { alert('No recommendations to apply. Run the advisor first.'); }
        });
    }

    // Renders the age-16-20 development curve check for every youth
    // player. Behind-curve stats are called out in red so it's obvious
    // at a glance which players need which skill prioritised.
    function displayYouthDevelopment(youthPlayers) {
        const container = document.getElementById('ftp-youth-curve');
        if (!container) return;

        const tracked = youthPlayers
            .map(p => ({ player: p, evalResult: evaluateYouthDevelopment(p) }))
            .filter(x => x.evalResult);

        if (tracked.length === 0) {
            container.innerHTML = '<div class="vj-text-sm vj-text-muted">No youth players aged 16-20 to check against the development curve.</div>';
            return;
        }

        tracked.sort((a, b) => {
            if (a.evalResult.overallStatus !== b.evalResult.overallStatus) {
                return a.evalResult.overallStatus === 'behind' ? -1 : 1;
            }
            return a.evalResult.age - b.evalResult.age;
        });

        let html = '';
        tracked.forEach(({ player, evalResult }) => {
            const isBehind = evalResult.overallStatus === 'behind';
            const statusBadge = isBehind ? '<span class="ftp-stat-badge red">Behind</span>' : '<span class="ftp-stat-badge green">On Track</span>';
            html += `<div class="ftp-rec ${isBehind ? 'critical' : 'low'}">
                <div class="vj-flex-between"><span class="ftp-rec-name">${player.name} <span class="vj-text-xs vj-text-muted">(age ${evalResult.age})</span></span>${statusBadge}</div>
                <table class="ftp-table" style="margin-top:6px;">`;
            evalResult.rows.forEach(r => {
                const color = r.status === 'behind' ? 'var(--vj-red)' : (r.status === 'ahead' ? 'var(--vj-green)' : 'var(--vj-text-secondary)');
                const targetLabel = skillLabel(r.min) + (r.good ? `\u2013${skillLabel(r.good)}` : '+');
                html += `<tr>
                    <td style="font-weight:600;">${r.label}</td>
                    <td style="color:${color};font-weight:700;">${skillLabel(r.value)}</td>
                    <td class="vj-text-xs vj-text-muted">target: ${targetLabel}</td>
                </tr>`;
            });
            html += `</table></div>`;
        });
        container.innerHTML = html;
    }

    async function updateTrainingAdvisor() {
        const players = scrapeTrainingPage();
        console.log('[FTP Training] Scraped players:', players.length);

        if (players.length === 0) {
            document.getElementById('ftp-training-stats').innerHTML = '<div class="ftp-alert warning">No players found. Make sure the training table is loaded.</div>';
            document.getElementById('ftp-training-recs').innerHTML = '';
            document.getElementById('ftp-academy-rec').innerHTML = '';
            return;
        }

        const hasSkills = players.some(p => p.batting > 0 || p.bowling > 0 || p.fielding > 0);
        if (!hasSkills) {
            document.getElementById('ftp-training-stats').innerHTML = `
                <div class="ftp-alert danger">
                    <div><strong>No skill data available!</strong><div class="vj-text-xs vj-mt-4">The training page does NOT show player skills. You must visit the <a href="seniors.htm?squadViewId=2&teamId=${TEAM_ID}" style="color:var(--vj-blue);">Senior Squad</a> or <a href="youths.htm?teamId=${TEAM_ID}" style="color:var(--vj-blue);">Youth Squad</a> page FIRST to cache skill data.</div></div>
                </div>`;
            document.getElementById('ftp-training-recs').innerHTML = '';
            document.getElementById('ftp-academy-rec').innerHTML = '';
            return;
        }

        const academyInfo = loadAcademyCache();
        const financeInfo = loadFinanceCache();
        displayAcademyInfo(academyInfo, financeInfo);
        displayYouthDevelopment(players.filter(p => p.age <= YOUTH_MAX_AGE));

        const academyRec = recommendAcademyAction(academyInfo, financeInfo, {
            seniorCount: players.filter(p => p.age >= 21).length,
            youthCount: players.filter(p => p.age < 21).length
        });
        displayAcademyRecommendation(academyRec);

        const squadContext = { size: players.length, hasUpcomingMatch: false, academyInfo, financeInfo };
        const recommendations = [];
        players.forEach(player => {
            const rec = recommendTraining(player, squadContext);
            rec.player = player;
            recommendations.push(rec);
        });
        window._ftpTrainingRecs = recommendations;

        const avgAge = players.reduce((s, p) => s + p.age, 0) / players.length;
        const avgFatigue = players.reduce((s, p) => s + p.fatigue, 0) / players.length;
        const fatigued = players.filter(p => p.fatigue <= 4);
        const youth = players.filter(p => p.age < 21);
        const aging = players.filter(p => p.age >= 30);
        const efficiency = Math.max(0, 100 - squadPenaltyPct(players.length));
        // Squad-wide summary badge — uses the game's own live overall
        // efficiency (avg of Senior/Youth Training Efficiency %, already
        // scraped in parseAcademyDoc) rather than the derived ACADEMY_SPEED
        // curve, since this squad has a real mix of ages the single
        // level-based estimate can't represent as accurately.
        const academySpeed = academyInfo ? (academyInfo.trainingEfficiency != null ? academyInfo.trainingEfficiency / 100 : (ACADEMY_SPEED[academyInfo.levelNum] || 1.00)) : 1.00;
        const academyLevel = academyInfo ? academyInfo.level : 'unknown';

        const squadCache = loadPlayerCache();
        const cacheAgeHours = squadCache ? squadCache.ageHours : null;
        const playersWithSkills = players.filter(p => (p.batting || 0) > 0 || (p.bowling || 0) > 0 || (p.fielding || 0) > 0).length;
        const conf = computeConfidence({
            cacheAgeHours,
            playersWithSkills,
            totalPlayers: players.length,
            hasAcademyInfo: !!academyInfo,
            hasFinanceInfo: !!financeInfo,
            hasOpponentData: false,
            matchTypeKnown: false,
        });

        let statsHtml = `
            <div class="vj-flex vj-gap-6 vj-mb-8" style="flex-wrap:wrap;">
                <span class="ftp-stat-badge blue">Squad: ${players.length}</span>
                <span class="ftp-stat-badge ${efficiency < 100 ? 'red' : 'green'}">${efficiency.toFixed(0)}%</span>
                <span class="ftp-stat-badge purple">${academyLevel} (${Math.round(academySpeed * 100)}%)</span>
                ${renderConfidenceBadge(conf)}
            </div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Average age</span><span class="ftp-stat-value">${avgAge.toFixed(1)}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Youth (&lt;21)</span><span class="ftp-stat-value">${youth.length}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Aging (30+)</span><span class="ftp-stat-value">${aging.length}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Avg fatigue</span><span class="ftp-stat-value">${avgFatigue.toFixed(1)}/10</span></div>
            ${fatigued.length > 0 ? `<div class="ftp-alert danger" style="margin-top:4px;"><span>\u26A0</span><div>Fatigued: ${fatigued.map(p => p.name).join(', ')}</div></div>` : ''}
            ${(() => {
                // Injury risk: players at Shattered(1)/Exhausted(2) are at
                // high risk — recommend Rest proactively. Listless(3) gets
                // a milder warning.
                const highRisk = players.filter(p => p.fatigue <= 2);
                const moderateRisk = players.filter(p => p.fatigue === 3);
                if (highRisk.length > 0) {
                    return `<div class="ftp-alert danger" style="margin-top:4px;"><span>\ud83d\udea8</span><div>Injury risk: ${highRisk.map(p => `${p.name} (${SKILL_LABELS[p.fatigue]})`).join(', ')} — REST recommended, training gains severely penalised.</div></div>`;
                } else if (moderateRisk.length > 0) {
                    return `<div class="ftp-alert warning" style="margin-top:4px;"><span>\u26A0</span><div>Fatigue building: ${moderateRisk.map(p => `${p.name} (${SKILL_LABELS[p.fatigue]})`).join(', ')} — 45% training penalty. Consider Rest.</div></div>`;
                }
                return '';
            })()}
            ${players.length > MAX_EFFICIENT_SQUAD ? `<div class="ftp-alert warning" style="margin-top:4px;"><span>\u26A0</span><div>Squad has ${players.length} players (&gt;${MAX_EFFICIENT_SQUAD} limit). Training penalty: ${squadPenaltyPct(players.length).toFixed(1)}%.</div></div>` : ''}
        `;
        document.getElementById('ftp-training-stats').innerHTML = statsHtml;

        // Recommendations — compact cards
        let recsHtml = '';
        recommendations.forEach(rec => {
            const p = rec.player;
            const currentProg = p.currentTraining || 'Unknown';
            const isAlreadyCorrect = TRAINING_LABEL_TO_KEY[currentProg.toLowerCase()] === rec.program;
            const gains = TRAINING_SKILL_GAINS[rec.program];
            const priorityIcon = rec.priority === 'critical' ? '\u{1F534}' : rec.priority === 'high' ? '\u{1F7E0}' : rec.priority === 'medium' ? '\u{1F535}' : '\u26AA';

            recsHtml += `<div class="ftp-rec ${rec.priority}">
                <div class="vj-flex-between"><span class="ftp-rec-name">${priorityIcon} ${p.name} <span class="vj-text-xs vj-text-muted">(${formatAgeDisplay(p.age)})</span></span><span class="vj-text-xs ${isAlreadyCorrect ? 'vj-text-muted' : ''}">${isAlreadyCorrect ? '\u2705' : '\u27A1'}</span></div>
                <div class="ftp-rec-current">Now: ${currentProg} \u00B7 Bat ${skillLabel(p.batting).slice(0,3)} \u00B7 Bowl ${skillLabel(p.bowling).slice(0,3)} \u00B7 Tech ${skillLabel(p.technique).slice(0,3)} \u00B7 Field ${skillLabel(p.fielding).slice(0,3)} \u00B7 End ${skillLabel(p.endurance).slice(0,3)}${p.keeping > 0 ? ` \u00B7 Keep ${skillLabel(p.keeping).slice(0,3)}` : ''}</div>
                <div class="ftp-rec-program">\u2192 ${TRAINING_PROGRAM_LABELS[rec.program] || rec.program}${rec.weeksToNextLevel ? ` <span class="vj-text-xs vj-text-muted">(~${rec.weeksToNextLevel}wk to next level)</span>` : ''}</div>
                ${gains ? `<div class="ftp-rec-gains">${gains.gains.join(' | ')}</div>` : ''}
                ${rec.projection && rec.primarySkill ? `<div class="ftp-rec-gains" style="color:var(--vj-blue);">\ud83d\udcc5 ${formatTrainingOutlook(rec.projection, rec.primarySkill, p[rec.primarySkill])}</div>` : ''}
                <div class="ftp-rec-reason">${rec.reason}</div>
                ${rec.warnings.length > 0 ? `<div class="ftp-rec-warnings">\u26A0 ${rec.warnings.join(' \u00B7 ')}</div>` : ''}
            </div>`;
        });
        document.getElementById('ftp-training-recs').innerHTML = recsHtml;

        // ── Upcoming match context (background fetch) ───────────
        fetchUpcomingFixtures().then(upcoming => {
            if (upcoming.length === 0) return;
            const next = upcoming[0];
            const daysUntil = Math.ceil((next.matchDate - new Date()) / (1000 * 60 * 60 * 24));
            const isT20 = next.format === 'T20' || next.format === 'YT20';
            const isShort = isT20 || next.format === 'YOD';

            // Training guidance based on upcoming match
            let matchNote = '';
            if (daysUntil <= 3) {
                matchNote = `<div class="ftp-alert info" style="margin-top:8px;"><span>\u{1F4C5}</span><div><strong>Next match in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}:</strong> ${next.teams} (${next.matchClass})<br>` +
                    `<span class="vj-text-xs">Tip: ${isT20 ? 'T20 focus — bowling fitness & death-overs batting' : isShort ? 'Short format — bowling economy is key' : 'OD — full fitness matters, longer bowling spells'}.</span></div></div>`;
            } else if (daysUntil <= 7) {
                matchNote = `<div class="ftp-alert info" style="margin-top:8px;"><span>\u{1F4C5}</span><div><strong>Next match in ${daysUntil} days:</strong> ${next.teams} (${next.matchClass})<br>` +
                    `<span class="vj-text-xs">Tip: ${isT20 ? 'T20 coming up — prioritise power batting & short bowling spells' : 'OD coming up — balance endurance with match fitness'}.</span></div></div>`;
            } else {
                matchNote = `<div class="ftp-alert info" style="margin-top:8px;"><span>\u{1F4C5}</span><div><strong>Next match in ${daysUntil} days:</strong> ${next.teams} (${next.matchClass})</div></div>`;
            }

            // Match-week rest recommendations: when a match is within 3
            // days, recommend Rest for fatigued starters (Listless or
            // worse) — the game penalises fatigued players with lower
            // starting energy, which matters more than one extra training
            // session before a match.
            if (daysUntil <= 3) {
                const severeFatigue = players.filter(p => p.fatigue <= 3);
                const moderateFatigue = players.filter(p => p.fatigue === 4);
                if (severeFatigue.length > 0) {
                    matchNote += `<div class="ftp-alert danger" style="margin-top:4px;"><span>\u{1F6A8}</span><div><strong>REST recommended before the match:</strong><div class="vj-text-xs vj-mt-4">` +
                        severeFatigue.map(p => `${p.name} (${SKILL_LABELS[p.fatigue]} — fatigue ${p.fatigue}/10)`).join(', ') +
                        `<br>These players will start the match with reduced energy if they train this week. Consider giving them Rest.</div></div></div>`;
                }
                if (moderateFatigue.length > 0 && severeFatigue.length === 0) {
                    matchNote += `<div class="ftp-alert warning" style="margin-top:4px;"><span>\u26A0</span><div>` +
                        `Fatigued starters: ${moderateFatigue.map(p => `${p.name} (${SKILL_LABELS[p.fatigue]})`).join(', ')} — consider Rest if match fitness is priority.</div></div>`;
                }
            } else if (daysUntil <= 7) {
                const severeFatigue = players.filter(p => p.fatigue <= 2);
                if (severeFatigue.length > 0) {
                    matchNote += `<div class="ftp-alert warning" style="margin-top:4px;"><span>\u26A0</span><div>` +
                        `Match in ${daysUntil} days: ${severeFatigue.map(p => `${p.name} (${SKILL_LABELS[p.fatigue]})`).join(', ')} are very fatigued — schedule Rest this week to recover in time.</div></div>`;
                }
            }

            // Show remaining upcoming fixtures too
            if (upcoming.length > 1) {
                matchNote += '<div class="vj-text-xs vj-text-muted" style="margin-top:4px;">Also upcoming: ' +
                    upcoming.slice(1).map(m => `${m.teams} (${m.format})`).join(' \u00B7 ') + '</div>';
            }

            const recsContainer = document.getElementById('ftp-training-recs');
            if (recsContainer) {
                recsContainer.insertAdjacentHTML('afterbegin', matchNote);
            }
        });
    }

    function displayAcademyInfo(academyInfo, financeInfo) {
        const container = document.getElementById('ftp-academy-info');
        if (!academyInfo && !financeInfo) {
            container.innerHTML = '<div class="vj-text-sm vj-text-muted">Could not load academy/finance data.</div>';
            return;
        }

        const levelColors = ['#d32f2f','#e64a19','#f57c00','#fbc02d','#c0ca33','#689f38','#43a047','#2e7d32','#1b5e20','#0d3b0d','#002200'];
        const level = academyInfo ? academyInfo.levelNum : 0;
        const levelName = academyInfo ? academyInfo.level : 'unknown';
        const levelLabel = ACADEMY_LEVELS[level] ? ACADEMY_LEVELS[level].label : levelName;
        const color = levelColors[level] || '#666';
        const speed = academyInfo ? (ACADEMY_SPEED[level] || 1.00) : 1.00;
        const boxClass = level <= 2 ? 'danger' : level <= 4 ? 'warn' : 'success';

        let html = '';
        if (academyInfo) {
            html += `<div class="ftp-info-box ${boxClass}">
                <div class="vj-flex-between"><span class="label">Academy</span><span class="ftp-stat-badge ${level <= 2 ? 'red' : level <= 4 ? 'amber' : 'green'}">${levelLabel.toUpperCase()} (${level}/10)</span></div>
                <div class="ftp-stat-row vj-mt-4"><span class="ftp-stat-label">Training speed</span><span class="ftp-stat-value">${Math.round(speed * 100)}%</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Weekly cost</span><span class="ftp-stat-value">$${(academyInfo.weeklyCost || 0).toLocaleString()}</span></div>
            </div>`;
        }

        if (financeInfo) {
            const finColor = (financeInfo.weeklyNet || 0) >= 0 ? 'var(--vj-green)' : 'var(--vj-red)';
            html += `<div class="ftp-info-box" style="border-left:3px solid var(--vj-blue);">
                <div class="ftp-stat-row"><span class="ftp-stat-label">Funds</span><span class="ftp-stat-value">$${(financeInfo.availableFunds || 0).toLocaleString()}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Weekly net</span><span class="ftp-stat-value" style="color:${finColor};">$${(financeInfo.weeklyNet || 0).toLocaleString()}/wk</span></div>
                ${financeInfo.seniorWages > 0 ? `<div class="ftp-stat-row"><span class="ftp-stat-label">Senior wages</span><span class="ftp-stat-value">$${financeInfo.seniorWages.toLocaleString()}</span></div>` : ''}
                ${financeInfo.youthWages > 0 ? `<div class="ftp-stat-row"><span class="ftp-stat-label">Youth wages</span><span class="ftp-stat-value">$${financeInfo.youthWages.toLocaleString()}</span></div>` : ''}
            </div>`;
        }

        container.innerHTML = html;
    }

    function displayAcademyRecommendation(academyRec) {
        const container = document.getElementById('ftp-academy-rec');
        if (!academyRec || academyRec.action === 'maintain') {
            container.innerHTML = `<div class="vj-text-sm vj-text-muted">${academyRec ? academyRec.reason : 'No recommendation.'}</div>`;
            return;
        }

        const actionColors = { upgrade: 'success', downgrade: 'critical', save: 'high', maintain: 'low' };
        const actionIcons = { upgrade: '\u2B06', downgrade: '\u2B07', save: '\u{1F4B0}', maintain: '\u2705' };
        const recClass = actionColors[academyRec.action] || 'low';
        const icon = actionIcons[academyRec.action] || '';

        let html = `<div class="ftp-rec ${recClass}">
            <div class="vj-flex-between"><span class="vj-fw-700">${icon} ${academyRec.action.toUpperCase()}</span></div>
            <div class="ftp-rec-reason">${academyRec.reason}</div>`;

        if (academyRec.action === 'upgrade' && academyRec.upgradeCost > 0) {
            html += `<div class="vj-text-xs vj-text-muted vj-mt-4">One-off: $${academyRec.upgradeCost.toLocaleString()} \u00B7 Weekly +$${academyRec.weeklyIncrease.toLocaleString()} \u00B7 ${academyRec.canAfford ? '\u2705 Can afford' : '\u274C Cannot afford'}</div>`;
        }

        if (academyRec.benefits.length > 0) {
            html += `<div class="vj-text-xs vj-text-secondary vj-mt-4">${academyRec.benefits.map(b => `<div>\u2022 ${b}</div>`).join('')}</div>`;
        }

        html += '</div>';
        container.innerHTML = html;
    }

    // ============================================================
    // ACADEMY PAGE ADVISOR UI
    // ============================================================
    function createAcademyAdvisorUI() {
        createPanel({
            title: 'Academy Advisor', icon: '\u{1F3EB}',
            buttons: [
                { id: 'ftp-refresh', label: '\u21BB', title: 'Refresh' }
            ],
            sections: [
                { id: 'ftp-academy-detail', label: 'Academy Overview', icon: '\u{1F3AF}', iconColor: 'green' },
                { id: 'ftp-academy-finance', label: 'Finance', icon: '\u{1F4B0}', iconColor: 'blue' },
                { id: 'ftp-academy-rec', label: 'Recommendation', icon: '\u2B50', iconColor: 'amber' },
                { id: 'ftp-academy-levels', label: 'Level Comparison', icon: '\u{1F4CA}', iconColor: 'purple' },
                { id: 'ftp-data-status', label: 'Data Freshness', icon: '\u{1F4BE}', iconColor: 'teal' }
            ]
        });
    }

    async function updateAcademyAdvisor() {
        const academyInfo = loadAcademyCache();
        const financeInfo = loadFinanceCache();

        if (!academyInfo || academyInfo.level === 'unknown') {
            document.getElementById('ftp-academy-detail').innerHTML = '<div class="ftp-alert danger">No academy data. Visit this page again after data loads.</div>';
        } else {
            const level = academyInfo.levelNum;
            const speed = ACADEMY_SPEED[level] || 1.00;
            const nextLevel = level < 10 ? ACADEMY_LEVELS[level + 1] : null;
            const prevLevel = level > 0 ? ACADEMY_LEVELS[level - 1] : null;
            const boxClass = level <= 2 ? 'danger' : level <= 4 ? 'warn' : 'success';

            let detailHtml = `<div class="ftp-info-box ${boxClass}">
                <div class="vj-flex-between vj-mb-4"><span class="label">Current Level</span><span class="ftp-stat-badge ${level <= 2 ? 'red' : level <= 4 ? 'amber' : 'green'}">${ACADEMY_LEVELS[level].label.toUpperCase()} (${level}/10)</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Weekly maintenance</span><span class="ftp-stat-value">$${academyInfo.weeklyCost.toLocaleString()}/wk</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Training speed</span><span class="ftp-stat-value">${Math.round(speed * 100)}% of baseline</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Efficiency</span><span class="ftp-stat-value">Senior ${academyInfo.seniorEfficiency}% \u00B7 Youth ${academyInfo.youthEfficiency}%</span></div>
                <div class="vj-text-xs vj-text-muted vj-mt-4">
                    Upgrade: ${nextLevel ? '$' + (ACADEMY_LEVELS[level].cost * 2.5).toLocaleString() : 'N/A (max)'} \u00B7 Downgrade refund: ${prevLevel ? '$' + Math.round(ACADEMY_LEVELS[level].cost * 1.25).toLocaleString() : 'N/A (min)'}
                </div>
            </div>`;
            document.getElementById('ftp-academy-detail').innerHTML = detailHtml;

            let levelsHtml = '<table class="ftp-table"><thead><tr><th>Lvl</th><th>Name</th><th>Weekly</th><th>Speed</th><th>Upgrade</th></tr></thead><tbody>';
            for (const lvl of ACADEMY_LEVELS) {
                const isCurrent = lvl.num === level;
                const upgradeCost = lvl.num < 10 ? '$' + (ACADEMY_LEVELS[lvl.num].cost * 2.5).toLocaleString() : '---';
                levelsHtml += `<tr style="${isCurrent ? 'background:var(--vj-green-bg);font-weight:700;' : ''}">
                    <td>${lvl.num}</td>
                    <td>${lvl.label}</td>
                    <td>$${lvl.cost.toLocaleString()}</td>
                    <td>${Math.round((ACADEMY_SPEED[lvl.num] || 1.00) * 100)}%</td>
                    <td>${upgradeCost}</td>
                </tr>`;
            }
            levelsHtml += '</tbody></table>';
            document.getElementById('ftp-academy-levels').innerHTML = levelsHtml;
        }

        if (financeInfo) {
            const finColor = (financeInfo.weeklyNet || 0) >= 0 ? 'var(--vj-green)' : 'var(--vj-red)';
            document.getElementById('ftp-academy-finance').innerHTML = `<div class="ftp-info-box" style="border-left:3px solid var(--vj-blue);">
                <div class="ftp-stat-row"><span class="ftp-stat-label">Funds</span><span class="ftp-stat-value">$${(financeInfo.availableFunds || 0).toLocaleString()}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Weekly net</span><span class="ftp-stat-value" style="color:${finColor};">$${(financeInfo.weeklyNet || 0).toLocaleString()}/wk</span></div>
                ${financeInfo.seniorWages > 0 ? `<div class="ftp-stat-row"><span class="ftp-stat-label">Senior wages</span><span class="ftp-stat-value">$${financeInfo.seniorWages.toLocaleString()}</span></div>` : ''}
                ${financeInfo.youthWages > 0 ? `<div class="ftp-stat-row"><span class="ftp-stat-label">Youth wages</span><span class="ftp-stat-value">$${financeInfo.youthWages.toLocaleString()}</span></div>` : ''}
                ${financeInfo.groundMaintenance > 0 ? `<div class="ftp-stat-row"><span class="ftp-stat-label">Ground maint.</span><span class="ftp-stat-value">$${financeInfo.groundMaintenance.toLocaleString()}</span></div>` : ''}
            </div>`;
        } else {
            document.getElementById('ftp-academy-finance').innerHTML = '<div class="vj-text-sm vj-text-muted">Finance data not loaded. Visit Club \u2192 Finances first.</div>';
        }

        const squadContext = { seniorCount: academyInfo ? (academyInfo.seniorCount || 0) : 0, youthCount: academyInfo ? (academyInfo.youthCount || 0) : 0 };
        const academyRec = recommendAcademyAction(academyInfo, financeInfo, squadContext);
        displayAcademyRecommendation(academyRec);

        const statusEl = document.getElementById('ftp-data-status');
        if (statusEl) {
            const academyAge = getDataAgeText(ACADEMY_TIMESTAMP_KEY);
            const financeAge = getDataAgeText(FINANCE_TIMESTAMP_KEY);
            statusEl.innerHTML = `<div class="ftp-stat-row"><span class="ftp-stat-label">Academy</span><span class="vj-text-xs vj-text-muted">${academyAge}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Finance</span><span class="vj-text-xs vj-text-muted">${financeAge}</span></div>`;
        }
    }

    // ============================================================
    // YOUTH RECRUIT EVALUATION
    // ============================================================
    function evaluateYouthRecruit(player, context) {
        // Returns: { verdict, verdictColor, score, breakdown, recommendedTraining, warnings }
        // Verdict: 'elite', 'strong', 'promising', 'average', 'weak', 'release'
        const result = {
            verdict: 'average',
            verdictColor: '#f57c00',
            score: 0,
            breakdown: [],
            recommendedTraining: 'batting',
            warnings: [],
            talentBonus: 0,
            roleFit: ''
        };

        if (!player) return result;

        const age = player.age || 16;
        const batting = player.batting || 0;
        const bowling = player.bowling || 0;
        const keeping = player.keeping || 0;
        const technique = player.technique || 0;
        const power = player.power || 0;
        const endurance = player.endurance || 0;
        const fielding = player.fielding || 0;
        const talents = player.talents || [];

        // --- SCORING ---
        // Primary skill (what they're best at) — routed through the same
        // getPrimarySkillInfo() every other role-detection site in this
        // file uses (transfer scouting, sell lists, tactics, Dynasty
        // Score). This function used to compute its own independent
        // Math.max(batting, bowling, keeping) + a keeper threshold of 3
        // (vs getPrimarySkillInfo's 4) — the exact class of duplicate-
        // logic drift that has caused real reported bugs elsewhere in
        // this file before (a genuine keeper judged on bat/bowl instead
        // of keeping, a 0/0 no-data player misclassified as a bowler).
        // One canonical implementation now, not a second near-copy.
        const primaryInfo = getPrimarySkillInfo(player);
        const primarySkill = primaryInfo.value;
        const primaryName = primaryInfo.name;

        // Talent bonuses (from wiki: Gifted trains faster, Skilled matches better, Prodigy trains all faster)
        let talentScore = 0;
        const hasGiftedBatting = talents.some(t => /gifted.*bat/i.test(t));
        const hasGiftedBowling = talents.some(t => /gifted.*bowl/i.test(t));
        const hasGiftedKeeping = talents.some(t => /gifted.*keep/i.test(t));
        const hasGiftedTechnique = talents.some(t => /gifted.*tech/i.test(t));
        const hasGiftedEndurance = talents.some(t => /gifted.*endur/i.test(t));
        const hasGiftedFielding = talents.some(t => /gifted.*field/i.test(t));
        const hasGiftedPower = talents.some(t => /gifted.*power/i.test(t));
        const isProdigy = talents.some(t => /prodigy/i.test(t));
        const isSturdy = talents.some(t => /sturdy/i.test(t));
        const hasSkilledBatting = talents.some(t => /skilled.*bat/i.test(t));
        const hasSkilledBowling = talents.some(t => /skilled.*bowl/i.test(t));

        if (isProdigy) talentScore += 3;
        if (hasGiftedBatting && primaryName === 'batting') talentScore += 2;
        if (hasGiftedBowling && primaryName === 'bowling') talentScore += 2;
        if (hasGiftedKeeping && primaryName === 'keeping') talentScore += 2;
        if (hasGiftedTechnique) talentScore += 1;
        if (hasGiftedEndurance) talentScore += 1;
        if (hasGiftedFielding) talentScore += 1;
        if (hasGiftedPower) talentScore += 1;
        if (isSturdy) talentScore += 0.5;
        if (hasSkilledBatting && primaryName === 'batting') talentScore += 1.5;
        if (hasSkilledBowling && primaryName === 'bowling') talentScore += 1.5;

        result.talentBonus = talentScore;

        // Age bonus (younger = more training time = better)
        // 16 = best (5 years of youth training), 20 = worst (promoted immediately)
        const ageBonus = Math.max(0, (20 - age) * 0.5);

        // Skill scores (0-15 scale)
        const skillScore = (primarySkill * 3 + technique * 2 + endurance * 1 + fielding * 0.5 + power * 0.5) / 6.5;

        // Total score
        result.score = Math.round((skillScore + talentScore + ageBonus) * 10) / 10;

        // --- ROLE DETECTION --- derived from the same primaryName above,
        // not a second independent comparison (see the comment on
        // primaryInfo). isAllrounder is a genuinely distinct concept
        // (close bat/bowl regardless of which one primaryName lands on)
        // so it stays its own check.
        const isKeeper = primaryName === 'keeping';
        const isBowler = primaryName === 'bowling';
        const isBatsman = primaryName === 'batting';
        const isAllrounder = !isKeeper && Math.abs(batting - bowling) <= 2 && batting >= 3 && bowling >= 3;

        if (isProdigy) result.roleFit = 'All (Prodigy trains all faster)';
        else if (isKeeper) result.roleFit = 'Wicketkeeper-Batsman';
        else if (isAllrounder) result.roleFit = 'All-rounder';
        else if (isBowler) result.roleFit = 'Bowler';
        else result.roleFit = 'Batsman';

        // --- BREAKDOWN ---
        result.breakdown.push(`Primary: ${primaryName} ${skillLabel(primarySkill)} (${primarySkill}/15)`);
        result.breakdown.push(`Technique: ${skillLabel(technique)} (${technique}/15)`);
        result.breakdown.push(`Endurance: ${skillLabel(endurance)} (${endurance}/15)`);
        result.breakdown.push(`Fielding: ${skillLabel(fielding)} (${fielding}/15)`);
        result.breakdown.push(`Power: ${skillLabel(power)} (${power}/15)`);
        result.breakdown.push(`Age: ${age} (${age < 18 ? 'young - lots of training time' : age < 20 ? 'decent training window' : 'promoted soon'})`);
        if (talents.length > 0) {
            result.breakdown.push(`Talents: ${talents.join(', ')} (+${talentScore} talent bonus)`);
        }

        // --- TRAINING RECOMMENDATION ---
        // Based on community advice: fielding to Capable(6) first, then primary skill
        if (fielding < 6) {
            result.recommendedTraining = 'fielding';
        } else if (isProdigy || (batting >= 4 && bowling >= 4 && Math.abs(batting - bowling) <= 2)) {
            result.recommendedTraining = 'allrounder';
        } else if (isKeeper) {
            result.recommendedTraining = 'keeperbatting';
        } else if (isBowler) {
            if (technique < primarySkill - 1) {
                result.recommendedTraining = 'bowlingtech';
            } else {
                result.recommendedTraining = 'bowling';
            }
        } else {
            if (technique < primarySkill - 1) {
                result.recommendedTraining = 'battingtech';
            } else {
                result.recommendedTraining = 'batting';
            }
        }

        // --- WARNINGS ---
        if (endurance < 3) {
            result.warnings.push('Very low endurance — will tire quickly in matches');
        }
        if (technique < 2 && primarySkill > 3) {
            result.warnings.push('Low technique relative to primary skill — inconsistent performances');
        }
        if (talents.length === 0) {
            result.warnings.push('No talents — will develop slower than talented peers');
        }
        if (isProdigy) {
            result.warnings.push('PRODIGY — trains all skills faster while in youth squad. Maximize this!');
        }

        // --- REAL-WORLD CONTEXT (v8.44, community-sourced, informational
        // only — deliberately NOT folded into `score` above) ---
        // Explicit user framing: "distribution of points, bowling type and
        // talents are more important than rating... anything over 20k is
        // usually an ok pull, and 25k is a good pull" — and separately,
        // "a $1k waged youth pull will be a good one." Both are shown as
        // context for the manager to weigh, not baked into the score,
        // since the score is already driven by the actual skill
        // distribution/talents this rating-tier commentary explicitly
        // says matters more.
        const rating = player.rating || 0;
        if (rating > 0) {
            if (rating >= 25000) result.breakdown.push(`Rating ${rating.toLocaleString()} — a good pull by rating alone (25k+), but distribution/bowling type/talents matter more than this number`);
            else if (rating >= 20000) result.breakdown.push(`Rating ${rating.toLocaleString()} — an OK pull by rating alone (20k+), but distribution/bowling type/talents matter more than this number`);
        }
        const wage = player.wage || 0;
        if (wage > 0 && wage <= 1000) {
            result.breakdown.push(`Wage $${wage.toLocaleString()}/wk — a $1k-or-under youth pull is generally a good sign`);
        }
        // Squad-need context: same role-gap concept as the transfer
        // advisor's comparePlayerToSquadPeers() isGap, but phrased for a
        // youth prospect you already own rather than a market candidate —
        // "are you in desperate need of a wicketkeeper, or will the
        // player not play until they're 20" was explicit user guidance on
        // what should factor into a keep/release call beyond raw skill.
        if (context && context.squadStats) {
            const ss = context.squadStats;
            if (primaryName === 'keeping' && ss.keeperCount <= 1) {
                result.breakdown.push(`Squad need: only ${ss.keeperCount} senior keeper${ss.keeperCount === 1 ? '' : 's'} — a genuine keeper prospect is worth more to you right now than the raw score alone suggests`);
            } else if (primaryName === 'bowling' && ss.bowlerCount < 4) {
                result.breakdown.push(`Squad need: only ${ss.bowlerCount} senior bowlers — a genuine bowling prospect is worth more to you right now than the raw score alone suggests`);
            } else if (primaryName === 'batting' && ss.batterCount < 4) {
                result.breakdown.push(`Squad need: only ${ss.batterCount} senior batters — a genuine batting prospect is worth more to you right now than the raw score alone suggests`);
            }
        }
        if (context && context.academyLevel) {
            result.breakdown.push(`Academy: ${context.academyLevel} — how fast this prospect actually develops (and how much runway you realistically have) depends heavily on this`);
        }

        // --- VERDICT ---
        if (result.score >= 18) {
            result.verdict = 'elite';
            result.verdictColor = '#1b5e20';
        } else if (result.score >= 14) {
            result.verdict = 'strong';
            result.verdictColor = '#2e7d32';
        } else if (result.score >= 10) {
            result.verdict = 'promising';
            result.verdictColor = '#689f38';
        } else if (result.score >= 6) {
            result.verdict = 'average';
            result.verdictColor = '#f57c00';
        } else if (result.score >= 3) {
            result.verdict = 'weak';
            result.verdictColor = '#e64a19';
        } else {
            result.verdict = 'release';
            result.verdictColor = '#d32f2f';
        }

        // Special case: if score is very low and no talents, recommend release
        if (result.score < 4 && talents.length === 0 && primarySkill <= 2) {
            result.verdict = 'release';
            result.verdictColor = '#d32f2f';
            result.warnings.push('Very weak recruit with no talents. Consider selling/releasing to free squad spot.');
        }

        return result;
    }

    // ============================================================
    // YOUTH RECRUIT PAGE UI
    // ============================================================
    function createYouthRecruitAdvisorUI() {
        createPanel({
            title: 'Youth Recruit Advisor', icon: '\u{1F331}',
            buttons: [],
            sections: [
                { id: 'ftp-recruit-eval', label: 'Recruit Evaluation', icon: '\u2B50', iconColor: 'amber',
                  content: '<div class="vj-text-sm vj-text-muted">Recruit a player to evaluate them here.</div>' },
                { id: 'ftp-youth-overview', label: 'Youth Squad Overview', icon: '\u{1F465}', iconColor: 'green' },
                { id: 'ftp-recruit-tips', label: 'Recruitment Tips', icon: '\u{1F4A1}', iconColor: 'blue' },
                { id: 'ftp-data-status', label: '', icon: '' }
            ]
        });
    }

    function updateYouthRecruitAdvisor() {
        const cache = loadPlayerCache();
        const youthPlayers = cache ? cache.players.filter(p => p.age <= YOUTH_MAX_AGE) : [];
        const academyInfo = loadAcademyCache();
        const financeInfo = loadFinanceCache();

        // Youth squad overview
        const overviewEl = document.getElementById('ftp-youth-overview');
        if (youthPlayers.length > 0) {
            const avgAge = youthPlayers.reduce((s, p) => s + p.age, 0) / youthPlayers.length;
            const avgBat = youthPlayers.reduce((s, p) => s + p.batting, 0) / youthPlayers.length;
            const avgBowl = youthPlayers.reduce((s, p) => s + p.bowling, 0) / youthPlayers.length;
            const withProdigy = youthPlayers.filter(p => p.talents?.some(t => /prodigy/i.test(t)));
            const withGifted = youthPlayers.filter(p => p.talents?.some(t => /gifted/i.test(t)));

            overviewEl.innerHTML = `<div class="ftp-info-box success">
                <div class="vj-flex vj-gap-6 vj-mb-4" style="flex-wrap:wrap;">
                    <span class="ftp-stat-badge green">Squad: ${youthPlayers.length}</span>
                    <span class="ftp-stat-badge blue">Avg age: ${avgAge.toFixed(1)}</span>
                </div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Avg batting</span><span class="ftp-stat-value">${skillLabel(Math.round(avgBat))}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Avg bowling</span><span class="ftp-stat-value">${skillLabel(Math.round(avgBowl))}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">With Prodigy</span><span class="ftp-stat-value">${withProdigy.length}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">With Gifted</span><span class="ftp-stat-value">${withGifted.length}</span></div>
            </div>`;
        } else {
            overviewEl.innerHTML = '<div class="vj-text-sm vj-text-muted">No youth squad data. Visit Youth Squad page first.</div>';
        }

        // Tips
        document.getElementById('ftp-recruit-tips').innerHTML = `<div class="ftp-info-box" style="border-left:3px solid var(--vj-amber);">
            <div class="vj-fw-700 vj-mb-4">Recruitment Tips</div>
            <div class="vj-text-xs vj-text-secondary" style="line-height:1.8;">
                <div>\u2022 Higher academy = better quality recruits</div>
                <div>\u2022 "General" scout type finds best overall player</div>
                <div>\u2022 Recruit every week \u2014 it's free</div>
                <div>\u2022 Youth under 21 auto-promotes to senior squad</div>
                <div>\u2022 Can sell recruits within 7 days if unwanted</div>
                <div class="vj-fw-700 vj-mt-4">Training Priority:</div>
                <div>1. Fielding to Capable (6) \u2014 cheapest early pops</div>
                <div>2. Primary skill to Average (4)</div>
                <div>3. Technique if lagging behind primary</div>
            </div>
        </div>`;

        // Evaluate recruits
        // Context for evaluateYouthRecruit()'s real-world commentary
        // (v8.44, community-sourced) \u2014 squad-role-need and academy level,
        // same computeSquadStats() shape used everywhere else in the file.
        const recruitSquadStats = computeSquadStats(cache ? cache.players : []);
        const recruitContext = { squadStats: recruitSquadStats, academyLevel: academyInfo?.level || null };

        const evalEl = document.getElementById('ftp-recruit-eval');
        const recentRecruits = youthPlayers.filter(p => p.experience <= 1 && p.age <= 17);
        if (recentRecruits.length > 0) {
            const recruit = recentRecruits.sort((a, b) => a.age - b.age)[0];
            const eval_ = evaluateYouthRecruit(recruit, recruitContext);
            const verdictBadge = eval_.verdict === 'elite' ? 'green' : eval_.verdict === 'strong' ? 'green' : eval_.verdict === 'promising' ? 'blue' : eval_.verdict === 'average' ? 'amber' : 'red';

            evalEl.innerHTML = `<div class="ftp-rec ${eval_.verdict === 'release' ? 'critical' : eval_.verdict === 'weak' ? 'high' : eval_.verdict === 'average' ? 'medium' : 'low'}">
                <div class="vj-flex-between"><span class="ftp-rec-name">${recruit.name} <span class="vj-text-xs vj-text-muted">(age ${recruit.age})</span></span><span class="ftp-stat-badge ${verdictBadge}">${eval_.verdict.toUpperCase()}</span></div>
                <div class="vj-text-xs vj-text-secondary vj-mt-4">Score: ${eval_.score}/25 \u00B7 Role: ${eval_.roleFit}</div>
                <div class="vj-text-xs vj-text-muted vj-mt-4">Bat ${skillLabel(recruit.batting)} \u00B7 Bowl ${skillLabel(recruit.bowling)} \u00B7 Keep ${skillLabel(recruit.keeping)} \u00B7 Tech ${skillLabel(recruit.technique)} \u00B7 End ${skillLabel(recruit.endurance)} \u00B7 Pwr ${skillLabel(recruit.power)} \u00B7 Field ${skillLabel(recruit.fielding)}</div>
                <div class="ftp-rec-program vj-mt-4">\u2192 ${TRAINING_PROGRAM_LABELS[eval_.recommendedTraining] || eval_.recommendedTraining}</div>
                ${eval_.warnings.length > 0 ? `<div class="ftp-rec-warnings vj-mt-4">\u26A0 ${eval_.warnings.join(' \u00B7 ')}</div>` : ''}
                ${eval_.breakdown.filter(b => /Rating|Wage|Squad need|Academy:/.test(b)).map(b => `<div class="vj-text-xs vj-text-muted vj-mt-4">\u2022 ${b}</div>`).join('')}
            </div>`;
        } else if (youthPlayers.length > 0) {
            let html = '';
            const evalCache = new Map();
            const getEval = (p) => { if (!evalCache.has(p.id)) evalCache.set(p.id, evaluateYouthRecruit(p, recruitContext)); return evalCache.get(p.id); };
            const sorted = [...youthPlayers].sort((a, b) => getEval(b).score - getEval(a).score);
            sorted.slice(0, 10).forEach(p => {
                const ev = getEval(p);
                const badge = ev.verdict === 'elite' ? 'green' : ev.verdict === 'strong' ? 'green' : ev.verdict === 'promising' ? 'blue' : ev.verdict === 'average' ? 'amber' : 'red';
                html += `<div class="ftp-stat-row" style="padding:4px 0;">
                    <span class="vj-text-xs" style="font-weight:600;">${p.name} (${formatAgeDisplay(p.age)})</span>
                    <span class="vj-text-xs vj-text-muted">Bat ${skillLabel(p.batting)} \u00B7 Bowl ${skillLabel(p.bowling)}</span>
                    <span class="ftp-stat-badge ${badge}" style="font-size:9px;">${ev.verdict.toUpperCase()} (${ev.score})</span>
                </div>`;
            });
            evalEl.innerHTML = html;
        } else {
            evalEl.innerHTML = '<div class="vj-text-sm vj-text-muted">Visit Youth Squad page to load data for evaluation.</div>';
        }

        // Data status
        const statusEl = document.getElementById('ftp-data-status');
        if (statusEl) {
            const squadAge = getDataAgeText(CACHE_TIMESTAMP_KEY);
            const academyAge = getDataAgeText(ACADEMY_TIMESTAMP_KEY);
            statusEl.innerHTML = `<div class="ftp-stat-row"><span class="ftp-stat-label">Squad</span><span class="vj-text-xs vj-text-muted">${squadAge}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Academy</span><span class="vj-text-xs vj-text-muted">${academyAge}</span></div>`;
        }
    }

    function applyTrainingRecommendations(recs) {
        let applied = 0;
        recs.forEach(rec => {
            const p = rec.player;
            if (!p.selectElement) return;

            const programKey = rec.program;
            const programLabel = TRAINING_PROGRAM_LABELS[programKey];
            if (!programLabel) return;

            // Find the option with matching text
            const select = p.selectElement;
            for (let i = 0; i < select.options.length; i++) {
                if (select.options[i].textContent.trim().toLowerCase() === programLabel.toLowerCase()) {
                    select.selectedIndex = i;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    applied++;
                    break;
                }
            }
        });
        alert(`Applied ${applied} training recommendations. Click "Save Training" on the page to confirm changes.`);
    }

    // ============================================================
    // ACADEMY PAGE SCRAPER (when user visits the page)
    // ============================================================
    function scrapeAcademyPage() {
        const info = parseAcademyDoc(document);
        saveAcademyCache(info);
        return info;
    }

    // ============================================================
    // FINANCE PAGE SCRAPER (when user visits the page)
    // ============================================================
    function scrapeFinancePage() {
        const info = parseFinanceDoc(document);
        saveFinanceCache(info);
        return info;
    }

    // ============================================================
    // GROUND PAGE SCRAPER (when user visits the page)
    // Parses capacity, ground name, last upgraded from DOM.
    // ============================================================
    function scrapeGroundPage() {
        const info = { capacity: 0, groundName: '', lastUpgraded: '', nextUpgrade: '' };
        const rows = document.querySelectorAll('table.data tr');
        rows.forEach(row => {
            const th = row.querySelector('th');
            const td = row.querySelector('td');
            if (!th || !td) return;
            const label = th.textContent.trim().toLowerCase();
            const value = td.textContent.trim();
            if (label.includes('capacity')) info.capacity = parseInt(value.replace(/,/g, '')) || 0;
            else if (label.includes('ground name')) info.groundName = value;
            else if (label.includes('last upgraded')) info.lastUpgraded = value;
            else if (label.includes('next upgrade')) info.nextUpgrade = value;
        });
        saveGroundCache(info);
        return info;
    }

    // ============================================================
    // CAPACITY RECOMMENDATION ENGINE
    // Uses game rules (official manual): gate takings, maintenance
    // cost, expansion cost, and financial context to advise on
    // optimal seat count.
    // ============================================================
    function recommendCapacity(groundInfo, financeInfo, division, teamInfo) {
        const capacity = groundInfo?.capacity || 0;
        const funds = financeInfo?.availableFunds || 0;
        const weeklyNet = financeInfo?.weeklyNet || 0;
        const seniorWages = financeInfo?.seniorWages || 0;
        const supporters = teamInfo?.supporters || 0;
        const supporterGrowth = teamInfo?.supporterGrowth || 0;

        // Gate ticket prices per division (from official manual Season 52+)
        const GATE_PRICES = {
            1: { seniorOD: 13.00, seniorT20: 10.50, youthOD: 5.25, youthT20: 2.65 },
            2: { seniorOD: 12.16, seniorT20: 9.82, youthOD: 4.91, youthT20: 2.48 },
            3: { seniorOD: 11.36, seniorT20: 9.18, youthOD: 4.59, youthT20: 2.32 },
            4: { seniorOD: 10.63, seniorT20: 8.85, youthOD: 4.29, youthT20: 2.17 },
            5: { seniorOD: 9.94, seniorT20: 8.02, youthOD: 4.01, youthT20: 2.03 }
        };
        const prices = GATE_PRICES[division] || GATE_PRICES[4];

        // Estimate weekly gate revenue at 100% capacity (2/3 for home team)
        // ~2 senior OD, ~1 senior T20, ~1 youth OD, ~1 youth T20 per week
        const estWeeklyGate = Math.round(
            (prices.seniorOD * 2 + prices.seniorT20 * 1 + prices.youthOD * 1 + prices.youthT20 * 1) * capacity * (2 / 3)
        );

        // Weekly maintenance cost: $1 per seat
        const weeklyMaintenance = capacity;

        // Net gate contribution per week
        const netGatePerWeek = estWeeklyGate - weeklyMaintenance;

        // Expansion cost calculator
        const expansionCost = (newCapacity) => {
            const diff = Math.abs(newCapacity - capacity);
            return 10000 + diff * 20;
        };

        // Break-even: how many home matches needed to recoup expansion cost
        const breakEvenWeeks = (newCapacity) => {
            const cost = expansionCost(newCapacity);
            const newMaintenance = newCapacity;
            const newGate = Math.round(
                (prices.seniorOD * 2 + prices.seniorT20 * 1 + prices.youthOD * 1 + prices.youthT20 * 1) * newCapacity * (2 / 3)
            );
            const additionalRevenue = newGate - newMaintenance - netGatePerWeek;
            if (additionalRevenue <= 0) return Infinity;
            return Math.ceil(cost / additionalRevenue);
        };

        const rec = {
            capacity: capacity,
            action: 'maintain',
            reason: '',
            priority: 'low',
            details: [],
            warnings: []
        };

        // Financial warnings
        if (funds < 50000) {
            rec.warnings.push(`Low funds ($${funds.toLocaleString()}) — expansion costs at least $70,000 for +3,000 seats.`);
        }
        if (weeklyNet < 0) {
            rec.warnings.push(`Weekly net is negative ($${weeklyNet.toLocaleString()}/wk) — adding seats increases maintenance by $1/seat/wk.`);
        }

        // Estimate attendance based on actual supporters (from club page)
        // Attendance is capped by capacity; not all supporters attend every match.
        // Real community data (v8.44) replacing a previous unsourced guess
        // (0.45x, i.e. "45% of supporters attend"): crowd numbers run
        // roughly supporter base x 7-8 depending on team mood — NOT a
        // fraction of supporters, a MULTIPLE of it. The old 0.45x figure
        // was understating realistic attendance by roughly 16-18x, which
        // would have made every recommendation below think the ground was
        // wildly over-capacity when it likely wasn't. Mood isn't currently
        // scraped into a numeric scale (info.mood is a raw, unmapped
        // string), so this uses the midpoint of the stated 7-8x range
        // rather than fabricating a mood-to-multiplier mapping without
        // real data to back specific values.
        const ATTENDANCE_MULTIPLIER = 7.5;
        const estAttendance = supporters > 0
            ? Math.min(Math.round(supporters * ATTENDANCE_MULTIPLIER), capacity)
            : Math.min(Math.round((division <= 2 ? 3000 : division <= 3 ? 2000 : 1200)), capacity);
        const utilizationPct = capacity > 0 ? Math.round((estAttendance / capacity) * 100) : 0;
        // Target capacity for a growing club — same source: "supporter
        // base of 2000 -> capacity ~17,000-18,000" implies roughly 8.5-9x
        // supporters, deliberately higher than the attendance multiplier
        // to leave room for the supporter base to keep growing without
        // selling out every week. Midpoint used for the same reason as above.
        const TARGET_CAPACITY_MULTIPLIER = 8.5;

        rec.details.push(`Capacity: ${capacity.toLocaleString()} seats`);
        rec.details.push(`Weekly maintenance: $${weeklyMaintenance.toLocaleString()}/wk (${capacity} \u00D7 $1)`);
        rec.details.push(`Est. weekly gate revenue (100% full): $${estWeeklyGate.toLocaleString()}`);
        rec.details.push(`Est. weekly net gate contribution: $${netGatePerWeek.toLocaleString()}`);
        if (supporters > 0) {
            rec.details.push(`Supporters: ${supporters.toLocaleString()} (${supporterGrowth > 0 ? '+' : ''}${supporterGrowth}/wk)`);
            rec.details.push(`Est. attendance: ~${estAttendance.toLocaleString()} (${utilizationPct}% full, ~${ATTENDANCE_MULTIPLIER}x supporters — varies with team mood)`);
        } else {
            rec.details.push(`Est. attendance (Div ${division}): ~${estAttendance.toLocaleString()} (${utilizationPct}% full)`);
        }
        rec.details.push(`Ticket prices: OD $${prices.seniorOD} \u00B7 T20 $${prices.seniorT20} \u00B7 YOD $${prices.youthOD} \u00B7 YT20 $${prices.youthT20}`);

        // Capacity recommendation logic
        const MIN_CAPACITY = 8000; // Game rule: minimum ground capacity

        if (capacity < MIN_CAPACITY) {
            rec.action = 'expand';
            rec.priority = 'high';
            rec.reason = `Capacity of ${capacity.toLocaleString()} is below the minimum allowed (${MIN_CAPACITY.toLocaleString()}). Must expand to at least ${MIN_CAPACITY.toLocaleString()}. Cost: $${expansionCost(MIN_CAPACITY).toLocaleString()}.`;
        } else if (capacity === MIN_CAPACITY) {
            if (utilizationPct >= 80) {
                rec.action = 'expand';
                rec.priority = 'medium';
                rec.reason = `At ${utilizationPct}% capacity and at minimum seat count (${MIN_CAPACITY.toLocaleString()}). Expanding would capture more gate revenue. Cost: $${expansionCost(MIN_CAPACITY + 2000).toLocaleString()} to reach ${(MIN_CAPACITY + 2000).toLocaleString()}.`;
            } else {
                rec.action = 'maintain';
                rec.priority = 'low';
                rec.reason = `At minimum capacity (${MIN_CAPACITY.toLocaleString()}) with ${utilizationPct}% utilization. Cannot reduce further. Expand only when consistently selling out (80%+).`;
            }
        } else if (capacity <= 10000) {
            if (utilizationPct >= 90) {
                rec.action = 'expand';
                rec.priority = 'low';
                rec.reason = `At ${utilizationPct}% capacity, nearly full. Expanding would capture more gate revenue. Cost: $${expansionCost(capacity + 2000).toLocaleString()}.`;
            } else if (utilizationPct >= 60) {
                rec.action = 'maintain';
                rec.priority = 'low';
                rec.reason = `At ${utilizationPct}% utilization — reasonable balance. Gate revenue: ~$${estWeeklyGate.toLocaleString()}/wk, maintenance: $${weeklyMaintenance.toLocaleString()}/wk.`;
            } else {
                const targetCap = Math.max(MIN_CAPACITY, supporters > 0 ? Math.round(supporters * TARGET_CAPACITY_MULTIPLIER) : estAttendance + 1000);
                if (targetCap >= capacity) {
                    rec.action = 'maintain';
                    rec.priority = 'low';
                    rec.reason = `At ${utilizationPct}% utilization but reducing below ${targetCap.toLocaleString()} would not be beneficial. Current capacity is near optimal for your supporter base.`;
                } else {
                    rec.action = 'reduce';
                    rec.priority = 'low';
                    rec.reason = `At ${utilizationPct}% utilization, ${capacity.toLocaleString()} seats is more than needed. Could reduce to ${targetCap.toLocaleString()} to save $${(capacity - targetCap).toLocaleString()}/wk in maintenance. Cost: $${expansionCost(targetCap).toLocaleString()}.`;
                }
            }
        } else {
            // Over 10,000 seats
            if (utilizationPct >= 70) {
                rec.action = 'maintain';
                rec.priority = 'low';
                rec.reason = `Large ground (${capacity.toLocaleString()}) at ${utilizationPct}% utilization. Gate revenue should comfortably cover $${weeklyMaintenance.toLocaleString()}/wk maintenance.`;
            } else {
                const targetCap = Math.max(MIN_CAPACITY, supporters > 0 ? Math.round(supporters * TARGET_CAPACITY_MULTIPLIER) : estAttendance + 1500);
                if (targetCap >= capacity) {
                    rec.action = 'maintain';
                    rec.priority = 'low';
                    rec.reason = `At ${utilizationPct}% utilization but at or near minimum capacity. Expand when supporters grow.`;
                } else {
                    rec.action = 'reduce';
                    rec.priority = 'medium';
                    rec.reason = `At ${utilizationPct}% utilization, ${capacity.toLocaleString()} seats is excessive. Reducing to ${targetCap.toLocaleString()} would save $${(capacity - targetCap).toLocaleString()}/wk in maintenance. Cost: $${expansionCost(targetCap).toLocaleString()}.`;
                }
            }
        }

        // Community wisdom: only expand when selling out
        if (rec.action === 'maintain' && utilizationPct < 80) {
            rec.details.push('Community advice: Only expand once you sell out a few matches in a row.');
        }

        return rec;
    }

    // ============================================================
    // CLUB HOME PAGE — DATA STATUS DASHBOARD
    // (club.htm) Deliberately shows ONLY cache/data status, no
    // recommendations — this page is not scraped for anything, it's
    // just a quick "is my advisor's data fresh?" check before you go
    // trust the orders/training/ground/academy advice elsewhere.
    // Self-contained: only touches #ftp-club-status, nothing else.
    // ============================================================

    // ============================================================
    // CLUB PAGE SCRAPER — parses supporters, mood, division from DOM
    // ============================================================
    function scrapeClubPage() {
        const info = { supporters: 0, supporterGrowth: 0, mood: '', division: 4 };
        const rows = document.querySelectorAll('table.data tr');
        rows.forEach(row => {
            const th = row.querySelector('th');
            const td = row.querySelector('td');
            if (!th || !td) return;
            const label = th.textContent.trim().toLowerCase();
            if (label.includes('supporter')) {
                const moodSpan = td.querySelector('.skillup, .skilldown, .skillneutral');
                if (moodSpan) info.mood = moodSpan.textContent.trim();
                const text = td.textContent.trim();
                const countMatch = text.match(/(\d[\d,]*)\s*\(([+-]?\d+)\)/);
                if (countMatch) {
                    info.supporters = parseInt(countMatch[1].replace(/,/g, '')) || 0;
                    info.supporterGrowth = parseInt(countMatch[2]) || 0;
                } else {
                    const numMatch = text.match(/(\d[\d,]*)/);
                    if (numMatch) info.supporters = parseInt(numMatch[1].replace(/,/g, '')) || 0;
                }
            } else if (label.includes('country') || label.includes('division')) {
                const divMatch = td.textContent.match(/One Day\s*([\d.]+)/i) || td.textContent.match(/Div(?:ision)?\s*([\d.]+)/i);
                if (divMatch) info.division = Math.round(parseFloat(divMatch[1])) || 4;
            }
        });
        saveTeamInfoCache(info);
        return info;
    }

    function fetchClubFromPage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 15000,
                onload: function(response) {
                    if (response.status === 200) {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(response.responseText, 'text/html');
                        const info = { supporters: 0, supporterGrowth: 0, mood: '', division: 4 };
                        const rows = doc.querySelectorAll('table.data tr');
                        rows.forEach(row => {
                            const th = row.querySelector('th');
                            const td = row.querySelector('td');
                            if (!th || !td) return;
                            const label = th.textContent.trim().toLowerCase();
                            if (label.includes('supporter')) {
                                const moodSpan = td.querySelector('.skillup, .skilldown, .skillneutral');
                                if (moodSpan) info.mood = moodSpan.textContent.trim();
                                const text = td.textContent.trim();
                                const countMatch = text.match(/(\d[\d,]*)\s*\(([+-]?\d+)\)/);
                                if (countMatch) {
                                    info.supporters = parseInt(countMatch[1].replace(/,/g, '')) || 0;
                                    info.supporterGrowth = parseInt(countMatch[2]) || 0;
                                } else {
                                    const numMatch = text.match(/(\d[\d,]*)/);
                                    if (numMatch) info.supporters = parseInt(numMatch[1].replace(/,/g, '')) || 0;
                                }
                            } else if (label.includes('country') || label.includes('division')) {
                                const divMatch = td.textContent.match(/One Day\s*([\d.]+)/i) || td.textContent.match(/Div(?:ision)?\s*([\d.]+)/i);
                                if (divMatch) info.division = Math.round(parseFloat(divMatch[1])) || 4;
                            }
                        });
                        resolve(info);
                    } else {
                        reject(new Error(`HTTP ${response.status}`));
                    }
                },
                onerror: function(err) { reject(err); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    // ============================================================
    // TRANSFER ADVISOR — transfer.htm
    // Shows target filters and community strategy guidance for the
    // transfer market. Placeholder for future auto-search integration.
    // ============================================================
    function createTransferAdvisorUI() {
        createPanel({
            title: 'Transfer Advisor', icon: '\u{1F4B0}',
            buttons: [
                { id: 'ftp-refresh', label: '\u21BB', title: 'Refresh' }
            ],
            sections: [
                { id: 'ftp-transfer-gaps', label: 'Squad Gaps', icon: '\u26A0', iconColor: 'amber' },
                { id: 'ftp-transfer-results', label: 'Search Results', icon: '\u{1F50D}', iconColor: 'green',
                  content: '<div class="vj-text-sm vj-text-muted">Search for players on the transfer form to evaluate them here.</div>' },
                { id: 'ftp-transfer-targets', label: 'Target Thresholds', icon: '\u{1F3AF}', iconColor: 'blue', collapsible: true, collapsed: true },
                { id: 'ftp-transfer-finance', label: 'Your Budget', icon: '\u{1F4B5}', iconColor: 'amber' },
                { id: 'ftp-transfer-strategy', label: 'Strategy Guide', icon: '\u{1F4D6}', iconColor: 'teal', collapsible: true, collapsed: true }
            ]
        });

        document.getElementById('ftp-refresh').addEventListener('click', updateTransferAdvisor);
    }

    function updateTransferAdvisor() {
        // ---- Parse live search results from the page ----
        const resultsEl = document.getElementById('ftp-transfer-results');
        const financeInfo = loadFinanceCache();
        const cache = loadPlayerCache();
        const allPlayers = cache ? cache.players : [];
        const seniorPlayers = allPlayers.filter(p => p.age >= 21);
        const youthPlayers = allPlayers.filter(p => p.age < 21);
        const squadStats = computeSquadStats(allPlayers);

        // ---- SQUAD GAPS ANALYSIS ----
        const gapsEl = document.getElementById('ftp-transfer-gaps');
        if (gapsEl && squadStats) {
            const gaps = [];
            const WARN = 'var(--vj-red)', OK = 'var(--vj-green)', NEUTRAL = 'var(--vj-blue)';

            const transferConf = computeConfidence({
                cacheAgeHours: cache ? cache.ageHours : null,
                playersWithSkills: allPlayers.filter(p => (p.batting || 0) > 0).length,
                totalPlayers: allPlayers.length,
                hasAcademyInfo: false,
                hasFinanceInfo: !!financeInfo,
                hasOpponentData: false,
                matchTypeKnown: false,
            });

            // Role balance: ideal squad has ~4 batters, ~4 bowlers, ~2 all-rounders, 1 keeper
            if (squadStats.keeperCount < 1) gaps.push({ text: 'No specialist keeper — urgently need one', color: WARN });
            else if (squadStats.keeperCount === 1) gaps.push({ text: 'Only 1 keeper — consider backup', color: NEUTRAL });

            if (squadStats.bowlerCount < 3) gaps.push({ text: `Only ${squadStats.bowlerCount} bowler${squadStats.bowlerCount !== 1 ? 's' : ''} — need at least 4 for selection flexibility`, color: WARN });
            else if (squadStats.bowlerCount < 4) gaps.push({ text: `${squadStats.bowlerCount} bowlers — one more would help`, color: NEUTRAL });

            if (squadStats.batterCount < 4) gaps.push({ text: `Only ${squadStats.batterCount} batter${squadStats.batterCount !== 1 ? 's' : ''} — batting lineup is thin`, color: WARN });

            if (squadStats.allrounderCount < 1) gaps.push({ text: 'No all-rounders — missing valuable squad flexibility', color: NEUTRAL });

            // Skill gaps: compare min skills to reasonable thresholds
            if (squadStats.minPrimary < 7) gaps.push({ text: `Lowest primary skill is ${skillLabel(squadStats.minPrimary)} — squad depth issue`, color: WARN });
            if (squadStats.avgPrimary < 8) gaps.push({ text: `Average primary is ${skillLabel(squadStats.avgPrimary)} — below Expert`, color: NEUTRAL });

            // Age profile
            const oldPlayers = seniorPlayers.filter(p => p.age >= 30);
            if (oldPlayers.length > 3) gaps.push({ text: `${oldPlayers.length} players aged 30+ — consider succession planning`, color: NEUTRAL });

            if (gaps.length === 0) {
                gapsEl.innerHTML = `<div style="margin-bottom:6px;">${renderConfidenceBadge(transferConf)}</div><div class="ftp-stat-row"><span class="ftp-stat-label" style="color:var(--vj-green);">Squad composition looks solid</span></div>`;
            } else {
                gapsEl.innerHTML = `<div style="margin-bottom:6px;">${renderConfidenceBadge(transferConf)}</div>` + gaps.map(g =>
                    `<div class="ftp-stat-row"><span class="ftp-stat-label" style="color:${g.color};font-size:11px;">\u2022 ${g.text}</span></div>`
                ).join('');
            }
        }

        if (resultsEl) {
            const results = scrapeTransferResults();
            if (results.length > 0) {
                // Evaluate each player against squad stats
                const evaluated = results.map(p => {
                    const ev = evaluateTransferTarget(p, squadStats);
                    ev.rank = calculateRank(p, squadStats);
                    // Squad-peer comparison computed up front (not just at
                    // render time) so it can gate the senior filter below,
                    // not just annotate the card afterwards.
                    // v8.66: computed for EVERY age, not just 21+. The v8.28
                    // "youth are development bets, not like-for-like swaps"
                    // gate was meant to keep the FILTER from hiding them, but
                    // it also silently removed the compare line from under-21
                    // cards entirely — a 20y12w candidate the user is weighing
                    // against a promotion slot got no "would replace anyone?"
                    // answer at all. The comparison is against senior squad
                    // peers either way (the only players who'd compete for an
                    // XI spot), so it's exactly as meaningful for a player
                    // weeks from promotion as it is for one already senior.
                    const peerCompare = comparePlayerToSquadPeers(p, seniorPlayers);
                    return { ...p, eval: ev, peerCompare };
                });

                // ---- FILTERS ----
                // Separate youth (16-20) and senior (21+) evaluations
                // Youth: evaluated against age curve, no age limit
                // Seniors: max age 27 (matches the oldest "base" screenshot
                // benchmark) — the base itself (checkScoutBenchmark) is what
                // actually gates skill/wage/experience per age.
                const SENIOR_MAX_AGE = 27;

                const ageFiltered = evaluated.filter(e => {
                    const age = ageYears(e.age);
                    return age >= 21 && age > SENIOR_MAX_AGE;
                }).length;

                // Requested behaviour: an ELITE senior sitting on the
                // market is still a wasted signing if they're not
                // actually better than what you already have — showing
                // "elite" or "strong" verdicts on their own is pointless
                // for a like-for-like swap. So for 21+, "worth showing"
                // means BOTH the absolute verdict is elite AND the
                // squad-peer comparison says they're a real upgrade
                // (outrank at least one current player in the SAME role
                // — batter vs batters, bowler vs bowlers, keeper vs
                // keepers, see comparePlayerToSquadPeers) or fill a
                // genuine role gap (isGap). Youth keep the original
                // elite/strong/adequate gate — they're development bets
                // against an age curve, not like-for-like swaps, so
                // "better than your current squad" doesn't apply yet.
                function isWorthShowing(e) {
                    const age = ageYears(e.age);
                    const isYouth = age < 21;
                    if (!isYouth && age > SENIOR_MAX_AGE) {
                        e.eval.warnings.push(`Age ${age} — past prime years for senior transfer`);
                        return false;
                    }
                    if (isYouth) {
                        return e.eval.verdict !== 'poor' && e.eval.verdict !== 'weak';
                    }
                    if (e.eval.verdict !== 'elite') {
                        e.eval.warnings.push(`Verdict ${e.eval.verdict.toUpperCase()} — only ELITE seniors that also upgrade your squad are shown here`);
                        return false;
                    }
                    const cmp = e.peerCompare;
                    if (!cmp || cmp.isGap || cmp.wouldReplace.length > 0) return true;
                    e.eval.warnings.push(`Elite, but doesn't outrank any current ${cmp.groupLabel} in your squad — not a real upgrade`);
                    return false;
                }

                const filtered = evaluated.filter(isWorthShowing);

                const verdictFiltered = evaluated.length - ageFiltered - filtered.length;
                const skipped = evaluated.length - filtered.length;

                // Diagnostics: if a whole age group vanishes with no
                // obvious reason, this is the fastest way to tell a real
                // hard-filter miss from a scrape/column-mapping gap
                // (e.g. the v8.11/v8.12 always-0 bugs) without re-reading
                // the scoring code each time.
                const youthEval = evaluated.filter(e => ageYears(e.age) < 21);
                const seniorEval = evaluated.filter(e => ageYears(e.age) >= 21);
                // Reuses `filtered` (computed above) rather than calling
                // isWorthShowing again — it pushes into e.eval.warnings as
                // a side effect, and re-running it here would duplicate
                // every warning message shown on the actual cards.
                const filteredSet = new Set(filtered);
                console.log(`[FTP Transfer] Scanned ${evaluated.length} (${youthEval.length} youth, ${seniorEval.length} senior). ` +
                    `Youth pass: ${youthEval.filter(e => filteredSet.has(e)).length}/${youthEval.length}. ` +
                    `Senior pass (elite + squad upgrade): ${seniorEval.filter(e => filteredSet.has(e)).length}/${seniorEval.length}.`);
                // Always print the senior role composition the squad-gap
                // comparison is actually seeing, not just when isGap fires —
                // updateTransferAdvisor runs twice per page load (once on
                // stale cache, once after the background refresh), so logging
                // unconditionally on every pass removes the race where a
                // user's captured console output came from a different pass
                // than the rendered card. Also logs the RAW cache state
                // (null vs players.length) so a future "seniorPlayers is
                // EMPTY" report can immediately tell apart (1) cache never
                // saved/unreadable, (2) genuinely empty array, (3) all
                // players fail the age>=21 filter (an age-parsing bug).
                console.log(`[FTP Transfer] Raw squad cache: ${cache === null ? 'NULL (loadPlayerCache() returned nothing)' : `present, ${allPlayers.length} total players (all ages)`}`);
                console.log(`[FTP Transfer] Senior squad (age>=21, ${seniorPlayers.length} players) role counts — ` +
                    `batters: ${seniorPlayers.filter(p => getPrimarySkillInfo(p).name === 'batting').length}, ` +
                    `bowlers: ${seniorPlayers.filter(p => getPrimarySkillInfo(p).name === 'bowling').length}, ` +
                    `keepers: ${seniorPlayers.filter(p => getPrimarySkillInfo(p).name === 'keeping').length}`);
                if (youthEval.length > 0 && youthEval.every(e => e.eval.verdict === 'poor' || e.eval.verdict === 'weak')) {
                    // Flattened to a plain string, not a logged object —
                    // browser consoles collapse nested objects to "{...}"
                    // when copy-pasted as text, which makes an object-based
                    // log useless for a user pasting console output back.
                    youthEval.slice(0, 5).forEach(e => {
                        console.log(`[FTP Transfer] YOUTH FAIL: ${e.name} (age ${e.age.toFixed(2)}) — ` +
                            `Bat ${e.batting} Bowl ${e.bowling} Keep ${e.keeping} Tech ${e.technique} Field ${e.fielding} Rating ${e.rating} — ` +
                            `reasons: ${e.eval.warnings.join(' | ') || '(none — check verdict logic)'}`);
                    });
                }
                // Whenever a senior candidate's peer comparison reports
                // isGap ("no current X in your squad"), dump which real
                // senior players fed it and how each was role-classified —
                // the fastest way to distinguish a real empty role from a
                // classification/cache bug without re-reading the scoring
                // code. Factored as a standalone fn because the "Fetch
                // Experience & Wages" click re-runs comparePlayerToSquadPeers
                // a second time on real talent data and can flip isGap
                // independently of this first pass.
                function logSquadGapDiagnostic(evalList) {
                    if (!evalList.some(e => e.peerCompare && e.peerCompare.isGap)) return;
                    const gapRoles = [...new Set(evalList.filter(e => e.peerCompare && e.peerCompare.isGap).map(e => e.peerCompare.role))];
                    console.log(`[FTP Transfer] SQUAD GAP reported for role(s): ${gapRoles.join(', ')}. Senior squad (age>=21) role breakdown:`);
                    if (seniorPlayers.length === 0) {
                        console.log('[FTP Transfer]   seniorPlayers is EMPTY — squad cache has zero players with age>=21. Check squad cache/age parsing.');
                    }
                    seniorPlayers.forEach(p => {
                        const info = getPrimarySkillInfo(p);
                        console.log(`[FTP Transfer]   ${p.name} (age ${(p.age||0).toFixed(2)}) — Bat ${p.batting} Bowl ${p.bowling} Keep ${p.keeping} — classified as: ${info.name} (value ${info.value})`);
                    });
                }
                logSquadGapDiagnostic(seniorEval);
                const priorityBuys = filtered;

                // Academy/squad context for per-candidate Dynasty + Overall Rating
                // projections. Computed once here and reused by every render
                // pass (initial and after "Fetch Experience, Wages & Talents")
                // so the expensive training simulation runs once per candidate
                // per pass, not once per render.
                const academyInfoForProjection = loadAcademyCache();
                const squadContextForProjection = { size: seniorPlayers.length + youthPlayers.length, academyInfo: academyInfoForProjection, financeInfo: loadFinanceCache() };

                // Precompute and cache each candidate's near-term projection
                // (_ceilingResult, feeds the "Projected at 20" promo line),
                // the to-25 Dynasty comparison (_dynastyCeiling — the SAME
                // senior-comparable horizon the rating uses, so the card's
                // Dynasty chip reads on the same scale as a squad player's
                // Player Advisor Dynasty line), and the price-independent
                // Overall Rating, on the player object so both the sort below
                // and renderTransferResults can read them back instead of
                // recomputing.
                function computeCandidateRating(p) {
                    const academySpeed = getAcademySpeedForPlayer(p, academyInfoForProjection);
                    const ceilingResult = computePlayerCeiling(p, academySpeed, squadContextForProjection);
                    p._ceilingResult = ceilingResult;
                    // to-25 for EVERY age (v8.60, per the user: "I want till
                    // 25 so I can compare his potential future to my current
                    // 21/22/23 year olds") — the Dynasty chip AND the rating
                    // share this one projection. Candidates already ≥25 make
                    // it trivial (weeksToAge → 0 → ceiling == current).
                    // Precomputed HERE rather than inside computeOverallRating
                    // so the expensive training simulation still runs once per
                    // candidate (see the v8.49 design note).
                    const dynastyCeiling = computePlayerCeiling(p, academySpeed, squadContextForProjection, 25);
                    p._dynastyCeiling = dynastyCeiling;
                    p._overallRating = computeOverallRating(p, {
                        academySpeed,
                        squadContext: squadContextForProjection,
                        seniorCeiling: dynastyCeiling
                    });
                    return p;
                }
                priorityBuys.forEach(computeCandidateRating);

                // Record every candidate's price into the local price-history
                // ledger so future searches can anchor asking prices against
                // "similar listings this club has seen before."
                evaluated.forEach(p => recordPlayerPrice(p));

                // Sort: best OVERALL RATING first (the price-independent
                // "how good is this player" verdict), then verdict/rank/price
                // as tiebreakers — the list answers "who's the best player
                // here" with the fair-price line on each card separating a
                // great deal from a great-but-overpriced player.
                const verdictOrder = { elite: 0, strong: 1, adequate: 2 };
                priorityBuys.sort((a, b) =>
                    (b._overallRating && b._overallRating.score || 0) - (a._overallRating && a._overallRating.score || 0) ||
                    (verdictOrder[a.eval.verdict] ?? 9) - (verdictOrder[b.eval.verdict] ?? 9) ||
                    (a.price || 0) - (b.price || 0));
                function renderTransferResults(players, totalScanned, ageFilteredCount, verdictFilteredCount, detailsFetched) {
                    // peerCompare was already computed per-candidate up in
                    // the `evaluated` map (it now gates which seniors even
                    // make it into `players` — see isWorthShowing above),
                    // so just read it back rather than recomputing.
                    let html = `<div class="vj-flex vj-gap-6 vj-mb-8" style="flex-wrap:wrap;">
                        <span class="ftp-stat-badge green">${players.length} Target${players.length !== 1 ? 's' : ''}</span>
                        <span class="ftp-stat-badge neutral">${totalScanned} Total Scanned</span>
                        ${ageFilteredCount > 0 ? `<span class="vj-text-xs vj-text-muted" style="align-self:center;">${ageFilteredCount} over age limit</span>` : ''}
                        ${verdictFilteredCount > 0 ? `<span class="vj-text-xs vj-text-muted" style="align-self:center;">${verdictFilteredCount} below threshold or not a squad upgrade</span>` : ''}
                        ${!detailsFetched ? `<button id="ftp-fetch-details-btn" class="vj-btn vj-btn-sm" style="font-size:11px;padding:2px 8px;cursor:pointer;">\u21BB Fetch Experience, Wages & Talents</button>` : `<span class="ftp-stat-badge neutral">\u2713 Details fetched</span>`}
                    </div>`;
                    // Which academy level the Dynasty/rating projections below
                    // were computed with — the level/efficiency are re-scraped
                    // from the Academy page DOM on every visit (and refreshed
                    // by the background fetch daily), so after an in-game
                    // upgrade the next visit to the Academy page updates every
                    // projection on this page and on all squad pages. This
                    // line exists so the user can SEE that rather than trust it.
                    const academyContext = (academyInfoForProjection && academyInfoForProjection.level && academyInfoForProjection.level !== 'unknown')
                        ? `Projections use your <span class="vj-fw-700">${academyInfoForProjection.level}</span> academy (${academyInfoForProjection.seniorEfficiency}% senior / ${academyInfoForProjection.youthEfficiency}% youth efficiency)`
                        : `Academy level not cached yet — visit the <span class="vj-fw-700">Academy</span> page so market projections use your real training speed`;
                    html += `<div class="vj-text-xs vj-text-muted vj-mb-8">${academyContext}</div>`;
                    if (!detailsFetched) {
                        // Talents aren't shown on the transfer search table
                        // at all (game limitation \u2014 only on the player's
                        // own page), so every talent-driven bonus (Prodigy,
                        // Skilled, Seam/Spin Specialist, etc.) and the
                        // elite-verdict gate that depends on them are
                        // computed WITHOUT talents on this first pass.
                        // Verdicts, and which players even show up here,
                        // can genuinely change once fetched.
                        html += `<div class="vj-text-xs vj-text-muted vj-mb-8">\u2139\uFE0F Talents aren't visible on the search table itself \u2014 click above to fetch them per player. Verdicts (and who qualifies as ELITE) may change once talents are known.</div>`;
                    }

                    if (players.length === 0) {
                        html += '<div class="vj-text-sm vj-text-muted">No targets found. Try adjusting search filters (age, bowling type, skill ranges).</div>';
                    } else {
                        players.forEach((p, i) => {
                            const ev = p.eval;
                            // Verdict word shown on the card comes from the
                            // Overall Rating (v8.66) — the legacy
                            // evaluateTransferTarget verdict still drives the
                            // isWorthShowing filter below, but showing BOTH on
                            // the same card let them contradict each other
                            // (e.g. an 81.7-elite youth read "ADEQUATE" because
                            // the legacy curve verdict is a different scale that
                            // doesn't credit the to-25 projection). One judgment
                            // word now, derived from the SAME number as the
                            // ★ OVERALL badge, so they can't disagree. Reads the
                            // rating precomputed in computeCandidateRating (see
                            // the read-back comment below).
                            const overallRating = p._overallRating;
                            const ratingLabel = overallRating && overallRating.label ? overallRating.label : (ev.verdict || 'pass');
                            const ratingLabelClass = ratingLabel === 'elite' ? 'green' : ratingLabel === 'strong' ? 'teal' : ratingLabel === 'reasonable' ? 'amber' : 'red';
                            const primaryInfo = getPrimarySkillInfo(p);
                            const primarySkill = primaryInfo.value;
                            const primaryName = primaryInfo.name === 'keeping' ? 'Keep' : primaryInfo.name === 'bowling' ? 'Bowl' : 'Bat';
                            // Dynasty + Overall Rating were precomputed once per
                            // candidate in updateTransferAdvisor() (so they
                            // could drive the sort) and stored on the player
                            // object — read them back rather than re-running
                            // the expensive training simulation here.
                            const ceilingResult = p._ceilingResult;
                            const dynastyCeiling = p._dynastyCeiling;

                            // Build detail line — show experience/wage only if fetched
                            const detailParts = [
                                `${primaryName} ${skillLabel(primarySkill)}`,
                                `Tech ${skillLabel(p.technique)}`,
                                `Field ${skillLabel(p.fielding)}`,
                                `End ${skillLabel(p.endurance)}`,
                                `<span style="color:var(--vj-gold);">Dynasty ${dynastyCeiling.current.toFixed(1)}→${dynastyCeiling.ceiling.toFixed(1)} (${dynastyCeiling.weeks === 0 ? 'fully developed' : 'to 25'})</span>`
                            ];
                            // Keeping isn't always primary but is always worth
                            // showing for any plausible keeper (Capable+) so
                            // it doesn't take a per-player detail fetch to see.
                            if (primaryInfo.name !== 'keeping' && (p.keeping || 0) >= 6) detailParts.push(`Keep ${skillLabel(p.keeping)}`);
                            if (p.bowlerType) detailParts.push(`<span class="vj-fw-700">${p.bowlerType.toUpperCase()}</span>`);
                            if (p.rating) {
                                detailParts.push(`Rating ${p.rating.toLocaleString()}`);
                                // Hidden-value (spare rating) gauge — a transparent
                                // estimate of whether this player's displayed skills
                                // under-/over-state their true quality (hidden
                                // sub-level progress). See computeSpareRating().
                                const spare = computeSpareRating(p);
                                detailParts.push(spareRatingBadge(spare) || '');
                            }
                            if (detailsFetched && p.experience != null && p.experience > 0) detailParts.push(`Exp ${skillLabel(p.experience)}`);
                            if (detailsFetched && p.captaincy != null && p.captaincy > 0) detailParts.push(`Capt ${skillLabel(p.captaincy)}`);
                            if (detailsFetched && p.wage != null && p.wage > 0) {
                                const discNote = (p.wageDiscount != null && p.wageDiscount > 0)
                                    ? ` <span title="Loyalty wage discount ${p.wageDiscount}% — shown wage understates true cost">(-${p.wageDiscount}%)</span>`
                                    : '';
                                detailParts.push(`Wage $${p.wage.toLocaleString()}/wk${discNote}`);
                                // Role-aware, talent-aware value — see
                                // computePlayerValueSkillSum() for why this
                                // isn't a flat sum of unrelated skills.
                                const skillPerK = computePlayerValuePerK(p);
                                if (skillPerK != null) {
                                    const valueColor = skillPerK >= 10 ? 'var(--vj-green)' : skillPerK >= 5 ? 'var(--vj-gold)' : 'var(--vj-red)';
                                    detailParts.push(`<span style="color:${valueColor};">Value ${skillPerK.toFixed(1)} skill/$K</span>`);
                                }
                            }
                            if (p.price) detailParts.push(`Price $${p.price.toLocaleString()}`);
                            if (detailsFetched && p.talents && p.talents.length > 0) detailParts.push(`<span style="color:var(--vj-gold);">${p.talents.join(', ')}</span>`);

                            let compareHtml = '';
                            const cmp = p.peerCompare;
                            if (cmp) {
                                if (cmp.isGap) {
                                    compareHtml = `<div class="vj-text-xs" style="color:var(--vj-green);line-height:1.4;margin-top:2px;">\u2191 Fills a real gap \u2014 you have no current SENIOR ${cmp.role === 'keeping' ? 'wicketkeeper' : cmp.role === 'bowling' ? 'bowler' : 'batter'} (youth in that role, if any, aren't counted here \u2014 only players already eligible for the senior XI)</div>`;
                                } else if (cmp.wouldReplace.length > 0) {
                                    const names = cmp.wouldReplace.map(r => r.player.name).join(', ');
                                    compareHtml = `<div class="vj-text-xs" style="color:var(--vj-green);line-height:1.4;margin-top:2px;">\u2191 Outranks ${cmp.wouldReplace.length} of your ${cmp.groupLabel} \u2014 would replace: ${names}</div>`;
                                } else {
                                    compareHtml = `<div class="vj-text-xs vj-text-muted" style="line-height:1.4;margin-top:2px;">Doesn't outrank any current ${cmp.groupLabel} \u2014 depth signing only, not an upgrade.</div>`;
                                }
                            }

                            html += `<div class="ftp-rec low" style="padding:6px 8px;margin:3px 0;">
                                <div class="vj-flex-between">
                                    <span class="vj-fw-700" style="font-size:12px;">#${i+1} ${p.name} <span class="vj-text-xs vj-text-muted">(${formatAgeDisplay(p.age)})</span></span>
                                    <div style="display:flex;gap:4px;align-items:center;">
                                        ${overallRatingBadge(overallRating)}
                                        <span class="ftp-stat-badge ${ratingLabelClass}">${ratingLabel.toUpperCase()}</span>
                                    </div>
                                </div>
                                <div class="vj-text-xs vj-text-muted" style="line-height:1.4;margin-top:2px;">
                                    ${detailParts.join(' \u00B7 ')}
                                </div>
                                ${ev.warnings.length > 0 ? `<div class="vj-text-xs vj-text-muted" style="color:var(--vj-red);line-height:1.4;margin-top:2px;">\u26A0 ${ev.warnings.join(' \u00B7 ')}</div>` : ''}
                                ${ev.strengths.length > 0 ? `<div class="vj-text-xs vj-text-muted" style="color:var(--vj-green);line-height:1.4;margin-top:2px;">\u2713 ${ev.strengths.join(' \u00B7 ')}</div>` : ''}
                                ${(() => {
                                    // Youth potential projection: show projected skills at
                                    // age 20, sourced from the SAME ceilingResult computed
                                    // above (not a second simulation call).
                                    if (p.age < 20) {
                                        const projPrimary = getPrimarySkillInfo(ceilingResult.projectedSkills);
                                        const verdict = classifyProjectedPrimary(projPrimary.value);
                                        const verdictColor = verdict === 'outstanding' || verdict === 'expert' ? 'var(--vj-green)' :
                                            verdict === 'accomplished' ? 'var(--vj-blue)' :
                                            verdict === 'reliable' ? 'var(--vj-gold)' : 'var(--vj-red)';
                                        return `<div class="vj-text-xs" style="color:${verdictColor};line-height:1.4;margin-top:2px;">\ud83d\udd2e Projected at 20: ${projPrimary.name === 'keeping' ? 'Keep' : projPrimary.name === 'bowling' ? 'Bowl' : 'Bat'} ${skillLabel(projPrimary.value)} \u00B7 Tech ${skillLabel(ceilingResult.projectedSkills.technique)} \u00B7 Field ${skillLabel(ceilingResult.projectedSkills.fielding)} (${verdict})</div>`;
                                    }
                                    return '';
                                })()}
                                ${compareHtml}
                                ${fairPriceLine(p)}
                            </div>`;
                        });
                    }
                    return html;
                }

                resultsEl.innerHTML = renderTransferResults(priorityBuys, evaluated.length, ageFiltered, verdictFiltered, false);

                // Wire up fetch details button
                const fetchBtn = document.getElementById('ftp-fetch-details-btn');
                if (fetchBtn) {
                    fetchBtn.addEventListener('click', async () => {
                        fetchBtn.disabled = true;
                        fetchBtn.textContent = '\u21BB Fetching...';
                        await fetchTransferPlayerDetails(priorityBuys, (idx, total) => {
                            fetchBtn.textContent = `\u21BB Fetching ${idx + 1}/${total}...`;
                        });
                        // Re-evaluate with fetched experience/wage/talents
                        priorityBuys.forEach(p => {
                            const ev = evaluateTransferTarget(p, squadStats);
                            ev.rank = calculateRank(p, squadStats);
                            p.eval = ev;
                            // Role doesn't change from the detail fetch, but
                            // candidateRank can shift slightly with real
                            // experience now known — recompute for consistency
                            // with the same isWorthShowing gate used above.
                            p.peerCompare = comparePlayerToSquadPeers(p, seniorPlayers);
                        });
                        // Recompute Dynasty + Overall Rating now that wage/
                        // talent are known (they feed the rating's value and
                        // talent terms), then re-sort the same way as the first
                        // pass so the list stays ordered by best player.
                        priorityBuys.forEach(computeCandidateRating);
                        priorityBuys.sort((a, b) =>
                            (b._overallRating && b._overallRating.score || 0) - (a._overallRating && a._overallRating.score || 0) ||
                            (verdictOrder[a.eval.verdict] ?? 9) - (verdictOrder[b.eval.verdict] ?? 9) ||
                            (a.price || 0) - (b.price || 0));
                        logSquadGapDiagnostic(priorityBuys.filter(p => ageYears(p.age) >= 21));
                        // Re-filter with the exact same rule as the initial
                        // pass (elite + genuine squad upgrade for seniors).
                        const reFiltered = priorityBuys.filter(isWorthShowing);
                        const reAgeFiltered = priorityBuys.filter(p => { const age = ageYears(p.age); return age >= 21 && age > SENIOR_MAX_AGE; }).length;
                        const reVerdictFiltered = priorityBuys.length - reAgeFiltered - reFiltered.length;
                        resultsEl.innerHTML = renderTransferResults(reFiltered, evaluated.length, reAgeFiltered, reVerdictFiltered, true);
                    });
                }
            } else {
                resultsEl.innerHTML = '<div class="vj-text-sm vj-text-muted">No results found. Use the search form above to find players.</div>';
            }
        }

        // Budget display
        const budgetEl = document.getElementById('ftp-transfer-finance');
        if (financeInfo) {
            const bFunds = financeInfo.availableFunds || 0;
            const bNet = financeInfo.weeklyNet || 0;
            budgetEl.innerHTML = `<div class="ftp-info-box ${bFunds > 20000 ? 'success' : bFunds > 5000 ? 'warn' : 'danger'}">
                <div class="ftp-stat-row"><span class="ftp-stat-label">Available Funds</span><span class="ftp-stat-value" style="font-weight:700;">$${bFunds.toLocaleString()}</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Weekly Net</span><span class="ftp-stat-value" style="color:${bNet >= 0 ? 'var(--vj-green)' : 'var(--vj-red)'};">$${bNet.toLocaleString()}/wk</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Senior Squad</span><span class="ftp-stat-value">${seniorPlayers.length} players</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Senior Wages</span><span class="ftp-stat-value">$${(financeInfo.seniorWages || 0).toLocaleString()}/wk</span></div>
            </div>`;
        } else {
            budgetEl.innerHTML = '<div class="vj-text-sm vj-text-muted">Visit Finances page to load budget data.</div>';
        }

        // Recommended target filters — senior vs youth split
        const targetsEl = document.getElementById('ftp-transfer-targets');
        const funds = financeInfo?.availableFunds || 0;
        const weeklyIncome = financeInfo?.weeklyIncome || 0;
        const weeklyNet = financeInfo?.weeklyNet || 0;

        // Senior: don't blow your load on one player
        // Based on community data: 16yo min wage=$500, 20yo skilled=$3K-10K/wk
        // Price: opening bids $0-$2K, decent players $5K-20K, elite $100K+
        const seniorMaxPrice = Math.min(Math.round(funds * 0.10), 20000);
        const seniorMaxWage = Math.min(Math.round(weeklyIncome * 0.15), 5000);
        // Youth: wage varies hugely by age and skill level
        // Community data: 16yo avg=$1,000, 17yo capable=$2,100, 18yo reliable=$3,500, 19yo accomplished=$4,000, 20yo outstanding=$10,351
        const youthMaxPrice = Math.min(Math.round(funds * 0.05), 5000);
        const youthMaxWage = Math.min(Math.round(weeklyIncome * 0.05), 12000);

        targetsEl.innerHTML = `<div class="ftp-info-box success">
            <div class="vj-fw-700 vj-mb-4">Transfer Search Filters</div>
            <div style="line-height:2;">
                <div class="ftp-stat-row"><span class="ftp-stat-label">Senior Max Price</span><span class="ftp-stat-value">$${seniorMaxPrice.toLocaleString()} <span class="vj-text-xs vj-text-muted">(10% of $${funds.toLocaleString()}, cap $20K)</span></span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Senior Max Wage</span><span class="ftp-stat-value">$${seniorMaxWage.toLocaleString()}/wk <span class="vj-text-xs vj-text-muted">(15% of $${weeklyIncome.toLocaleString()}/wk)</span></span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Youth Max Price</span><span class="ftp-stat-value">$${youthMaxPrice.toLocaleString()} <span class="vj-text-xs vj-text-muted">(5% of balance, cap $5K)</span></span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Youth Max Wage</span><span class="ftp-stat-value">$${youthMaxWage.toLocaleString()}/wk <span class="vj-text-xs vj-text-muted">(5% of income, cap $12K)</span></span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Youth Age Range</span><span class="ftp-stat-value">16-20 years (evaluated against age curve)</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Senior Age Range</span><span class="ftp-stat-value">21-27 years (peak at 25-27, decline starts 28+)</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Priority Bowlers</span><span class="ftp-stat-value">Fast (rf/lf), Wrist Spin (rws/lws), Medium-Fast</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Priority Batters</span><span class="ftp-stat-value">High Technique, Power hitters, Top-order</span></div>
                <div class="ftp-stat-row"><span class="ftp-stat-label">Look For</span><span class="ftp-stat-value">Gifted/Prodigy talents, Natural Leaders</span></div>
                <div class="vj-text-xs vj-text-muted vj-mt-8" style="border-top:1px solid var(--vj-border);padding-top:6px;">
                    <strong>Evaluation thresholds:</strong><br>
                    Youth (16-20): Evaluated against age curve. ANY skill below target = filtered.<br>
                    Senior 21-23: Primary Expert, Technique Expert, Fielding Accomplished, Endurance Average, Experience Average.<br>
                    Senior 24-27: Primary Expert, Technique Expert, Fielding Accomplished, Endurance Reasonable, Experience Reasonable.<br>
                    Seniors 27+ filtered (past prime). All results sorted: Elite &gt; Strong &gt; Adequate.
                </div>
            </div>
            ${weeklyNet < 0 ? `<div class="ftp-alert danger" style="margin-top:6px;">Weekly net is negative ($${weeklyNet.toLocaleString()}/wk) \u2014 keep bids low until income improves.</div>` : ''}
        </div>
        <div class="vj-text-xs vj-text-muted vj-mt-4">Set these on the transfer form. Senior/youth limits are separate. Targets are evaluated against your actual squad below.</div>`;

        // Squad-based comparison — what the advisor actually uses
        let squadHtml = '';
        if (squadStats) {
            squadHtml = `<div class="ftp-info-box" style="border-left:3px solid var(--vj-gold);">
                <div class="vj-fw-700 vj-mb-4">Your Squad baselines (senior players)</div>
                <div style="line-height:2;">
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Players</span><span class="ftp-stat-value">${squadStats.count} (Batters: ${squadStats.batterCount} \u00B7 Bowlers: ${squadStats.bowlerCount} \u00B7 ARs: ${squadStats.allrounderCount} \u00B7 WKs: ${squadStats.keeperCount})</span></div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Avg / Min Batting</span><span class="ftp-stat-value">${skillLabel(Math.round(squadStats.avgBatting))} / ${skillLabel(squadStats.minBatting)}</span></div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Avg / Min Bowling</span><span class="ftp-stat-value">${skillLabel(Math.round(squadStats.avgBowling))} / ${skillLabel(squadStats.minBowling)}</span></div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Avg / Min Technique</span><span class="ftp-stat-value">${skillLabel(Math.round(squadStats.avgTechnique))} / ${skillLabel(squadStats.minTechnique)}</span></div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Avg / Min Fielding</span><span class="ftp-stat-value">${skillLabel(Math.round(squadStats.avgFielding))} / ${skillLabel(squadStats.minFielding)}</span></div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Avg / Min Endurance</span><span class="ftp-stat-value">${skillLabel(Math.round(squadStats.avgEndurance))} / ${skillLabel(squadStats.minEndurance)}</span></div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Avg / Min Rating</span><span class="ftp-stat-value">${squadStats.avgRating} / ${squadStats.minRating}</span></div>
                </div>
            </div>`;
            squadHtml += '<div class="vj-text-xs vj-text-muted vj-mt-4">Transfer targets are compared against these. Only players better than your current squad in at least one skill are flagged as priority buys.</div>';
        } else {
            squadHtml = '<div class="ftp-alert warning">Visit Squad page to load player data \u2014 needed for squad-based comparison.</div>';
        }
        targetsEl.innerHTML += squadHtml;

        // Strategy guide
        document.getElementById('ftp-transfer-strategy').innerHTML = `<div class="ftp-info-box" style="border-left:3px solid var(--vj-blue);">
            <div class="vj-fw-700 vj-mb-4">Community Transfer Strategy</div>
            <div class="vj-text-xs" style="line-height:2;">
                <div class="vj-fw-700">What to Buy:</div>
                <div>\u2022 Young players (16-20) \u2014 they train faster and develop longer</div>
                <div>\u2022 Prime seniors (21-27) \u2014 peak performance years, immediate impact</div>
                <div>\u2022 Players with <span class="vj-fw-700">Gifted</span> or <span class="vj-fw-700">Prodigy</span> talents \u2014 +20% training speed per matching talent</div>
                <div>\u2022 <span class="vj-fw-700">Fast bowlers</span> and <span class="vj-fw-700">wrist spinners</span> \u2014 rarest types, highest match impact</div>
                <div>\u2022 Players with <span class="vj-fw-700">high Technique</span> relative to primary \u2014 technique amplifies all performances</div>
                <div>\u2022 Players with <span class="vj-fw-700">Natural Leader</span> talent \u2014 captaincy helps wicket-taking</div>

                <div class="vj-fw-700 vj-mt-4">When to Sell:</div>
                <div>\u2022 Age 30+ with declining skills \u2014 skills decline faster each year past 30</div>
                <div>\u2022 High wage, low contribution \u2014 wasted budget</div>
                <div>\u2022 Hold players 100+ days before selling for 100% proceeds</div>
                <div>\u2022 Youth aging out (21) who won't make senior team \u2014 sell before auto-promotion</div>

                <div class="vj-fw-700 vj-mt-4">Squad Size Rules:</div>
                <div>\u2022 Optimal senior squad: <span class="vj-fw-700">14-15 players</span> (avoids wasted wages)</div>
                <div>\u2022 Max efficient squad: <span class="vj-fw-700">25 players</span> per squad \u2014 over 25 = 7.5% penalty per extra</div>
                <div>\u2022 Min senior wage bill: $30,000/week (charged even if lower)</div>
                <div>\u2022 Listing fee: $1,000 per player (charged even if unsold)</div>

                <div class="vj-fw-700 vj-mt-4">Financial Triggers:</div>
                <div>\u2022 2 weeks in debt = warning</div>
                <div>\u2022 4 weeks in debt = highest-wage player auto-listed</div>
                <div>\u2022 Cannot bid while in debt</div>
                <div>\u2022 Finance cap: $30,000,000</div>
            </div>
        </div>`;
    }

    // Ranked SENIOR sell list for the Squad Plan — who to sell first, by
    // urgency (depth/age/weakness), shown directly in the plan.
    // Returns HTML; empty HTML when nobody's flagged.
    function buildSeniorSellRanking(seniors, squadStats, seniorOver) {
        if (!seniors || seniors.length === 0) return '';
        const avg = (arr, key) => arr.length ? arr.reduce((s, p) => s + (p[key] || 0), 0) / arr.length : 0;
        const avgRating = avg(seniors, 'rating');
        const surplusMap = squadStats ? computeRoleSurplus(seniors, squadStats) : new Map();
        const dynastyAcademyInfo = loadAcademyCache();
        const dynastySquadContext = { size: seniors.length, academyInfo: dynastyAcademyInfo, financeInfo: loadFinanceCache() };

        const scored = seniors.map(p => {
            let s = 0;
            const reasons = [];
            const primary = getPrimarySkillInfo(p).value;
            if (p.age >= 30) s += 10; else if (p.age >= 28) s += 5;
            if (primary < 5) { s += 15; reasons.push(`Primary ${skillLabel(primary)} — too weak for senior cricket`); }
            else if (primary < 7) { s += 10; reasons.push(`Primary ${skillLabel(primary)} — below standard`); }
            if ((p.technique || 0) < 5) s += 10;
            if (avgRating > 0 && (p.rating || 0) < avgRating * 0.5) s += 15;
            const surplus = surplusMap.get(p.id);
            if (surplus && surplus.isSurplus) {
                const overBy = surplus.positionInRole - surplus.roleTarget;
                s += overBy === 1 ? 12 : overBy === 2 ? 9 : 6;
                const roleLabel = surplus.role === 'keeping' ? 'keeper' : surplus.role === 'bowling' ? 'bowler' : 'batter';
                reasons.push(`Depth: #${surplus.positionInRole} of ${surplus.roleCount} ${roleLabel}s (target ~${surplus.roleTarget})`);
            }
            s -= seniorTalentProtection(p);
            if (p.isCaptain) s -= 5;
            if (p.role === 'WK' || (p.keeping || 0) >= 6) s -= 5;
            if (['rf','lf'].includes(p.bowlerType)) s -= 8;
            else if (['rfm','lfm','rws','lws'].includes(p.bowlerType)) s -= 5;
            return { player: p, s, reasons };
        }).filter(r => r.s > 0).sort((a, b) => b.s - a.s);

        if (scored.length === 0) return '';
        const showCount = Math.min(scored.length, Math.max(1, seniorOver || 3));
        const shown = scored.slice(0, showCount);
        let html = `<div class="vj-text-xs vj-text-muted" style="margin-top:6px;">\u{1F4E4} <strong>Sell first (by urgency):</strong></div>`;
        shown.forEach((r, i) => {
            const sev = r.s >= 20 ? 'critical' : r.s >= 10 ? 'high' : 'medium';
            const cause = r.reasons.length ? r.reasons.join(' · ') : `sellScore ${r.s}`;
            html += `<div class="vj-text-xs" style="color:var(--vj-${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'muted'});margin-top:2px;">${i + 1}. <strong>${r.player.name}</strong> (${formatAgeDisplay(r.player.age)}, ${skillLabel(getPrimarySkillInfo(r.player).value)}) — ${cause}</div>`;
        });
        if (scored.length > showCount) html += `<div class="vj-text-xs vj-text-muted" style="margin-top:2px;">+ ${scored.length - showCount} more (expand Sell Candidates below)</div>`;
        return html;
    }

    // Ranked YOUTH sell list for the Squad Plan — who to sell/retire first.
    // Behind-curve prospects (failing YOUTH_DEV_CURVE minimums) ranked
    // highest, priority down.
    function buildYouthSellRanking(youth, allPlayers, squadStats) {
        if (!youth || youth.length === 0) return '<div class="vj-text-xs vj-text-muted" style="margin-top:4px;">No youth in cached squad \u2014 the youth squad is on a separate page.</div>';
        const dynastyAcademyInfo = loadAcademyCache();
        const dynastySquadContext = { size: (allPlayers || []).length, academyInfo: dynastyAcademyInfo, financeInfo: loadFinanceCache() };

        const scored = youth.map(p => {
            let s = 0;
            const reasons = [];
            const ydEval = evaluateYouthDevelopment(p);
            const behindStats = ydEval ? ydEval.rows.filter(r => r.status === 'behind') : [];
            if (behindStats.length >= 2) { s += 15; reasons.push(`Behind on ${behindStats.length} stats (${behindStats.map(r => r.label).join(', ')})`); }
            else if (behindStats.length === 1) { s += 8; reasons.push(`Behind on ${behindStats[0].label}`); }
            if (p.age >= 20 && behindStats.length >= 1) { s += 20; reasons.push('Age 20 — final youth year, behind curve'); }
            if (p.age >= 19 && ydEval && ydEval.rows[0] && ydEval.rows[0].status === 'behind' && (ydEval.rows[0].min - ydEval.rows[0].value) >= 2) { s += 15; reasons.push('Primary well behind target — unlikely to catch up'); }
            const overallSkill = ((p.batting||0) + (p.bowling||0) + (p.technique||0) + (p.fielding||0)) / 4;
            if (overallSkill < 4) { s += 10; reasons.push('Very low overall skill'); }
            if (ydEval && behindStats.length === 0 && ydEval.rows.some(r => r.status === 'ahead')) s -= 10;
            s -= youthTalentProtection(p);
            // Ceiling still can't clear the current weakest same-role senior.
            // Projected to age 25 (the SAME senior-comparable horizon the
            // overall rating uses — computePlayerCeiling's 4th param) so a
            // youth is judged on the senior they'll become, not truncated
            // at the age-20 promotion boundary. A to-20 ceiling would flag
            // every mid-teen as "won't catch up" even when their realistic
            // post-20 training would clear the squad floor — the exact
            // inconsistency this check exists to avoid.
            const rolePeers = (allPlayers || []).filter(sp => sp.age >= 21 && getPrimarySkillInfo(sp).name === getPrimarySkillInfo(p).name);
            const ceilingResult = computePlayerCeiling(p, getAcademySpeedForPlayer(p, dynastyAcademyInfo), dynastySquadContext, 25);
            if (rolePeers.length > 0) {
                const peerFloor = Math.min(...rolePeers.map(computePlayerValueSkillSum));
                if (ceilingResult.ceiling < peerFloor) { s += 12; reasons.push(`Ceiling (${ceilingResult.ceiling.toFixed(1)}) below weakest senior ${getPrimarySkillInfo(p).name === 'keeping' ? 'keeper' : getPrimarySkillInfo(p).name === 'bowling' ? 'bowler' : 'batter'}`); }
            }
            return { player: p, s, reasons };
        }).filter(r => r.s > 0).sort((a, b) => b.s - a.s);

        if (scored.length === 0) return '<div class="vj-text-xs vj-text-muted" style="margin-top:4px;">All youth on track or ahead of the curve \u2014 no urgent sells.</div>';
        let html = `<div class="vj-text-xs vj-text-muted" style="margin-top:6px;">\u{1F331} <strong>Sell/retire first (behind the curve):</strong></div>`;
        scored.forEach((r, i) => {
            const sev = r.s >= 20 ? 'critical' : r.s >= 10 ? 'high' : 'medium';
            const cause = r.reasons.length ? r.reasons.join(' · ') : `score ${r.s}`;
            html += `<div class="vj-text-xs" style="color:var(--vj-${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'muted'});margin-top:2px;">${i + 1}. <strong>${r.player.name}</strong> (age ${ageYears(r.player.age)}, ${skillLabel(getPrimarySkillInfo(r.player).value)}) — ${cause}</div>`;
        });
        return html;
    }

    // Recommended senior squad shape for a competitive matchday XI plus
    // realistic rotation/injury cover — NOT a game-enforced rule (the
    // only real squad-size rule is the 25-player training-efficiency
    // penalty, far above this). It's an operating target so "who's
    // actually excess" has a real answer even when every player
    // individually looks fine, which was the reported gap: a squad of
    // 16 good players had nobody to flag. 1 starting keeper + 1 backup,
    // ~6 bowlers for seam/spin variety and rotation (matches the
    // manual's own advice — "a balanced bowling attack including a mix
    // of left and right handed spinners and seam bowlers will in
    // general perform slightly better"), ~6 batters for the order plus
    // a spare. Sums to ~14, matching the 13-14 target asked for.
    const SENIOR_ROLE_TARGETS = { keeping: 2, bowling: 6, batting: 6 };

    // Ranks each senior within their own primary-role group (best to
    // worst, via calculateRank — the same quality metric transfer
    // scouting uses) and flags anyone past the role's healthy-depth
    // target as squad surplus. This is what makes "16 good players, who
    // do I cut" answerable: a decent 4th-string bowler behind three
    // better ones is surplus even though nothing about him individually
    // is bad — the same logic a real selector uses.
    function computeRoleSurplus(seniors, squadStats) {
        const roles = { batting: [], bowling: [], keeping: [] };
        seniors.forEach(p => { roles[getPrimarySkillInfo(p).name].push(p); });
        const surplusMap = new Map();
        Object.entries(roles).forEach(([role, group]) => {
            const ranked = [...group].sort((a, b) => calculateRank(b, squadStats) - calculateRank(a, squadStats));
            ranked.forEach((p, idx) => {
                surplusMap.set(p.id, {
                    role, roleCount: group.length, roleTarget: SENIOR_ROLE_TARGETS[role],
                    positionInRole: idx + 1, isSurplus: idx >= SENIOR_ROLE_TARGETS[role]
                });
            });
        });
        return surplusMap;
    }

    // Real talents make a player harder to replace even when their raw
    // numbers put them near the bottom of a role group — a squad trim
    // shouldn't casually sell your only Skilled bowler just because he's
    // 4th-ranked. Applied as a silent score reduction (like the existing
    // captain/allrounder/bowler-type bonuses below), not surfaced as a
    // "reason to sell" since it's the opposite of one.
    function seniorTalentProtection(player) {
        const talents = player.talents || [];
        let protect = 0;
        if (talents.some(t => /skilled/i.test(t))) protect += 5;
        if (talents.some(t => /natural leader/i.test(t))) protect += 4;
        if (talents.some(t => /safe hands/i.test(t))) protect += 3;
        if (talents.some(t => /new ball bowler|old ball bowler|^opener$|finisher/i.test(t))) protect += 4;
        if (talents.some(t => /sturdy/i.test(t))) protect += 2;
        return protect;
    }

    // Youth equivalent of seniorTalentProtection(): a training talent
    // (Prodigy especially — trains ALL skills faster while in the youth
    // squad, official manual) makes "behind the curve now" much less
    // predictive of "behind at 20", so it protects a prospect from being
    // flagged for sale. Silent score reduction, same pattern as the senior
    // version — not surfaced as a sell reason since it's the opposite of one.
    function youthTalentProtection(player) {
        const talents = player.talents || [];
        let protect = 0;
        if (talents.some(t => /prodigy/i.test(t))) protect += 15;
        if (talents.some(t => /gifted/i.test(t))) protect += 6;
        if (talents.some(t => /skilled/i.test(t))) protect += 3;
        return protect;
    }

    // SQUAD PLAN — the coherent "who to sell, who to buy, and why"
    // ============================================================
    // This ties the two halves of roster management together into one
    // plan, instead of leaving sell-lists and demand-lists as separate
    // islands:
    //   * SENIOR: current count vs the ~13-14 target, role-by-role vs
    //     SENIOR_ROLE_TARGETS, exactly how many to offload to reach it,
    //     and — crucially — cross-references WHAT you're buying. A
    //     transfer candidate whose peer comparison says "would replace:
    //     <player>" means that player is now a sell when the signing
    //     lands; a transfer-advisor squad gap ("no senior X") names the
    //     hole a buy must fill.
    //   * YOUTH: behind the development curve is a strong sell/retire
    //     signal (youth must meet YOUTH_DEV_CURVE minimums to be worth
    //     carrying to a senior spot — that's the gate for "good future
    //     player"), AND the plan surfaces whether the youth squad has
    //     room to both keep on-track prospects AND recruit replacements
    //     for the ones you cut (never trim below the manual's 12-youth
    //     floor, which otherwise triggers an auto-draft of poor recruits).
    // Returns HTML for the Squad Plan panel section.
    function buildSquadPlan(players) {
        if (!players || players.length === 0) return '<div class="vj-text-sm vj-text-muted">No players found.</div>';
        const seniors = players.filter(p => p.isSenior && p.age >= 21);
        const youth = players.filter(p => p.isYouth && p.age < 21);
        const squadStats = computeSquadStats(players);

        const shape = squadStats ? {
            batters: squadStats.batterCount, bowlers: squadStats.bowlerCount,
            keepers: squadStats.keeperCount, allrounders: squadStats.allrounderCount
        } : null;

        // ── SENIOR half ─────────────────────────────────────────
        const SENIOR_TARGET_TOTAL = SENIOR_ROLE_TARGETS.keeping + SENIOR_ROLE_TARGETS.bowling + SENIOR_ROLE_TARGETS.batting; // 14
        const seniorOver = Math.max(0, seniors.length - SENIOR_TARGET_TOTAL);
        let seniorHtml = '';

        if (shape) {
            const roleRows = [
                `keep ${shape.keepers} (≤${SENIOR_ROLE_TARGETS.keeping})`,
                `bowl ${shape.bowlers} (≤${SENIOR_ROLE_TARGETS.bowling})`,
                `bat ${shape.batters} (≤${SENIOR_ROLE_TARGETS.batting})`
            ];
            seniorHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Senior count</span><span class="ftp-stat-value">${seniors.length} <span class="vj-text-xs vj-text-muted">(target ~${SENIOR_TARGET_TOTAL})</span></span></div>`;
            seniorHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Role split</span><span class="ftp-stat-value vj-text-xs">${roleRows.join(' \u00B7 ')}</span></div>`;
        }

        seniorHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Room for buys</span><span class="ftp-stat-value">${Math.max(0, seniorOver)} over target ${seniorOver > 0 ? `<span style="color:var(--vj-red);">\u2014 sell ${seniorOver} first to make space</span>` : `<span style="color:var(--vj-green);">\u2014 you can add ${Math.max(0, SENIOR_TARGET_TOTAL - seniors.length)} before trimming</span>`}</span></div>`;

        // Tie directly to the transfer advisor's gap analysis: a role
        // under its target is a buying opportunity; a role over is where
        // the sell candidates live.
        if (shape) {
            const under = [];
            if (shape.keepers < SENIOR_ROLE_TARGETS.keeping) under.push(`keeper (${shape.keepers}/${SENIOR_ROLE_TARGETS.keeping})`);
            if (shape.bowlers < SENIOR_ROLE_TARGETS.bowling) under.push(`bowler (${shape.bowlers}/${SENIOR_ROLE_TARGETS.bowling})`);
            if (shape.batters < SENIOR_ROLE_TARGETS.batting) under.push(`batter (${shape.batters}/${SENIOR_ROLE_TARGETS.batting})`);
            const over = [];
            if (shape.keepers > SENIOR_ROLE_TARGETS.keeping) over.push('keeper');
            if (shape.bowlers > SENIOR_ROLE_TARGETS.bowling) over.push('bowler');
            if (shape.batters > SENIOR_ROLE_TARGETS.batting) over.push('batter');
            if (under.length > 0) seniorHtml += `<div class="vj-text-xs" style="color:var(--vj-green);margin-top:4px;">\u{1F4E5} Buy to fill: ${under.join(', ')} (these are transfer-advisor gap/shortage roles)</div>`;
            if (over.length > 0) seniorHtml += `<div class="vj-text-xs" style="color:var(--vj-red);margin-top:4px;">\u{1F4E4} Sell from: ${over.join(', ')} (these are the role groups with depth to spare)</div>`;
        }

        // The actual prioritized SELL list, embedded directly — using the
        // same scoring as buildSeniorSellRanking(), so the plan IS the
        // answer to "who do I sell first", not a summary pointing at a
        // buried collapsible. Show the top surplus/urgency candidates (the
        // ones you'd cut to hit target), best-to-sell first.
        seniorHtml += buildSeniorSellRanking(seniors, squadStats, seniorOver);

        // ── YOUTH half ──────────────────────────────────────────
        let youthHtml = '';
        const youthYd = youth.map(p => ({ p, yd: evaluateYouthDevelopment(p) }));
        const youthBehind = youthYd.filter(x => x.yd && x.yd.overallStatus === 'behind');
        const youthCatching = youthYd.filter(x => x.yd && x.yd.overallStatus === 'catching-up');
        youthHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Youth count</span><span class="ftp-stat-value">${youth.length} <span class="vj-text-xs vj-text-muted">(keep ≥12 to avoid auto-draft)</span></span></div>`;
        youthHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Behind curve</span><span class="ftp-stat-value" style="color:${youthBehind.length > 0 ? 'var(--vj-red)' : 'var(--vj-green)'};">${youthBehind.length} player${youthBehind.length === 1 ? '' : 's'}</span></div>`;
        if (youthCatching.length > 0) {
            youthHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">Catching up</span><span class="ftp-stat-value" style="color:var(--vj-amber);">${youthCatching.length} player${youthCatching.length === 1 ? '' : 's'} <span class="vj-text-xs vj-text-muted">(can still reach targets this age-year)</span></span></div>`;
        }
        youthHtml += `<div class="vj-text-xs vj-text-muted" style="margin-top:4px;line-height:1.5;">Youth must meet the age-based development-curve minimums (primary/technique/fielding against the 16-20 targets) to justify carrying to a senior spot. A stat below target counts as "behind" only if it can't be trained up before the age-year ends — 20.14 for a 20yo. Behind on 2+ stats \u2014 especially at age 19-20 with no time left to catch up \u2014 is a strong sell/retire signal.</div>`;
        // Ranked youth sell list embedded too (same scoring as
        // buildYouthSellRanking) — behind-curve prospects first.
        youthHtml += buildYouthSellRanking(youth, players, squadStats);

        // Dynasty ceilings shown in the embedded sell rankings above use
        // getAcademySpeedForPlayer(), which silently falls back to a
        // generic 100%-speed curve when the Academy page hasn't been
        // cached yet \u2014 a real reported case where a youth's ceiling
        // dropped noticeably (59\u219252) between two loads seconds apart,
        // purely because the academy cache finished loading in between.
        // Not a bug in the math (deterministic given its inputs), but
        // silently misleading without this note \u2014 same pattern as the
        // transfer page's academyContext line.
        const squadPlanAcademyInfo = loadAcademyCache();
        const academyPlanNote = (!squadPlanAcademyInfo || !squadPlanAcademyInfo.level || squadPlanAcademyInfo.level === 'unknown')
            ? `<div class="vj-text-xs" style="color:var(--vj-amber);margin-bottom:6px;">\u26a0 Academy not cached yet \u2014 Dynasty ceilings below use a 100% generic training-speed fallback. Visit the Academy page once for accurate numbers (they can shift once the real speed loads).</div>`
            : '';

        return `<div class="ftp-info-box" style="border-left:3px solid var(--vj-gold);">
            <div class="vj-fw-700 vj-mb-4">Squad Plan \u2014 who to sell vs who to buy</div>
            ${academyPlanNote}
            <div class="vj-fw-700" style="font-size:11px;margin-top:2px;">SENIOR</div>
            ${seniorHtml}
            <div class="vj-fw-700" style="font-size:11px;margin-top:8px;">YOUTH</div>
            ${youthHtml}
            <div class="vj-text-xs vj-text-muted vj-mt-8" style="border-top:1px solid var(--vj-border);padding-top:6px;">Works with the Transfer Advisor: a market candidate whose peer comparison reads \u201cwould replace: &lt;name&gt;\u201d names the senior to move on the moment the signing lands, and the transfer advisor\u2019s squad-gap analysis here tells you which role to target. Sell first, buy into the freed spot.</div>
        </div>`;
    }

    // ============================================================
    // CLUB HOME PAGE UI — Data Status Dashboard
    // Shows freshness of cached data and scouted opponents.
    // ============================================================
    function createClubStatusUI() {
        if (document.getElementById('ftp-advisor-panel')) return;
        createPanel({
            title: 'Club Dashboard', icon: '\u{1F3E0}',
            buttons: [
                { id: 'ftp-refresh', label: '\u21BB All Data', title: 'Fetch fresh data' }
            ],
            sections: [
                { id: 'ftp-club-actions', label: '', icon: '', content: `<div style="text-align:center;">
                    <button id="ftp-update-all" class="ftp-button ftp-button-primary" style="width:100%;padding:10px;font-size:13px;">\u21BB Update All Data</button>
                    <div class="vj-text-xs vj-text-muted vj-mt-4">Fetches squad, academy, finances, ground, and team data in the background.</div>
                </div>` },
                { id: 'ftp-club-scout', label: 'Scout Next Opponent', icon: '\u{1F50D}', iconColor: 'purple' },
                { id: 'ftp-club-status-body', label: 'Data Freshness', icon: '\u{1F4BE}', iconColor: 'teal' },
                { id: 'ftp-club-supporters', label: 'Supporters', icon: '\u{1F465}', iconColor: 'blue' },
                { id: 'ftp-club-opponents', label: 'Scouted Opponents', icon: '\u{1F50D}', iconColor: 'blue' }
            ]
        });

        document.getElementById('ftp-update-all').addEventListener('click', async () => {
            const btn = document.getElementById('ftp-update-all');
            btn.disabled = true;
            try {
                await fetchAllData({ force: true, onProgress: (msg) => { btn.textContent = '\u23F3 ' + msg; } });
                btn.textContent = '\u2705 Updated!';
                updateClubStatusUI();
            } catch (e) {
                console.warn('[FTP Advisor] Update All failed:', e);
                btn.textContent = '\u26A0\uFE0F Some data failed \u2014 see console';
            } finally {
                setTimeout(() => { btn.disabled = false; btn.textContent = '\u21BB Update All Data'; }, 3000);
            }
        });
    }

    function updateClubStatusUI() {
        const body = document.getElementById('ftp-club-status-body');
        if (!body) return;

        const rows = [
            { label: 'Squad (Senior/Youth)', tsKey: CACHE_TIMESTAMP_KEY, staleHours: STALE_SQUAD_HOURS, page: 'Senior/Youth Squad' },
            { label: 'Academy', tsKey: ACADEMY_TIMESTAMP_KEY, staleHours: STALE_ACADEMY_HOURS, page: 'Academies' },
            { label: 'Finances', tsKey: FINANCE_TIMESTAMP_KEY, staleHours: STALE_FINANCE_HOURS, page: 'Finances' },
            { label: 'Ground / Pitches', tsKey: GROUND_TIMESTAMP_KEY, staleHours: STALE_GROUND_HOURS, page: 'Ground' },
            { label: 'Team Info', tsKey: TEAM_INFO_TIMESTAMP_KEY, staleHours: STALE_TEAM_INFO_HOURS, page: 'Club Home' }
        ];

        let html = '<table class="ftp-table"><thead><tr><th>Data</th><th>Last Updated</th><th>Status</th></tr></thead><tbody>';
        rows.forEach(r => {
            const age = getDataAgeText(r.tsKey);
            const stale = isStale(r.tsKey, r.staleHours);
            const never = age === 'Never';
            const badge = never ? 'red' : stale ? 'amber' : 'green';
            const statusText = never ? `Not loaded \u2014 visit ${r.page}` : stale ? 'Stale \u2014 auto-refreshes next visit' : 'Fresh';
            html += `<tr>
                <td class="vj-fw-700">${r.label}</td>
                <td class="vj-text-xs vj-text-muted">${age}</td>
                <td><span class="ftp-stat-badge ${badge}">${statusText}</span></td>
            </tr>`;
        });
        html += '</tbody></table>';
        body.innerHTML = html;

        // Scout Next Opponent section
        const scoutEl = document.getElementById('ftp-club-scout');
        if (scoutEl) {
            scoutEl.innerHTML = '<div class="vj-text-xs vj-text-muted">Loading next fixture...</div>';
            // Fetch teamfixtures page to find the next upcoming match
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.fromthepavilion.org/teamfixtures.htm?teamId=${TEAM_ID}#curr`,
                timeout: 15000,
                onload: function(response) {
                    if (response.status !== 200) {
                        scoutEl.innerHTML = '<div class="vj-text-xs vj-text-muted">Could not load fixtures.</div>';
                        return;
                    }
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(response.responseText, 'text/html');
                    const rows = doc.querySelectorAll('table.data tbody tr');
                    const currentDate = new Date();
                    let nextMatch = null;

                    for (const row of rows) {
                        const dateCell = row.querySelector('td');
                        const classCell = row.querySelector('td:nth-child(2)');
                        const teamsCell = row.querySelector('td:nth-child(3)');
                        if (!dateCell || !teamsCell) continue;

                        const dateText = dateCell.textContent.trim();
                        const matchDate = new Date(dateText.replace(/(\d+) (\w+) (\d+) (\d+):(\d+)/, '$2 $1, $3 $4:$5'));
                        const matchClass = classCell?.querySelector('a')?.textContent.trim() || classCell?.textContent.trim() || '';
                        const teams = teamsCell.textContent.trim();
                        const status = getOrderStatus(row);
                        const gameLink = row.querySelector('a[href*="game.htm?gameId="]')?.href || '';

                        if (status === 'complete' && matchDate < currentDate) continue;
                        if (status === 'complete') continue;

                        nextMatch = { date: dateText, matchClass, teams, gameLink };
                        break;
                    }

                    if (!nextMatch) {
                        scoutEl.innerHTML = '<div class="vj-text-xs vj-text-muted">No upcoming matches found.</div>';
                        return;
                    }

                    const isYouth = nextMatch.matchClass.toLowerCase().includes('youth');
                    scoutEl.innerHTML = `
                        <div class="ftp-rec low" style="padding:8px 10px;">
                            <div class="vj-flex-between">
                                <span class="vj-fw-700" style="font-size:12px;">${nextMatch.teams}</span>
                                <span class="vj-text-xs vj-text-muted">${nextMatch.date}</span>
                            </div>
                            <div class="vj-text-xs vj-text-muted vj-mt-4">${nextMatch.matchClass} ${isYouth ? '<span class="ftp-stat-badge amber" style="font-size:8px;">Youth</span>' : ''}</div>
                            <button id="ftp-scout-next-btn" class="vj-btn vj-btn-sm" style="font-size:11px;padding:4px 8px;margin-top:6px;cursor:pointer;" data-game-url="${nextMatch.gameLink}">\u{1F50D} Scout This Opponent</button>
                            <div id="ftp-scout-status" class="vj-text-xs vj-text-muted vj-mt-4"></div>
                        </div>
                    `;

                    // Attach scout button handler
                    const btn = document.getElementById('ftp-scout-next-btn');
                    if (btn) {
                        btn.addEventListener('click', async () => {
                            btn.disabled = true;
                            btn.textContent = '\u23F3 Loading game page...';
                            const statusEl = document.getElementById('ftp-scout-status');
                            try {
                                const gameUrl = btn.getAttribute('data-game-url');
                                if (!gameUrl || gameUrl === '#') {
                                    btn.textContent = '\u274C No game link found';
                                    return;
                                }
                                const opponentTeamId = await extractOpponentTeamIdFromGame(gameUrl);
                                if (!opponentTeamId) {
                                    btn.textContent = '\u274C No opponent found';
                                    return;
                                }
                                btn.textContent = '\u23F3 Fetching opponent squad...';
                                await fetchOpponentSquad(opponentTeamId);
                                btn.textContent = '\u2705 Squad cached!';
                                if (statusEl) statusEl.innerHTML = `<span class="ftp-stat-badge green">Opponent ${opponentTeamId} scouted successfully</span>`;
                            } catch (err) {
                                console.error('[FTP Advisor] Scout error:', err);
                                btn.textContent = '\u274C Error — check console';
                                if (statusEl) statusEl.innerHTML = `<span class="ftp-stat-badge red">Scout failed</span>`;
                            }
                        });
                    }
                },
                onerror: function() {
                    scoutEl.innerHTML = '<div class="vj-text-xs vj-text-muted">Could not load fixtures.</div>';
                },
                ontimeout: function() {
                    scoutEl.innerHTML = '<div class="vj-text-xs vj-text-muted">Could not load fixtures (timed out).</div>';
                }
            });
        }

        // Supporters section
        const suppEl = document.getElementById('ftp-club-supporters');
        if (suppEl) {
            const teamInfo = loadTeamInfoCache();
            if (teamInfo && teamInfo.supporters > 0) {
                const growthDir = teamInfo.supporterGrowth > 0 ? '+' : teamInfo.supporterGrowth < 0 ? '' : '';
                const growthColor = teamInfo.supporterGrowth > 0 ? 'var(--vj-green)' : teamInfo.supporterGrowth < 0 ? 'var(--vj-red)' : 'var(--vj-muted)';
                suppEl.innerHTML = `<div class="ftp-info-box">
                    <div class="vj-flex-between vj-mb-4">
                        <span class="vj-fw-700">Supporters</span>
                        <span class="ftp-stat-badge blue">${teamInfo.supporters.toLocaleString()}</span>
                    </div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Weekly growth</span><span style="color:${growthColor};font-weight:600;">${growthDir}${teamInfo.supporterGrowth}</span></div>
                    <div class="ftp-stat-row"><span class="ftp-stat-label">Mood</span><span class="vj-fw-600">${teamInfo.mood || 'Unknown'}</span></div>
                    <div class="vj-text-xs vj-text-muted vj-mt-4">Attendance at home matches is roughly 45% of supporters. Capacity must exceed this for full gate revenue.</div>
                </div>`;
            } else {
                suppEl.innerHTML = '<div class="vj-text-sm vj-text-muted">Visit Club Home to load supporter data.</div>';
            }
        }

        // Opponent scouting
        const oppEl = document.getElementById('ftp-club-opponents');
        if (oppEl) {
            try {
                const allKeys = (typeof GM_listValues === 'function') ? GM_listValues() : [];
                // Filter out our own TEAM_ID defensively — a bug in
                // getOpponentTeamId()/extractOpponentTeamIdFromGame()
                // (fixed) used to blindly treat "Home" as the opponent,
                // which is wrong on a home fixture and could have already
                // cached your own squad under the opponent-cache keys.
                // This drops any such stale entry from display even if it
                // was saved before the fix.
                const opponentIds = allKeys
                    .filter(k => k.indexOf(OPPONENT_TIMESTAMP_PREFIX) === 0)
                    .map(k => k.slice(OPPONENT_TIMESTAMP_PREFIX.length))
                    .filter(id => id !== String(TEAM_ID));
                if (opponentIds.length) {
                    const myCache = loadPlayerCache();
                    const myPlayers = myCache ? myCache.players : [];
                    let oppHtml = '';
                    opponentIds.forEach(id => {
                        const age = getDataAgeText(OPPONENT_TIMESTAMP_PREFIX + id);
                        const stale = isStale(OPPONENT_TIMESTAMP_PREFIX + id, STALE_OPPONENT_HOURS);
                        const cached = loadOpponentCache(id);
                        const count = cached ? cached.players.length : 0;
                        if (count === 0) {
                            oppHtml += `<div class="ftp-rec medium" style="padding:6px 8px;margin-bottom:4px;">
                                <div class="vj-flex-between"><span class="vj-fw-700" style="font-size:12px;">Team ${id}</span><span class="ftp-stat-badge red">0 players</span></div>
                            </div>`;
                            return;
                        }

                        const analysis = analyzeOpposition(cached.players, myPlayers);
                        const strengthColor = analysis && analysis.strength === 'elite' ? 'red' : analysis && analysis.strength === 'strong' ? 'amber' : 'green';
                        const strengthLabel = analysis ? analysis.strength.charAt(0).toUpperCase() + analysis.strength.slice(1) : '?';

                        oppHtml += `<div class="ftp-rec ${stale ? 'medium' : 'low'}" style="padding:6px 8px;margin-bottom:4px;">
                            <div class="vj-flex-between">
                                <span class="vj-fw-700" style="font-size:12px;">Team ${id}</span>
                                <div>${analysis ? `<span class="ftp-stat-badge ${strengthColor}" style="font-size:9px;">${strengthLabel}</span>` : ''} <span class="ftp-stat-badge ${stale ? 'amber' : 'green'}" style="font-size:9px;">${age}</span></div>
                            </div>`;

                        if (analysis) {
                            oppHtml += `<div class="vj-text-xs vj-text-muted" style="margin-top:2px;">${count} players \u00B7 Exp ${analysis.avgExp.toFixed(1)} \u00B7 Form ${analysis.avgForm.toFixed(1)} \u00B7 Fatigue ${analysis.avgFatigue.toFixed(1)}</div>`;

                            // Bowling breakdown
                            const bowlParts = [];
                            if (analysis.seamerCount > 0) bowlParts.push(`${analysis.seamerCount} seam`);
                            if (analysis.spinnerCount > 0) bowlParts.push(`${analysis.spinnerCount} spin`);
                            if (analysis.dangerousBowlerCount > 0) bowlParts.push(`<span style="color:var(--vj-red);">\ud83d\udea8 ${analysis.dangerousBowlerCount} dangerous</span>`);
                            if (bowlParts.length > 0) {
                                oppHtml += `<div class="vj-text-xs" style="margin-top:2px;">Bowling: ${bowlParts.join(' + ')}</div>`;
                            }

                            // Tactical insight
                            let tactic = '';
                            if (analysis.pitchVulnerability === 'seam') {
                                tactic = 'Weak seam attack \u2014 prefer spin bowlers';
                            } else {
                                tactic = 'Weak spin attack \u2014 prefer seam bowlers';
                            }
                            if (analysis.isFatigued) tactic += ' \u00B7 Tired squad \u2014 exploit with aggressive batting';
                            if (analysis.inForm) tactic += ' \u00B7 In form \u00B7 expect strong performance';
                            if (analysis.relativeStrength === 'stronger') tactic += ' \u00B7 Stronger than you \u00B7 play cautiously';
                            else if (analysis.relativeStrength === 'weaker') tactic += ' \u00B7 Weaker than you \u00B7 play aggressively';
                            oppHtml += `<div class="vj-text-xs" style="margin-top:2px;color:var(--vj-blue);">${tactic}</div>`;

                            // Dangerous bowler names
                            if (analysis.dangerousBowlerNames.length > 0) {
                                oppHtml += `<div class="vj-text-xs" style="margin-top:2px;color:var(--vj-red);">Danger: ${analysis.dangerousBowlerNames.join(', ')}</div>`;
                            }
                        } else {
                            oppHtml += `<div class="vj-text-xs vj-text-muted">${count} players cached (skills may be hidden)</div>`;
                        }

                        oppHtml += '</div>';
                    });
                    oppEl.innerHTML = oppHtml;
                } else {
                    oppEl.innerHTML = '<div class="vj-text-xs vj-text-muted">No opponent scouting data cached. Use "Scout Next Opponent" above.</div>';
                }
            } catch (e) {
                console.error('[FTP] Opponent display error:', e);
                oppEl.innerHTML = '<div class="vj-text-xs vj-text-muted">Opponent list not available on this userscript manager.</div>';
            }
        }
    }

    // Helper: attach a standard refresh-button handler (orders, ground, academy)
    function _attachRefreshBtn(updateFn) {
        setTimeout(() => {
            const btn = document.getElementById('ftp-refresh');
            if (btn) btn.addEventListener('click', async () => { await fetchAllData({ force: true }); updateFn(); });
        }, 300);
    }

    // ============================================================
    // PLAYER DETAIL ADVISOR — player.htm (any single player: a new
    // youth recruit, an opponent's player, a transfer target, or one
    // of your own squad). Not verified against a live copy of this
    // exact page markup — it extends fetchPlayerPageDetails()'s
    // already-proven label-driven th/td scan (confirmed working in
    // production for Experience/Captaincy/Talents) to the rest of the
    // skill grid, rather than guessing new selectors from scratch. If
    // skills come back all-zero, the UI says so explicitly instead of
    // rendering a false verdict — see the hasFullSkills check below.
    // ============================================================

    // Maps FTP's bowler-type description text ("Right arm Fast medium")
    // to the short code used everywhere else in the script, as a
    // fallback when span.bowlerType (the same widget used on squad
    // pages) isn't present on this page for some reason.
    const BOWLER_TYPE_PHRASES = [
        [/right arm fast medium/i, 'rfm'], [/left arm fast medium/i, 'lfm'],
        [/right arm fast(?!\s*medium)/i, 'rf'], [/left arm fast(?!\s*medium)/i, 'lf'],
        [/right arm medium/i, 'rm'], [/left arm medium/i, 'lm'],
        [/right arm finger spin/i, 'rfs'], [/left arm finger spin/i, 'lfs'],
        [/right arm wrist spin/i, 'rws'], [/left arm wrist spin/i, 'lws']
    ];

    function scrapePlayerDetailPage() {
        const doc = document;
        const nameEl = doc.querySelector('h1, .panel h2, .panel .padded h2');
        const name = nameEl ? escapeHtml(nameEl.textContent.trim()) : 'This player';

        const bowlerTypeSpan = doc.querySelector('span.bowlerType');
        let bowlerType = bowlerTypeSpan ? bowlerTypeSpan.textContent.trim().toLowerCase() : '';

        // Age/rating/wage live in one free-text paragraph, same place
        // fetchPlayerPageDetails() already reads wage from.
        let age = null, rating = 0, wage = 0;
        const paddedPs = doc.querySelectorAll('.panel .padded p');
        if (paddedPs.length > 0) {
            const infoText = paddedPs[0].textContent;
            // Routed through the shared parser (v8.64) — the same 1-based
            // (week-1)/14 convention as every other age scrape. NOTE: this
            // inline duplicate used to claim a "20y14w" player (=21.0, i.e.
            // already 21) must be judged against 21+ thresholds — that was
            // wrong per the user: 20y14w is the FINAL week of being 20
            // (20.93), still a youth who has not turned 21, so the 20yo
            // thresholds are correct.
            const ageMatch = infoText.match(/(\d{1,2})y(\d{1,2})w/);
            if (ageMatch) age = parseGameAge(ageMatch[0]);
            const ratingMatch = infoText.match(/([\d,]+)\s*rating/i);
            if (ratingMatch) rating = parseInt(ratingMatch[1].replace(/,/g, ''), 10) || 0;
            const wageMatch = infoText.match(/\$([\d,]+)\s*wage/i);
            if (wageMatch) wage = parseInt(wageMatch[1].replace(/,/g, ''), 10) || 0;
            if (!bowlerType) {
                for (const [re, code] of BOWLER_TYPE_PHRASES) {
                    if (re.test(infoText)) { bowlerType = code; break; }
                }
            }
        }

        const player = {
            id: (window.location.href.match(/playerId=(\d+)/) || [])[1],
            name, age: age || 0, rating, wage,
            bowlerType, bowlerCategory: BOWLER_CATEGORY[bowlerType] || 'none', bowlerPace: BOWLER_PACE[bowlerType] || 0,
            batting: 0, bowling: 0, keeping: 0, technique: 0, power: 0, fielding: 0, endurance: 0,
            experience: 0, captaincy: 0, talents: [], price: 0,
            fatigue: 10, form: 4, currentTraining: null // safe neutral defaults if not found on page
        };

        const skillLabelMap = {
            batting: 'batting', bowling: 'bowling', keeping: 'keeping', technique: 'technique',
            power: 'power', fielding: 'fielding', endurance: 'endurance', captaincy: 'captaincy', experience: 'experience'
        };
        let skillFieldsFound = 0;
        doc.querySelectorAll('th').forEach(th => {
            const label = th.textContent.trim().toLowerCase();
            const td = th.nextElementSibling;
            if (!td || td.tagName !== 'TD') return;
            const key = skillLabelMap[label];
            if (key) {
                player[key] = parseSkill(td.textContent.trim().toLowerCase());
                skillFieldsFound++;
            } else if (label === 'fatigue') {
                player.fatigue = parseFatigue(td.textContent.trim().toLowerCase());
            } else if (label === 'form') {
                player.form = parseSkill(td.textContent.trim().toLowerCase());
            } else if (label === 'talents' && player.talents.length === 0) {
                const spans = td.querySelectorAll('span.popuphelp');
                spans.forEach(span => {
                    const title = span.getAttribute('title') || '';
                    const t = escapeHtml(title.split('|')[0].trim());
                    if (t) player.talents.push(t);
                });
                if (player.talents.length === 0) {
                    const text = td.textContent.trim();
                    if (text && text !== 'None') player.talents = text.split(',').map(t => escapeHtml(t.trim())).filter(Boolean);
                }
            }
        });

        player.hasFullSkills = skillFieldsFound >= 5; // batting/bowling/technique/power/fielding at minimum
        return player;
    }

    /**
     * Ranks this candidate against the squad players who actually compete
     * for the same spot — same PRIMARY ROLE (batting/bowling/keeping via
     * getPrimarySkillInfo), not same age. Age was the original grouping
     * here, but "does this new signing outrank your other 24-year-olds"
     * is a meaningless question if those 24-year-olds are your bowlers
     * and the candidate is a keeper — a keeper only ever replaces a
     * keeper. Requested explicitly: batsmen, bowlers, and wicketkeepers
     * need to be judged against their own kind.
     * No peers in that role at all (e.g. squad currently has zero
     * specialist keepers) is flagged via `isGap` — that's not "nobody to
     * compare against so ignore this candidate", it's a genuine squad
     * hole, arguably the strongest possible case FOR signing.
     * Returns peers sorted worst-rank-first (best-sell-candidate-first),
     * so a caller can show "if you sign this player, here's who to move
     * on, starting with the clearest cut."
     */
    function comparePlayerToSquadPeers(candidate, squadPlayers) {
        const squadStats = computeSquadStats(squadPlayers);
        const candidateRole = getPrimarySkillInfo(candidate).name; // 'batting' | 'bowling' | 'keeping'
        const peers = squadPlayers.filter(p => p.age >= 21 && getPrimarySkillInfo(p).name === candidateRole);
        const isGap = peers.length === 0;
        const roleLabel = candidateRole === 'keeping' ? 'wicketkeeper' : candidateRole === 'bowling' ? 'bowler' : 'batter';
        const groupLabel = isGap ? `no current ${roleLabel}s — fills a squad gap` : `${roleLabel}`;
        const candidateRank = calculateRank(candidate, squadStats);
        const ranked = peers
            .map(p => ({ player: p, rank: calculateRank(p, squadStats) }))
            .sort((a, b) => a.rank - b.rank);
        const wouldReplace = ranked.filter(r => candidateRank > r.rank);
        return { candidateRank, groupLabel, wouldReplace, allPeers: ranked, squadStats, isGap, role: candidateRole };
    }

    // Short training-program codes matching the workbook's own
    // abbreviations (Refs!C27:C37) — used for the compact week-by-week
    // badges on the Player Advisor.
    const TRAINING_PROGRAM_SHORT_CODE = {
        batting: 'Bt', bowling: 'Bw', battingtech: 'BtT', bowlingtech: 'BwT',
        allrounder: 'AR', keeping: 'K', keeperbatting: 'KB', fielding: 'Fd',
        fitness: 'Ft', strength: 'S', rest: 'R'
    };

    function createPlayerAdvisorUI() {
        createPanel({
            title: 'Player Advisor', icon: '\u{1F464}',
            buttons: [{ id: 'ftp-refresh', label: '↻', title: 'Refresh' }],
            sections: [
                { id: 'ftp-player-verdict', label: 'Recommendation', icon: '⚖️', iconColor: 'blue',
                  content: '<div class="vj-text-sm vj-text-muted">Loading...</div>' },
                { id: 'ftp-player-training', label: 'Training Potential', icon: '\u{1F4C8}', iconColor: 'teal' },
                { id: 'ftp-player-compare', label: 'Squad Comparison', icon: '\u{1F504}', iconColor: 'purple' }
            ]
        });
        document.getElementById('ftp-refresh').addEventListener('click', updatePlayerAdvisor);
    }

    function updatePlayerAdvisor() {
        const verdictEl = document.getElementById('ftp-player-verdict');
        const compareEl = document.getElementById('ftp-player-compare');
        const player = scrapePlayerDetailPage();

        if (!player.hasFullSkills) {
            verdictEl.innerHTML = `<div class="ftp-alert warning"><span>⚠</span><div>Couldn't read this player's skill grid from the page — got ${player.name || 'a player'} but too few skill fields matched. The evaluation below would be unreliable, so it's been skipped. If this keeps happening, the page markup may differ from what this was built against.</div></div>`;
            compareEl.innerHTML = '';
            return;
        }

        const cache = loadPlayerCache();
        const squadPlayers = cache ? cache.players : [];
        // Exclude the player being VIEWED from their own squad comparison —
        // scrapePlayerDetailPage() has no player id to match on, so name is
        // the best available key. Matters more since v8.81's squad-variety
        // check (assessSquadVariety, inside evaluateTransferTarget): without
        // this, a player's own bowler type/handedness would count toward
        // the "already have too many of this type" tally used to judge
        // THEM, which is circular — of course a squad's only left-arm
        // spinner shows up as "1 of 1" when they're counted in their own
        // denominator.
        const squadPlayersExcludingSelf = squadPlayers.filter(p => p.name !== player.name);
        const squadStats = computeSquadStats(squadPlayersExcludingSelf);
        const isYouth = isYouthAge(player.age);
        const evalResult = evaluateTransferTarget(player, squadStats);
        const rank = calculateRank(player, squadStats);
        const keepVerdict = evalResult.verdict === 'poor' || evalResult.verdict === 'weak' ? 'RELEASE' : 'KEEP';
        const badgeClass = keepVerdict === 'KEEP' ? 'green' : 'red';

        // Two projections per render, deliberately different horizons:
        //   * ceilingResult — the NEAR-TERM plan horizon (to-20 for youth /
        //     2-age-year for 20-29 / 1-age-year for 30+), reused by the
        //     Training Potential panel below ("Development plan to age 20").
        //   * dynastyCeiling — the to-25 SENIOR-COMPARABLE horizon (v8.60,
        //     per the user: compare a youth's potential future against the
        //     current 21/22/23yo squad players), which powers the Dynasty
        //     Score line AND the price-independent Overall Rating below.
        //     Both consume the same academy speed + ramp, so they can't
        //     disagree on the data.
        // See computePlayerCeiling()'s own doc comment for why current/
        // ceiling (not value/$K) is the number that's actually safe to
        // compare between a squad player and a market candidate of a
        // different age.
        const academyInfo = loadAcademyCache();
        const academySpeed = getAcademySpeedForPlayer(player, academyInfo);
        const squadContext = { size: squadPlayers.length, academyInfo, financeInfo: loadFinanceCache() };
        const ceilingResult = computePlayerCeiling(player, academySpeed, squadContext);
        const dynastyCeiling = computePlayerCeiling(player, academySpeed, squadContext, 25);
        // Overall Rating — the price-independent quality number, shown the
        // SAME way on an owned player's page as on a transfer card, scored
        // on the to-25 projection for EVERYONE (seniors included; a 21yo is
        // judged on the player he'll be at 25, not his current numbers), so
        // the same player can't be rated higher/lower depending on which
        // page you look at them on. The projection is precomputed here (not
        // inside the rating) so the training simulation still runs once per
        // render.
        const overallRating = computeOverallRating(player, { academySpeed, squadContext, seniorCeiling: dynastyCeiling });

        let html = `<div class="vj-flex-between vj-mb-4">
                <span class="vj-fw-700" style="font-size:14px;">${player.name} <span class="vj-text-xs vj-text-muted">(${formatAgeDisplay(player.age)}yo)</span></span>
                <div style="display:flex;gap:4px;align-items:center;">
                    <span class="ftp-stat-badge ${badgeClass}" style="font-size:13px;">${keepVerdict}</span>
                    ${overallRatingBadge(overallRating)}
                </div>
            </div>
            <div class="vj-text-xs vj-text-muted vj-mb-4">Verdict: ${evalResult.verdict.toUpperCase()} · Rank ${rank}/10 · ${(() => { const pi = getPrimarySkillInfo(player); return pi.value ? (pi.name === 'keeping' ? 'Keep' : pi.name === 'bowling' ? 'Bowl' : 'Bat') + ' ' + skillLabel(pi.value) : ''; })()} · Tech ${skillLabel(player.technique)} · Field ${skillLabel(player.fielding)}${(() => {
                const vpk = computePlayerValuePerK(player);
                return vpk != null ? ` · ${vpk.toFixed(1)} skill/$K` : '';
            })()} ${spareRatingBadge(computeSpareRating(player))}</div>
            <div class="vj-text-xs vj-mb-4"><span class="vj-fw-700">Dynasty Score:</span> ${dynastyCeiling.current.toFixed(1)} now → <span class="vj-fw-700" style="color:var(--vj-gold);">${dynastyCeiling.ceiling.toFixed(1)} ceiling</span> (${dynastyCeiling.label}, age/academy/training-aware — same units as the sell lists and transfer market, safe to compare across ages)</div>
            ${!academyInfo ? `<div class="vj-text-xs" style="color:var(--vj-amber);margin-bottom:4px;">⚠ Academy data not cached yet — Dynasty Score/Overall Rating above are using a 100% generic training-speed fallback, NOT your real academy efficiency. Visit the Academy page once, then reload this page — the ceiling can shift noticeably once the real (usually lower) speed is known.</div>` : ''}`;

        if (evalResult.strengths.length > 0) {
            html += `<div class="vj-text-xs vj-mt-4" style="color:var(--vj-green);">✓ ${evalResult.strengths.join(' · ')}</div>`;
        }
        if (evalResult.warnings.length > 0) {
            html += `<div class="vj-text-xs vj-mt-4" style="color:var(--vj-red);">⚠ ${evalResult.warnings.join(' · ')}</div>`;
        }
        if (isYouth) {
            const yd = evaluateYouthDevelopment(player);
            if (yd) {
                html += `<div class="vj-text-xs vj-mt-8"><span class="vj-fw-700">16-20 development curve:</span> ${yd.overallStatus === 'behind' ? '<span style="color:var(--vj-red);">Behind curve</span>' : yd.overallStatus === 'catching-up' ? `<span style="color:var(--vj-amber);">Catching up — ${yd.rows.filter(r => r.status === 'catching-up').map(r => `${r.label.replace(/\s*\(.*\)/, '')} ${skillLabel(r.value)}→${skillLabel(r.min)}`).join(', ')} reachable within age ${yd.age}</span>` : '<span style="color:var(--vj-green);">On track</span>'}</div>`;
            }
        }
        verdictEl.innerHTML = html;

        // Training potential — shown for every age now, not just youth.
        // Reuses the same verified per-week formula as the Training
        // page's "12wk outlook" (estimateWeeklyTrainingGain/
        // simulateTrainingPlan), not a new model, so it stays consistent
        // with that. Horizon and framing adapt by age: youth get a
        // development plan to age 20; seniors/aging players get a
        // shorter, more relevant outlook since there's no fixed
        // development window left for them.
        const trainingEl = document.getElementById('ftp-player-training');
        if (trainingEl) {
            const trainingRec = recommendTraining(player, squadContext);
            const academyNote = academyInfo ? `your current ${academyInfo.level} academy (${isYouth ? academyInfo.youthEfficiency : academyInfo.seniorEfficiency}% ${isYouth ? 'youth' : 'senior'} training efficiency)` : 'an unknown academy level (visit the Academy page to cache it for a more accurate estimate)';

            let tHtml = `<div class="vj-text-xs vj-text-muted vj-mb-4">Recommended now: <span class="vj-fw-700">${TRAINING_PROGRAM_LABELS[trainingRec.program] || trainingRec.program}</span>${trainingRec.projection && trainingRec.primarySkill ? ` — ${formatTrainingOutlook(trainingRec.projection, trainingRec.primarySkill, player[trainingRec.primarySkill])}` : ''}</div>`;

            // Reuses the plan and horizon already computed above for the
            // Dynasty Score line — see computePlayerCeiling(). Derived
            // from ceilingResult.label (not a separate isYouth ternary
            // here) so the label can never disagree with the actual
            // horizon/weeks the plan below was run for — a player right
            // at the youth/senior boundary (e.g. 20.5yo) gets whichever
            // branch computePlayerCeiling() actually used, consistently.
            const planLabel = ceilingResult.label === 'to age 20' ? 'Development plan to age 20' : `${ceilingResult.label.replace('outlook', 'training outlook')}`;
            const plan = ceilingResult.plan;
            tHtml += `<div class="vj-fw-700 vj-mb-4">${planLabel}</div>`;
            tHtml += `<div class="vj-text-xs vj-mb-4">${plan.timeline.map(t => `<span class="vj-fw-700">${TRAINING_PROGRAM_LABELS[t.program] || t.program}</span> (wk${t.fromWeek}${t.toWeek > t.fromWeek ? `-${t.toWeek}` : ''})`).join(' → ')}</div>`;

            // Week-by-week breakdown — one badge per simulated week,
            // showing exactly which program that week uses (matching the
            // workbook's own Wk0-Wk14 layout), not just the compressed
            // summary above.
            tHtml += `<div class="vj-text-xs vj-fw-700 vj-mb-4">Week by week:</div>`;
            tHtml += `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:10px;">`;
            for (let w = 1; w <= plan.weeks; w++) {
                const prog = plan.weeklyPrograms[w];
                const code = TRAINING_PROGRAM_SHORT_CODE[prog] || '?';
                tHtml += `<span class="ftp-stat-badge neutral" style="font-size:9px;padding:2px 4px;" title="Week ${w}: ${TRAINING_PROGRAM_LABELS[prog] || prog}">${w}:${code}</span>`;
            }
            tHtml += `</div>`;

            tHtml += `<div style="overflow-x:auto;"><table class="ftp-table"><thead><tr><th>Skill</th><th>Now</th><th>Projected</th></tr></thead><tbody>`;
            ADAPTIVE_PLAN_SKILLS.forEach(skill => {
                const before = skillLabel(Math.round(player[skill] || 0));
                const after = skillLabel(plan.finalSkills[skill]);
                if (before === after && plan.finalSkills[skill] === Math.round(player[skill] || 0) && (plan.finalProgress[skill] || 0) === 0) return; // untouched skill, skip
                tHtml += `<tr><td style="text-transform:capitalize;">${skill}</td><td>${before}</td><td>${before === after ? after : `<span class="vj-fw-700">${after}</span>`}</td></tr>`;
            });
            tHtml += '</tbody></table></div>';
            tHtml += `<div class="vj-text-xs vj-text-muted vj-mt-4">Assumes ${academyNote}, week 1's real fatigue then a healthy baseline after (match fatigue isn't simulated — no match schedule to drive it), and re-picks the training program every week using the same staged logic as the live recommendation above.</div>`;
            if (player.age >= 29) {
                tHtml += `<div class="vj-text-xs vj-mt-4" style="color:var(--vj-amber);">⚠ The workbook notes skills actively DECLINE weekly from age 30 (not just train slower), doubling at 31, with endurance declining twice as fast as other skills — confirmed real but no exact rate was found, so this projection does NOT subtract for it and likely overstates outcomes for this player.</div>`;
            }
            trainingEl.innerHTML = tHtml;
        }

        // Squad comparison — who this player would realistically replace.
        // v8.66: shown for EVERY age, matching the transfer cards. The old
        // "youth are development bets, not direct swaps" note sounded like a
        // design decision but in practice just removed the answer to "would he
        // replace anyone?" from under-21 player pages entirely. Peers are
        // senior-squad players of the same role regardless of the player's
        // age — a 20y12w weeks from promotion competes for an XI spot exactly
        // like a 21yo, and a 16yo's future value is gauged against the seniors
        // he'd eventually have to displace.
        if (squadPlayers.length > 0) {
            const cmp = comparePlayerToSquadPeers(player, squadPlayers);
            let cHtml = cmp.isGap
                ? `<div class="vj-text-xs vj-text-muted vj-mb-4">You have no current SENIOR ${cmp.role === 'keeping' ? 'wicketkeepers' : cmp.role === 'bowling' ? 'bowlers' : 'batters'} to compare against (youth in that role aren't counted here) — this player would fill a genuine squad gap. This player ranks ${cmp.candidateRank}/10.</div>`
                : `<div class="vj-text-xs vj-text-muted vj-mb-4">Compared against your squad's ${cmp.groupLabel}s (${cmp.allPeers.length} player${cmp.allPeers.length === 1 ? '' : 's'}). This player ranks ${cmp.candidateRank}/10.</div>`;
            if (cmp.wouldReplace.length > 0) {
                cHtml += `<div class="vj-fw-700 vj-mb-4">Would replace (best sell first):</div>`;
                cmp.wouldReplace.forEach(r => {
                    cHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">${r.player.name}</span><span class="ftp-stat-value">Rank ${r.rank}/10</span></div>`;
                });
            } else if (!cmp.isGap) {
                cHtml += `<div class="vj-text-sm vj-text-muted">Doesn't clearly outrank anyone in this group — not an obvious replacement for your current squad.</div>`;
            }
            compareEl.innerHTML = cHtml;
        } else {
            compareEl.innerHTML = '<div class="vj-text-xs vj-text-muted">No squad data cached yet — visit your Senior Squad page once to enable comparison.</div>';
        }


    }

    // ============================================================
    // INIT — every page fetches fresh data first, then shows advisor
    // ============================================================
    async function init() {
        const pageType = detectPageType();
        console.log('[FTP Advisor] Page:', pageType);
        // Only on teamfixtures.htm (own or opponent — that's where completed
        // match HTML actually gets copied from) per explicit user request;
        // it was cluttering every page before this.
        if (pageType === 'matches') createMatchPasteUI();

        // One-time cleanup: getOpponentTeamId()/extractOpponentTeamIdFromGame()
        // used to blindly treat "Home" as the opponent, which is wrong on a
        // home fixture — could have cached your own squad under the
        // opponent-cache keys, keyed by your own TEAM_ID. That stale entry
        // would keep showing up in opponent scouting forever otherwise.
        if (TEAM_ID) cleanupOpponentCache(TEAM_ID);

        // --- SCRAPE CURRENT PAGE DATA (if on a data page) ---
        // Whether this actually helps depends on which real-time re-fetch
        // path runs below.
        let squadScrapeNeedsBackgroundFix = false;
        if (pageType === 'squad') {
            // Scrape squad from current page DOM immediately
            const players = scrapeSquad();
            if (players.length > 0) {
                const urlParams = new URLSearchParams(window.location.search);
                const teamId = urlParams.get('teamId');
                // The squad nav link (Club > Senior/Youth Squad) has no
                // squadViewId param, which defaults to the Overall Summary
                // view — no skill columns at all (see squadViewId=1 in the
                // Map section). scrapeSquad() always uses the grid parser
                // regardless of which view actually loaded; on a non-grid
                // view every stat silently reads as 0. Saving that would
                // overwrite good previously-cached skill data with zeros,
                // and every downstream page (pitch advisor, tactics,
                // training) would then compute off all-0.0 ratings with no
                // visible error. Only save here if the grid was actually
                // present; otherwise fall through to the background
                // fetchAllData(force) below, which fetches the real
                // squadViewId=2 grid regardless of what's on screen.
                const hasRealSkills = players.some(p => p.hasFullSkills);
                if (!teamId || teamId === String(TEAM_ID)) {
                    if (hasRealSkills) {
                        savePlayerCache(players);
                    } else {
                        console.warn('[FTP Advisor] Squad page has no skill columns (likely not squadViewId=2) — skipping cache save from this page, forcing a background grid re-fetch instead.');
                        squadScrapeNeedsBackgroundFix = true;
                    }
                } else {
                    saveOpponentCache(teamId, players);
                }
            }
        } else if (pageType === 'academy') {
            scrapeAcademyPage();
        } else if (pageType === 'finance') {
            scrapeFinancePage();
        } else if (pageType === 'club') {
            scrapeClubPage();
        } else if (pageType === 'youthrecruit') {
            // Youth recruit page has no player data to scrape, but ensure squad cache is loaded
        }

        // --- FETCH ALL STALE DATA in background ---
        // This ensures recommendations always use fresh data.
        // The orders page is the one exception where "stale-check only"
        // isn't good enough: tactics advice is only as good as the
        // squad/opponent/pitch data behind it, so on this page we force
        // a real refresh every time rather than trusting a cache that
        // could be hours old. Squad pages normally skip this too (the
        // immediate DOM scrape above is enough) — EXCEPT when that scrape
        // just found a non-grid view with no real skill data, in which
        // case a real background fetch of the actual grid view is the
        // only way to fix the cache.
        if (pageType !== 'squad' || squadScrapeNeedsBackgroundFix) {
            const forceForSquadFix = pageType === 'squad' && squadScrapeNeedsBackgroundFix;
            // Force here too: the cache timestamp may have just been
            // written moments ago (possibly with the bad zero-skill data
            // this branch exists to fix), so a plain staleness check
            // could skip the very re-fetch that's needed.
            const forceRefresh = pageType === 'orders' || forceForSquadFix;
            fetchAllData({ force: forceRefresh }).then(() => {
                // Re-run the advisor after data is refreshed
                if (pageType === 'orders') updateOrdersAdvisor();
                else if (pageType === 'training') updateTrainingAdvisor();
                else if (pageType === 'ground') updateGroundAdvisor();
                else if (pageType === 'academy') updateAcademyAdvisor();
                else if (pageType === 'youthrecruit') updateYouthRecruitAdvisor();
                else if (pageType === 'club') updateClubStatusUI();
                else if (pageType === 'squad') updateSquadAdvisor();
                // transfer.htm/player.htm trigger the same background
                // fetchAllData() as every non-squad page, but were once
                // missing from this re-render list — so their advisors ran
                // once against the page-load cache and never re-ran after
                // the fresh fetch landed minutes later, keeping a stale
                // squad-peer comparison on screen regardless of how correct
                // the classification logic was. Both must re-run here.
                else if (pageType === 'transfer') updateTransferAdvisor();
                else if (pageType === 'player') updatePlayerAdvisor();
            }).catch(e => console.warn('[FTP Advisor] Background refresh failed:', e));
        }

        // --- PAGE-Specific UI ---
        if (pageType === 'orders') {
            createOrdersUI();
            updateOrdersAdvisor();

            _attachRefreshBtn(updateOrdersAdvisor);
            setTimeout(() => {
                const loadOppBtn = document.getElementById('ftp-load-opponent');
                if (loadOppBtn) {
                    loadOppBtn.addEventListener('click', async () => {
                        const opponentTeamId = getOpponentTeamId();
                        if (!opponentTeamId) {
                            alert('Could not detect opponent team ID.');
                            return;
                        }
                        loadOppBtn.disabled = true;
                        loadOppBtn.textContent = 'Loading...';
                        try {
                            await fetchOpponentSquad(opponentTeamId);
                            updateOrdersAdvisor();
                        } catch (err) {
                            alert('Failed: ' + err.message);
                        } finally {
                            loadOppBtn.disabled = false;
                            loadOppBtn.textContent = 'Load Opponent Squad';
                        }
                    });
                }
            }, 500);
        } else if (pageType === 'squad') {
            createSquadUI();
            const checkTable = () => {
                if (document.querySelector('table#squad tbody tr')) {
                    updateSquadAdvisor();
                } else {
                    setTimeout(checkTable, 200);
                }
            };
            checkTable();
        } else if (pageType === 'ground') {
            scrapeGroundPage();
            createGroundUI();
            updateGroundAdvisor();
            _attachRefreshBtn(updateGroundAdvisor);
        } else if (pageType === 'training') {
            createTrainingUI();
            const checkTable = () => {
                if (document.querySelector('table tbody tr')) {
                    updateTrainingAdvisor();
                } else {
                    setTimeout(checkTable, 200);
                }
            };
            checkTable();
        } else if (pageType === 'matches') {
            createMatchesUI();
            updateMatchesAdvisor();
        } else if (pageType === 'academy') {
            createAcademyAdvisorUI();
            updateAcademyAdvisor();
            _attachRefreshBtn(updateAcademyAdvisor);
        } else if (pageType === 'youthrecruit') {
            createYouthRecruitAdvisorUI();
            updateYouthRecruitAdvisor();
        } else if (pageType === 'transfer') {
            createTransferAdvisorUI();
            updateTransferAdvisor();
        } else if (pageType === 'club') {
            createClubStatusUI();
            updateClubStatusUI();
            _attachRefreshBtn(async () => { await fetchAllData({ force: true }); updateClubStatusUI(); });
        } else if (pageType === 'player') {
            createPlayerAdvisorUI();
            updatePlayerAdvisor();
            _attachRefreshBtn(updatePlayerAdvisor);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
