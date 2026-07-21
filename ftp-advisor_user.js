// ==UserScript==
// @name         FTP Advisor
// @namespace    http://tampermonkey.net/
// @version      8.4
// @description  Comprehensive tactical advisor for From the Pavilion cricket game (v7.0: full UI redesign with modern navy+gold theme, reusable createPanel() helper, stat badges, rec cards, and component library; v6.6: added a Youth Development Curve check on the Training page; v6.5: fixed finance parsing, removed gold captain highlight, fatigue-aware bowling spell length; v6.4: unstyled panels fixed; v6.3: tactics advisor now loads on game.htm?gameId=...; v6.2: club.htm data-status dashboard; v6.1: training uses age-decay/skill-slowdown/talent-bonus data from the user's FTP_Training model)
// @author       You
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

(function() {
    'use strict';

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

    // ============================================================
    // PRO TIER (scaffold — not wired to any feature yet)
    // Everything currently in this script is pure local computation on
    // data already visible to the user in their own browser. Gating any
    // of it behind a "license check" would be security theater — anyone
    // can read (and strip) the check in Tampermonkey's own source editor
    // — and would rightly get the script flagged as hostile if listed on
    // GreasyFork. So: free tier = 100% of current functionality, always.
    // The only genuinely defensible paid feature is one that CANNOT run
    // client-side at all: cross-device sync of cached squad/training
    // history, multi-season trend tracking, or league-wide benchmarking
    // against other Pro users — anything that requires a server holding
    // state the script itself doesn't have. This block is that scaffold;
    // LICENSE_API_URL is a placeholder, nothing calls validateLicense()
    // yet. Recommended: use a payment processor with a built-in license
    // API (Lemon Squeezy or Gumroad) instead of building your own auth
    // server — they handle payment + license issuance + a validate
    // endpoint for no fixed cost until there's revenue to justify more.
    // ============================================================
    const LICENSE_KEY_CACHE = 'ftp_license_key';
    const LICENSE_VALID_CACHE = 'ftp_license_valid';
    const LICENSE_API_URL = 'REPLACE_WITH_LICENSE_VALIDATION_ENDPOINT';

    function getStoredLicenseKey() {
        return GM_getValue(LICENSE_KEY_CACHE, null);
    }

    function isProUser() {
        // Reads the last cached validation result — never blocks the UI
        // waiting on a network round-trip. Call validateLicense()
        // separately (e.g. on script load, or a "Refresh Pro Status"
        // button) to keep it current.
        return GM_getValue(LICENSE_VALID_CACHE, false) === true;
    }

    function validateLicense(key) {
        return new Promise((resolve) => {
            if (!key) { resolve(false); return; }
            GM_xmlhttpRequest({
                method: 'POST',
                url: LICENSE_API_URL,
                data: JSON.stringify({ key }),
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
                onload: (response) => {
                    try {
                        const result = JSON.parse(response.responseText);
                        const valid = result.valid === true;
                        GM_setValue(LICENSE_VALID_CACHE, valid);
                        resolve(valid);
                    } catch (e) {
                        resolve(false);
                    }
                },
                onerror: () => resolve(false),
                ontimeout: () => resolve(false)
            });
        });
    }

    // ============================================================
    // AI CENTRAL RECOMMENDATIONS (scaffold — not wired to any UI yet)
    // Architecture: every existing recommend*() function
    // (recommendLineup, recommendTraining, recommendTossDecision, etc.)
    // already computes a rule-based recommendation from real game data.
    // The AI layer should sit ON TOP of that, not replace it — feed the
    // same structured data plus the rule-based verdict as context, and
    // let an LLM synthesize/explain/cross-check, rather than becoming a
    // black box that recomputes everything itself. Deterministic scoring
    // stays the source of truth (free, instant, auditable); the LLM is
    // for what it's actually good at — natural-language synthesis across
    // many signals at once.
    //
    // Three real decisions block wiring this up further — not things I
    // can decide unilaterally:
    // 1. WHICH provider/endpoint (Anthropic/OpenAI/etc) — the request
    //    shape below is a placeholder, not a real API contract.
    // 2. WHERE the API key lives. GM_setValue is local, unencrypted
    //    storage — fine for a user's own key, NOT safe to hardcode a
    //    shared key into a public script. Realistic options: (a) user
    //    pastes their own key via a one-time prompt (same pattern as
    //    getTeamId()), or (b) a thin proxy server you control holding
    //    the real key, which would also double as the Pro-tier license
    //    gate above — "AI recommendations" could BE the paid feature.
    // 3. Cost. LLM calls cost money per request — must be opt-in and
    //    user-triggered, never automatic on page load.
    // ============================================================
    const AI_API_KEY_CACHE = 'ftp_ai_api_key';
    const AI_ENDPOINT_URL = 'REPLACE_WITH_LLM_ENDPOINT';

    function getStoredAIKey() {
        return GM_getValue(AI_API_KEY_CACHE, null);
    }

    // One-time prompt, same pattern as getTeamId(). Not wired to any
    // button yet — provider/endpoint (AI_ENDPOINT_URL) is still a
    // placeholder, so there's nothing for a stored key to call yet.
    // Call this from a settings UI once a provider is chosen.
    function promptForAIKey() {
        const entered = prompt('FTP Advisor: paste your LLM API key (stored locally via GM_setValue, only ever sent to the configured AI endpoint):');
        if (entered && entered.trim()) {
            GM_setValue(AI_API_KEY_CACHE, entered.trim());
            return true;
        }
        return false;
    }

    /**
     * Single assembly point for AI context. Summarizes the same inputs
     * the rule-based advisors already compute (not raw scraped player
     * arrays — too large/noisy) so every future AI feature shares one
     * context shape instead of re-deriving it.
     */
    function buildAIContextSnapshot({ squadStats, matchContext, opponentAnalysis, financeInfo, ruleBasedRecommendation } = {}) {
        return {
            squad: squadStats ? {
                count: squadStats.count, avgPrimary: squadStats.avgPrimary,
                avgTechnique: squadStats.avgTechnique, avgFielding: squadStats.avgFielding,
                bowlerCount: squadStats.bowlerCount, batterCount: squadStats.batterCount,
                allrounderCount: squadStats.allrounderCount, keeperCount: squadStats.keeperCount
            } : null,
            match: matchContext ? {
                format: matchContext.matchType, pitch: matchContext.pitchType,
                weather: matchContext.weather, venue: matchContext.venue
            } : null,
            opposition: opponentAnalysis ? {
                relativeStrength: opponentAnalysis.relativeStrength,
                keyBowler: opponentAnalysis.keyBowler ? opponentAnalysis.keyBowler.name : null
            } : null,
            finances: financeInfo ? {
                availableFunds: financeInfo.availableFunds, weeklyNet: financeInfo.weeklyNet
            } : null,
            // The deterministic advisor's own output — the AI reasons
            // ABOUT this, it does not recompute it from scratch.
            ruleBasedRecommendation: ruleBasedRecommendation || null
        };
    }

    /**
     * Stub — not called from anywhere yet. Sends a context snapshot and
     * a plain-string question to the configured endpoint. Left generic
     * so whatever UI is built on top decides what to ask (explain this
     * lineup, critique this transfer target, season strategy chat, etc).
     */
    function getAICentralRecommendation(prompt, contextSnapshot) {
        return new Promise((resolve, reject) => {
            const apiKey = getStoredAIKey();
            if (!apiKey) { reject(new Error('No AI API key configured')); return; }
            GM_xmlhttpRequest({
                method: 'POST',
                url: AI_ENDPOINT_URL,
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                data: JSON.stringify({ prompt, context: contextSnapshot }),
                timeout: 30000,
                onload: (response) => {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        reject(new Error('Invalid response from AI endpoint'));
                    }
                },
                onerror: () => reject(new Error('AI endpoint request failed')),
                ontimeout: () => reject(new Error('AI endpoint request timed out'))
            });
        });
    }

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

    // Staleness thresholds (hours)
    const STALE_SQUAD_HOURS = 24;
    const STALE_OPPONENT_HOURS = 24;
    const STALE_ACADEMY_HOURS = 168; // 7 days (academy changes rarely)
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
    // FORM / EXPERIENCE MULTIPLIERS
    // Real percentage curves from the user's FTP_Training model
    // (Form-Exp tab), not just ad-hoc linear weights. Verbatim from the
    // sheet — nothing here is interpolated or invented.
    // Reference data only, NOT YET wired into calculateBattingScore/
    // BowlingScore — those have linear weights tuned over many prior
    // versions, and swapping in a multiplicative model needs live-game
    // verification first, not a blind mid-session rewrite.
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
    // AGE-BASED SKILL EXPECTATIONS (community-backed)
    // Based on forum posts, training guides, and player examples
    // from the "How to Train?" thread and Youth Pull competitions.
    //
    // Skill scale: atrocious=0, dreadful=1, poor=2, ordinary=3,
    //   average=4, reasonable=5, capable=6, reliable=7,
    //   accomplished=8, expert=9, outstanding=10
    //
    // Community targets:
    // - Fielding: capable min (age 16-17), reliable (age 18-19)
    // - Technique: average (16), capable (17), reliable (18-19)
    // - Endurance: ordinary (16), capable (18), reliable (20)
    // - Primary skill: average (16), capable (17), reliable (18-19), accomplished (20)
    // ============================================================
    const AGE_SKILL_EXPECTATIONS = {
        // age: { primary (max batting/bowling), technique, fielding }
        // Only these 3 skills are required for youth — endurance/experience don't matter
        16: { primary: 4, technique: 4, fielding: 4 },
        17: { primary: 5, technique: 5, fielding: 5 },
        18: { primary: 6, technique: 6, fielding: 6 },
        19: { primary: 8, technique: 8, fielding: 6 },
        20: { primary: 9, technique: 9, fielding: 8 }
    };

    // Wage expectations by age (community-backed, based on skill levels)
    // 16yo with average skills ≈ $1,000-1,300/wk
    // 17yo with capable skills ≈ $2,000-2,500/wk
    // 18yo with reliable skills ≈ $3,000-4,000/wk
    // 19yo with accomplished skills ≈ $4,000-6,000/wk
    // 20yo with expert/outstanding skills ≈ $10,000+/wk
    const AGE_WAGE_EXPECTATIONS = {
        16: { min: 500, typical: 1000, max: 2000 },
        17: { min: 600, typical: 2100, max: 3000 },
        18: { min: 700, typical: 3500, max: 5000 },
        19: { min: 800, typical: 4500, max: 7000 },
        20: { min: 900, typical: 10000, max: 12000 }
    };

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
        16: { rating: 20000, primary: 4, technique: 2, experience: 1, fielding: 2 },
        17: { rating: 23000, primary: 5, technique: 4, experience: 2, fielding: 2 },
        18: { rating: 24500, primary: 6, technique: 6, experience: 2, fielding: 3 },
        19: { primary: 8, technique: 7, experience: 3, fielding: 4 },
        20: { primary: 9, technique: 7, experience: 3, fielding: 3 },
        21: { primary: 9, technique: 7, experience: 4, fielding: 5 },
        22: { primary: 9, technique: 8, experience: 5, fielding: 6 },
        23: { primary: 10, technique: 10, experience: 6, fielding: 6 },
        24: { primary: 11, technique: 11, experience: 8, fielding: 7 },
        25: { primary: 11, technique: 11, experience: 8, fielding: 8 },
        26: { primary: 11, technique: 11, experience: 8, fielding: 8 },
        27: { primary: 11, technique: 11, fielding: 9, power: 8 },
    };

    /**
     * Check a transfer target (youth or senior) against "the base" —
     * the age-specific scout benchmarks above. This is a HARD filter on
     * ONLY the fields defined for that age (primary, technique,
     * experience, fielding, and where present power/rating) — a player
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
        const age = Math.round(player.age);
        const t = AGE_SCOUT_THRESHOLDS[age] || (age > 27 ? AGE_SCOUT_THRESHOLDS[27] : null);
        if (!t) return { hasBenchmark: false, passed: true, failed: [], met: [] };

        const primary = Math.max(player.batting || 0, player.bowling || 0);
        const checks = [
            { name: 'Primary', value: primary, min: t.primary, known: true },
            { name: 'Technique', value: player.technique || 0, min: t.technique, known: true },
            { name: 'Experience', value: player.experience || 0, min: t.experience, known: (player.experience || 0) > 0 },
            { name: 'Fielding', value: player.fielding || 0, min: t.fielding, known: true },
        ];
        if (t.power != null) checks.push({ name: 'Power', value: player.power || 0, min: t.power, known: true });
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

    function getAgeTrainingMultiplier(age) {
        const clamped = Math.max(16, Math.min(32, Math.round(age)));
        return AGE_TRAINING_MULTIPLIER[clamped] || { primary: 0.20, power: 0.50, endurance: 0.80 };
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
        20: { primary: 9, technique: 9, fielding: 7, fieldingGood: 8,                     // Expert / Reliable→Accomplished
              endurance: 3, experience: 3 }                                               // Ordinary+
    };

    function getYouthPrimarySkillName(player) {
        const isKeeper = player.role === 'WK' || (player.keeping >= 4 && player.keeping > player.bowling);
        if (isKeeper) return 'keeping';
        const isBowler = player.bowlerCategory && player.bowlerCategory !== 'none' && player.bowling >= player.batting;
        return isBowler ? 'bowling' : 'batting';
    }

    // Returns null if the player is outside the tracked age window (16-20)
    // or the target table has nothing for their age. Otherwise returns a
    // per-stat breakdown so the UI can show exactly what's behind/ahead.
    function evaluateYouthDevelopment(player) {
        const age = Math.round(player.age);
        const target = YOUTH_DEV_CURVE[age];
        if (!target) return null;

        const primaryStatName = getYouthPrimarySkillName(player);
        const primaryValue = player[primaryStatName] || 0;
        const rows = [
            { label: `Primary (${primaryStatName})`, value: primaryValue, min: target.primary, good: target.primaryGood },
            { label: 'Technique', value: player.technique || 0, min: target.technique, good: target.techniqueGood },
            { label: 'Fielding', value: player.fielding || 0, min: target.fielding, good: target.fieldingGood }
        ];
        if (primaryStatName === 'keeping') {
            // User's note: wicketkeepers are judged on keeping AND batting, not keeping alone.
            rows.push({ label: 'Batting (WK)', value: player.batting || 0, min: target.primary, good: target.primaryGood });
        }
        if (target.endurance !== undefined) rows.push({ label: 'Endurance', value: player.endurance || 0, min: target.endurance });
        if (target.experience !== undefined) rows.push({ label: 'Experience', value: player.experience || 0, min: target.experience });

        rows.forEach(r => {
            if (r.value < r.min) r.status = 'behind';
            else if (r.good && r.value >= r.good) r.status = 'ahead';
            else r.status = 'on-track';
        });

        return { age, rows, overallStatus: rows.some(r => r.status === 'behind') ? 'behind' : 'on-track' };
    }

    // ============================================================
    // HELPER FUNCTIONS
    // ============================================================
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
        const name = nameLink.textContent.trim();
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
            const m = text.match(/^(\d{1,2})(?:\.\d+)?$/);
            if (m) {
                const val = parseInt(m[1], 10);
                if (val >= 16 && val <= 50) { age = val; break; }
            }
        }

        return {
            id: playerId, name: name,
            bowlerType: bowlerType,
            bowlerCategory: BOWLER_CATEGORY[bowlerType] || 'none',
            bowlerPace: BOWLER_PACE[bowlerType] || 0,
            isLeftHanded: isLeftHanded, age: age,
            hasFullSkills: true,
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
        const name = nameLink.textContent.trim();
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
                if (val >= 16 && val <= 50 && age === 99) age = val;
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

    // ============================================================
    // AGE-BASED SKILL THRESHOLDS for transfer evaluation
    // Derived from community training feedback & forum consensus.
    // Validates that a player's skills match what's expected for
    // their age. Below-threshold = underdeveloped = bad buy.
    // ============================================================
    // Keys: bat = batting min, bowl = bowling min, tech = technique min,
    //       field = fielding min, end = endurance min, exp = experience min
    const AGE_SKILL_THRESHOLDS = {
        16: { bat: 4, bowl: 4, keep: 0, tech: 4, field: 4, end: 3, exp: 3, power: 0 },
        17: { bat: 5, bowl: 5, keep: 0, tech: 5, field: 5, end: 4, exp: 3, power: 0 },
        18: { bat: 6, bowl: 6, keep: 5, tech: 6, field: 6, end: 4, exp: 4, power: 0 },
        19: { bat: 8, bowl: 8, keep: 6, tech: 8, field: 6, end: 5, exp: 4, power: 0 },
        20: { bat: 9, bowl: 9, keep: 7, tech: 9, field: 7, end: 5, exp: 5, power: 0 },
        21: { bat: 9, bowl: 9, keep: 7, tech: 9, field: 7, end: 5, exp: 5, power: 0 },
        22: { bat: 10, bowl: 10, keep: 8, tech: 10, field: 7, end: 6, exp: 5, power: 0 },
        23: { bat: 10, bowl: 10, keep: 8, tech: 10, field: 7, end: 6, exp: 6, power: 3 },
        24: { bat: 10, bowl: 10, keep: 8, tech: 10, field: 7, end: 6, exp: 6, power: 4 },
        25: { bat: 10, bowl: 10, keep: 8, tech: 10, field: 7, end: 6, exp: 6, power: 5 },
    };

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

        // Role-specific: bowlers vs batters
        const bowlers = seniors.filter(p => (p.bowling || 0) > (p.batting || 0));
        const batters = seniors.filter(p => (p.batting || 0) >= (p.bowling || 0));
        const allrounders = seniors.filter(p => (p.batting || 0) >= 7 && (p.bowling || 0) >= 7);
        const wicketkeepers = seniors.filter(p => (p.keeping || 0) >= 6 || p.role === 'WK');

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
            avgPrimary: Math.round(seniors.reduce((s, p) => s + Math.max(p.batting || 0, p.bowling || 0), 0) / seniors.length),
            minPrimary: Math.min(...seniors.map(p => Math.max(p.batting || 0, p.bowling || 0))),
            avgKeep: avg('keeping'),
            bowlerCount: bowlers.length,
            batterCount: batters.length,
            allrounderCount: allrounders.length,
            keeperCount: wicketkeepers.length,
            avgBowlerBowling: bowlers.length > 0 ? Math.round(bowlers.reduce((s, p) => s + (p.bowling || 0), 0) / bowlers.length) : 0,
            avgBatterBatting: batters.length > 0 ? Math.round(batters.reduce((s, p) => s + (p.batting || 0), 0) / batters.length) : 0,
        };
    }

    /**
     * Evaluate a transfer target against the user's actual squad.
     * Uses squad averages and minimums as dynamic thresholds.
     * Returns { score, verdict, warnings[], strengths[] }.
     * verdict: 'elite' | 'strong' | 'adequate' | 'weak' | 'poor'
     */
    function evaluateTransferTarget(player, squadStats) {
        const age = Math.round(player.age);
        const warnings = [];
        const strengths = [];
        let score = 0;
        const isYouth = age < 21;

        // ---- YOUTH EVALUATION (16-20) ----
        // Youth are evaluated against age-based curve targets.
        // Only Primary, Technique, Fielding are checked — endurance/experience don't matter
        // ANY skill below target = filtered out
        if (isYouth) {
            const targets = AGE_SKILL_EXPECTATIONS[age];
            if (targets) {
                const primary = Math.max(player.batting || 0, player.bowling || 0);

                const skills = [
                    { name: 'Primary', value: primary, target: targets.primary },
                    { name: 'Technique', value: player.technique || 0, target: targets.technique },
                    { name: 'Fielding', value: player.fielding || 0, target: targets.fielding }
                ];

                const belowSkills = skills.filter(s => s.value < s.target);

                // ANY skill below target = filtered out
                if (belowSkills.length > 0) {
                    score = -5;
                    belowSkills.forEach(s => warnings.push(`${s.name} ${skillLabel(s.value)} — below age ${age} target ${skillLabel(s.target)}`));
                    warnings.push(`${belowSkills.length} skill${belowSkills.length > 1 ? 's' : ''} below age ${age} targets — filtered`);
                } else {
                    score += 3;
                    strengths.push(`All skills meet age ${age} targets`);
                    const aheadCount = skills.filter(s => s.value >= s.target + 1).length;
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

            // Talent bonuses — training talents matter MORE for youth
            const talents = player.talents || [];
            const hasTalent = (regex) => talents.some(t => regex.test(t));
            if (hasTalent(/prodigy/i)) { score += 4; strengths.push('Prodigy — trains ALL skills faster (HIGH VALUE at this age)'); }
            if (hasTalent(/gifted.*batting/i)) { score += 2; strengths.push('Gifted (Batting) — trains batting faster'); }
            if (hasTalent(/gifted.*bowling/i)) { score += 2; strengths.push('Gifted (Bowling) — trains bowling faster'); }
            if (hasTalent(/gifted.*technique/i)) { score += 2; strengths.push('Gifted (Technique) — trains technique faster'); }
            if (hasTalent(/gifted.*fielding/i)) { score += 1; strengths.push('Gifted (Fielding) — trains fielding faster'); }
            if (hasTalent(/gifted.*endurance/i)) { score += 1; strengths.push('Gifted (Endurance) — trains endurance faster'); }
            if (hasTalent(/gifted.*power/i)) { score += 1; strengths.push('Gifted (Power) — trains power faster'); }
            if (hasTalent(/natural leader/i)) { score += 1; strengths.push('Natural Leader — captaincy bonus'); }
            if (hasTalent(/sturdy/i)) { score += 1; strengths.push('Sturdy — recovers from fatigue faster'); }

            // Role-specific talents (immediate value even for youth)
            if (hasTalent(/new ball bowler/i)) { score += 1; strengths.push('New Ball Bowler — opens bowling'); }
            if (hasTalent(/old ball bowler/i)) { score += 1; strengths.push('Old Ball Bowler — death overs specialist'); }
            if (hasTalent(/^opener$/i)) { score += 1; strengths.push('Opener — bats at top of order'); }
            if (hasTalent(/finisher/i)) { score += 1; strengths.push('Finisher — end-of-innings specialist'); }
            // Batting matchup talents (official manual: "performs better
            // when batting against seam/spin bowlers") — only meaningful
            // for a player whose primary skill is batting.
            if (hasTalent(/seam specialist/i) && (player.batting || 0) >= (player.bowling || 0)) { score += 1; strengths.push('Seam Specialist — better batting vs seam'); }
            if (hasTalent(/spin specialist/i) && (player.batting || 0) >= (player.bowling || 0)) { score += 1; strengths.push('Spin Specialist — better batting vs spin'); }

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

        const primary = Math.max(player.batting || 0, player.bowling || 0);
        const primaryName = (player.batting || 0) >= (player.bowling || 0) ? 'batting' : 'bowling';

        const seniorMinChecks = [
            { name: 'Primary', value: primary, min: SENIOR_MINS.primary },
            { name: 'Technique', value: player.technique || 0, min: SENIOR_MINS.technique },
            { name: 'Fielding', value: player.fielding || 0, min: SENIOR_MINS.fielding },
            { name: 'Endurance', value: player.endurance || 0, min: SENIOR_MINS.endurance },
            { name: 'Experience', value: player.experience || 0, min: SENIOR_MINS.experience }
        ];

        const belowMins = seniorMinChecks.filter(s => s.value < s.min);
        const meetsAllMins = belowMins.length === 0;

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
        if (hasTalent(/gifted.*batting/i)) { score += 1; strengths.push('Gifted (Batting) — trains batting faster'); }
        if (hasTalent(/gifted.*bowling/i)) { score += 1; strengths.push('Gifted (Bowling) — trains bowling faster'); }
        if (hasTalent(/gifted.*technique/i)) { score += 1; strengths.push('Gifted (Technique) — trains technique faster'); }
        if (hasTalent(/gifted.*fielding/i)) { strengths.push('Gifted (Fielding) — trains fielding faster'); }
        if (hasTalent(/gifted.*endurance/i)) { strengths.push('Gifted (Endurance) — trains endurance faster'); }
        if (hasTalent(/gifted.*power/i)) { strengths.push('Gifted (Power) — trains power faster'); }

        // Match performance talents (immediate value)
        if (hasTalent(/skilled.*batting/i)) { score += 1; strengths.push('Skilled (Batting) — bonus during matches'); }
        if (hasTalent(/skilled.*bowling/i)) { score += 1; strengths.push('Skilled (Bowling) — bonus during matches'); }
        if (hasTalent(/skilled.*technique/i)) { score += 1; strengths.push('Skilled (Technique) — bonus during matches'); }
        if (hasTalent(/skilled.*power/i)) { score += 1; strengths.push('Skilled (Power) — bonus during matches'); }
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
        if (hasTalent(/seam specialist/i) && primaryName === 'batting') {
            score += 1; strengths.push('Seam Specialist — performs better batting against seam bowling');
        }
        if (hasTalent(/spin specialist/i) && primaryName === 'batting') {
            score += 1; strengths.push('Spin Specialist — performs better batting against spin bowling');
        }
        if (hasTalent(/safe hands/i)) {
            score += 1; strengths.push('Safe Hands — fielding/keeping bonus');
        }

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
            if ((player.keeping || 0) >= 6 && squadStats.keeperCount < 2) {
                score += 1; strengths.push('Squad needs a backup wicketkeeper');
            }
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
        const age = Math.round(player.age);
        const isYouth = age < 21;
        const primary = Math.max(player.batting || 0, player.bowling || 0);

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
        const mins = isYouth ? AGE_SKILL_EXPECTATIONS[age] : (age <= 23 ? SENIOR_MINS_YOUNG : SENIOR_MINS_VETERAN);
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

        // 3. Age value (0-1.5 points)
        let ageScore = 0;
        if (isYouth) {
            // Younger = more development time
            ageScore = age <= 16 ? 1.5 : age <= 17 ? 1.2 : age <= 18 ? 0.9 : age <= 19 ? 0.5 : 0.2;
        } else {
            // Peak at 24-26, decline after
            ageScore = (age >= 24 && age <= 26) ? 1.5 : (age >= 22 && age <= 23) ? 1.0 : (age <= 21) ? 0.8 : 0.3;
        }

        // 4. Talents (0-1 point)
        const talents = player.talents || [];
        const talentCount = talents.length;
        const talentScore = Math.min(1, talentCount * 0.25);

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
        if (force || isStale(CACHE_TIMESTAMP_KEY, STALE_SQUAD_HOURS)) {
            labels.push('squad');
            promises.push(
                fetchSquadFromPage(`https://www.fromthepavilion.org/seniors.htm?squadViewId=2&teamId=${TEAM_ID}`)
                    .then(async (seniors) => {
                        const youth = await fetchSquadFromPage(`https://www.fromthepavilion.org/youths.htm?teamId=${TEAM_ID}`).catch(() => []);
                        const existing = loadPlayerCache();
                        const map = {};
                        seniors.forEach(p => { map[p.id] = p; });
                        youth.forEach(p => { if (!map[p.id]) map[p.id] = p; });
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
                console.log('[FTP Advisor] Row', idx, 'skipped - cells.length:', cells.length);
                return;
            }
            const nameLink = row.querySelector('a.player');
            if (!nameLink) {
                console.log('[FTP Advisor] Row', idx, 'skipped - no name link');
                return;
            }
            const playerId = nameLink.href.match(/playerId=(\d+)/)?.[1];
            const name = nameLink.textContent.trim();

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
        const name = nameLink.textContent.trim();
        if (!name || name.length < 2) return null;

        const cellTexts = Array.from(cells).map(c => c.textContent.trim());

        const getCell = (key) => {
            const idx = colMap[key];
            return (idx !== undefined && idx < cellTexts.length) ? cellTexts[idx] : '';
        };

        const age = parseFloat(getCell('age')) || 0;
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
                            console.log(`[FTP] Player ${playerId}: HTTP ${resp.status}`);
                            return resolve({ experience: null, wage: null, talents: [], captaincy: null });
                        }
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(resp.responseText, 'text/html');
                        const result = { experience: null, wage: null, talents: [], captaincy: null };

                        // Quick sanity check: if we got the login page, bail
                        if (doc.querySelector('input[name="username"]') || resp.responseText.length < 500) {
                            console.log(`[FTP] Player ${playerId}: likely login page or empty (len=${resp.responseText.length})`);
                            return resolve(result);
                        }

                        // Parse age/rating/wage from first <p> in .panel .padded
                        const paddedPs = doc.querySelectorAll('.panel .padded p');
                        if (paddedPs.length > 0) {
                            const infoText = paddedPs[0].textContent;
                            const wageMatch = infoText.match(/\$([\d,]+)\s*wage/);
                            if (wageMatch) result.wage = parseInt(wageMatch[1].replace(/,/g, ''));
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
                                    const name = title.split('|')[0].trim();
                                    if (name) result.talents.push(name);
                                });
                                if (result.talents.length === 0) {
                                    const text = td.textContent.trim();
                                    if (text && text !== 'None') {
                                        result.talents = text.split(',').map(t => t.trim()).filter(t => t.length > 0);
                                    }
                                }
                            }
                        }

                        console.log(`[FTP] Player ${playerId}: exp=${result.experience}, wage=${result.wage}, capt=${result.captaincy}, talents=${result.talents.length}`);
                        resolve(result);
                    } catch (e) {
                        console.log(`[FTP] Player ${playerId}: parse error`, e);
                        resolve({ experience: null, wage: null, talents: [], captaincy: null });
                    }
                },
                onerror: (e) => { console.log(`[FTP] Player ${playerId}: network error`, e); resolve({ experience: null, wage: null, talents: [], captaincy: null }); },
                ontimeout: () => { console.log(`[FTP] Player ${playerId}: timeout`); resolve({ experience: null, wage: null, talents: [], captaincy: null }); }
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
        // Fetch BOTH senior and youth squads in parallel
        const [seniors, youth] = await Promise.all([
            fetchSquadFromPage(`https://www.fromthepavilion.org/seniors.htm?squadViewId=2&orderBy=&teamId=${teamId}&playerType=0`).catch(() => []),
            fetchSquadFromPage(`https://www.fromthepavilion.org/youths.htm?teamId=${teamId}`).catch(() => [])
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
                    const allThs = doc.querySelectorAll('th');
                    for (const th of allThs) {
                        if (th.textContent.trim() === 'Home') {
                            const td = th.nextElementSibling;
                            if (td) {
                                const link = td.querySelector('a');
                                if (link) {
                                    const match = link.href.match(/teamId=(\d+)/);
                                    if (match) return resolve(match[1]);
                                }
                            }
                        }
                    }
                    const teamLinks = doc.querySelectorAll('a[href*="teamId="]');
                    for (const link of teamLinks) {
                        const match = link.href.match(/teamId=(\d+)/);
                        if (match && match[1] !== String(TEAM_ID)) {
                            return resolve(match[1]);
                        }
                    }
                    resolve(null);
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

        // Sponsorship revenue context (from wiki tables)
        // Div 1 SOD=$120k, T20=$90k, YOD=$48k, YT20=$24k = $282k total
        // Div 4 SOD=$60k, T20=$45k, YOD=$24k, YT20=$12k = $141k total
        const sponsorTotal = financeInfo ? (financeInfo.sponsorshipRevenue || 0) : 0;

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
            overs: 50,
            venue: 'Unknown',
            isYouthOnly: false,
            maxAge: 99
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
            }
        });

        return context;
    }

    function getOpponentTeamId() {
        // Look in match details for "Home" team (the opponent)
        const allElements = document.querySelectorAll('th');
        for (const th of allElements) {
            if (th.textContent.trim() === 'Home') {
                const td = th.nextElementSibling;
                if (td) {
                    const link = td.querySelector('a');
                    if (link) {
                        const match = link.href.match(/teamId=(\d+)/);
                        if (match) return match[1];
                    }
                }
            }
        }
        return null;
    }

    // ============================================================
    // SCORING FUNCTIONS
    // ============================================================
    function calculateBattingScore(player, pitchEffect, weatherEffect, isT20, isYouth) {
        let score = (player.batting * 3) + (player.technique * 2) + (player.power * 1.5) +
                    (player.experience * 0.5) + (player.form * 1.5) + (player.fatigue * 0.3);
        score *= pitchEffect.bat;
        score *= (2 - weatherEffect.fatigue) / 2;
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

    function calculateBowlingScore(player, pitchEffect, weatherEffect, isT20, isYouth) {
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
        let score = (player.bowling * 3) + (player.technique * 1.5) + (player.endurance * 1) +
                    (player.experience * 0.5) + (player.form * 1.5) + (player.fatigue * 0.3);
        score *= pitchMod * weatherMod;
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
            totalBowlers: allBowlers.length
        };
    }

    // ============================================================
    // TOSS DECISION LOGIC
    // ============================================================
    function recommendTossDecision(context, opponentAnalysis) {
        const pitchEffect = PITCH_EFFECTS[context.pitch] || PITCH_EFFECTS.Sporting;
        const weatherEffect = WEATHER_EFFECTS[context.weather] || WEATHER_EFFECTS.Sunny;
        const pitch = context.pitch;
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
                reason = 'Uneven pitch: Your batting is stronger. Bat first to create RRR pressure. Wicket-taking potential all innings.';
            } else if (opponentAnalysis && opponentAnalysis.relativeStrength === 'stronger') {
                decision = 'bowl';
                reason = 'Uneven pitch: Your seamers are stronger. Bowl first to attack early. "Particularly destructive around drinks."';
            } else {
                decision = 'bat';
                reason = 'Uneven pitch: Similar teams. Bat first to create RRR pressure. Good seamers get wickets all innings.';
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

        // Override with format-specific logic
        if (isT20 && (pitch === 'Hard' || pitch === 'Crumbling')) {
            // Still bat first on these even in T20
        } else if (isT20) {
            // For other pitches in T20, chasing is often better
            // Keep the pitch-specific advice though
        }

        return { decision, reason };
    }

    // ============================================================
    // LINEUP RECOMMENDATION (with LH/RH mixing + bowling variety)
    // ============================================================
    function recommendLineup(availablePlayers, context, opponentAnalysis) {
        const pitchEffect = PITCH_EFFECTS[context.pitch] || PITCH_EFFECTS.Sporting;
        const weatherEffect = WEATHER_EFFECTS[context.weather] || WEATHER_EFFECTS.Sunny;
        const isT20 = context.matchType === 'T20' || context.matchType === 'YT20';
        const isYouth = context.isYouthOnly;

        const ranked = availablePlayers.map(p => {
            let batScore = calculateBattingScore(p, pitchEffect, weatherEffect, isT20, isYouth);
            let bowlScore = calculateBowlingScore(p, pitchEffect, weatherEffect, isT20, isYouth);
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

        return lineup;
    }

    // ============================================================
    // BATTING ORDER (with LH/RH mixing for partnerships)
    // ============================================================
    function recommendBattingOrder(lineup) {
        // Wiki: LH/RH partnerships cause bowler penalty → mix them
        // Opener pairs: try to pair LH + RH
        // Best batsman at #3 or #4 (anchor)
        // Keeper in top 7
        // Bowlers at #8-#11 (tail)

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
        const remaining = sorted.filter(p => !used.has(p.id));
        if (remaining.length > 0) {
            const anchor = remaining.shift();
            ordered.push({ ...anchor, position: 3, battingTactic: 4 }); // Defensive to anchor
            used.add(anchor.id);
        }

        // Position 4-5: Next best, alternate LH/RH
        while (ordered.length < 5) {
            const nextRH = sorted.find(p => !p.isLeftHanded && !used.has(p.id));
            const nextLH = sorted.find(p => p.isLeftHanded && !used.has(p.id));
            const pick = (ordered.length % 2 === 0 ? nextRH : nextLH) || nextRH || nextLH;
            if (!pick) break;
            ordered.push({ ...pick, position: ordered.length + 1, battingTactic: 2 });
            used.add(pick.id);
        }

        // Position 6: Keeper + next best
        const keeper = lineup.find(p => p.role === 'WK' && !used.has(p.id));
        if (keeper && ordered.length < 7) {
            ordered.push({ ...keeper, position: ordered.length + 1, battingTactic: 2 });
            used.add(keeper.id);
        }

        // Position 7-8: Prefer Finisher talent here
        let remaining2 = sorted.filter(p => !used.has(p.id));
        while (ordered.length < 8 && remaining2.length > 0) {
            const finisher = remaining2.find(p => finisherIds.has(p.id));
            let pick;
            if (finisher) {
                pick = finisher;
                remaining2 = remaining2.filter(p => p.id !== finisher.id);
            } else {
                pick = remaining2.shift(); // only one shift
            }
            if (!pick) break;
            const isBowler = pick.bowlerCategory !== 'none' || pick.bowling >= MIN_BOWLING_FOR_BOWLERS;
            ordered.push({ ...pick, position: ordered.length + 1, battingTactic: isBowler ? 5 : 2 });
            used.add(pick.id);
        }

        // Position 9-11: Bowlers/sloggers (aggressive tactic)
        remaining2 = sorted.filter(p => !used.has(p.id));
        while (ordered.length < 11 && remaining2.length > 0) {
            const p = remaining2.shift();
            if (!p) break;
            const isBowler = p.bowlerCategory !== 'none' || p.bowling >= MIN_BOWLING_FOR_BOWLERS;
            const tactic = isBowler ? 5 : 2;
            ordered.push({ ...p, position: ordered.length + 1, battingTactic: tactic });
            used.add(p.id);
        }

        return ordered;
    }

    // ============================================================
    // BOWLING SPELL ALLOCATION
    // ============================================================
    function allocateBowlingSpells(lineup, context, opponentAnalysis) {
        const totalOvers = context.overs;
        const isT20 = context.matchType === 'T20' || context.matchType === 'YT20';
        const maxPerSpell = isT20 ? 4 : 8;
        const maxPerBowler = isT20 ? 4 : 10;
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

        const bowlers = lineup.filter(p => {
            const isKeeper = p.role === 'WK' || (p.keeping >= 4 && p.keeping > p.bowling);
            if (isKeeper) return false;
            return p.bowlerCategory !== 'none' || p.bowling >= MIN_BOWLING_FOR_BOWLERS;
        }).map(p => ({
            ...p,
            bowlScore: calculateBowlingScore(p, pitchEffect, weatherEffect, isT20, context.isYouthOnly)
        })).sort((a, b) => b.bowlScore - a.bowlScore);

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
                if (c >= minPerSpell) { spells.push({ player: b, overs: c, phase: 'Death overs', end: endName }); cap[b.id] -= c; need -= c; }
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
                deathBowler = bowlers.find(b => b.id !== shared.id && b.id !== bowlers[1].id && b.id !== midBowler.id) || bowlers[3];
            } else {
                midBowler = bowlers[2]; deathBowler = bowlers[3];
            }

            addSpellTo(gSpells, shared, Math.min(halfMax, perEnd), 'New ball', 'Gibson');
            addSpellTo(gSpells, midBowler, Math.min(maxPerSpell, perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
            addSpellTo(gSpells, deathBowler, perEnd - endTotal(gSpells), 'Death overs', 'Gibson');
            fillEnd(gSpells, perEnd, 'Gibson');

            addSpellTo(sSpells, bowlers[1], Math.min(maxPerSpell, perEnd), 'New ball', 'Southern');
            addSpellTo(sSpells, bowlers[4], Math.min(maxPerSpell, perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
            addSpellTo(sSpells, shared, perEnd - endTotal(sSpells), 'Death overs', 'Southern');
            fillEnd(sSpells, perEnd, 'Southern');

        } else if (nb >= 4) {
            const halfMax = Math.floor(maxPerSpell / 2);

            addSpellTo(gSpells, bowlers[0], Math.min(halfMax, perEnd), 'New ball', 'Gibson');
            addSpellTo(gSpells, bowlers[2], Math.min(maxPerSpell, perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
            addSpellTo(gSpells, bowlers[1], perEnd - endTotal(gSpells), 'Death overs', 'Gibson');
            fillEnd(gSpells, perEnd, 'Gibson');

            addSpellTo(sSpells, bowlers[1], Math.min(halfMax, perEnd), 'New ball', 'Southern');
            addSpellTo(sSpells, bowlers[3], Math.min(maxPerSpell, perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
            addSpellTo(sSpells, bowlers[0], perEnd - endTotal(sSpells), 'Death overs', 'Southern');
            fillEnd(sSpells, perEnd, 'Southern');

        } else if (nb >= 3) {
            addSpellTo(gSpells, bowlers[0], Math.min(Math.floor(maxPerSpell / 2), perEnd), 'New ball', 'Gibson');
            addSpellTo(gSpells, bowlers[1], Math.min(Math.floor(maxPerSpell / 2), perEnd - endTotal(gSpells)), 'Middle overs', 'Gibson');
            addSpellTo(gSpells, bowlers[2], perEnd - endTotal(gSpells), 'Death overs', 'Gibson');
            fillEnd(gSpells, perEnd, 'Gibson');

            addSpellTo(sSpells, bowlers[2], Math.min(Math.floor(maxPerSpell / 2), perEnd), 'New ball', 'Southern');
            addSpellTo(sSpells, bowlers[0], Math.min(Math.floor(maxPerSpell / 2), perEnd - endTotal(sSpells)), 'Middle overs', 'Southern');
            addSpellTo(sSpells, bowlers[1], perEnd - endTotal(sSpells), 'Death overs', 'Southern');
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
                const canAdd = Math.min(deficit, capLeft, maxPerSpell - spell.overs);
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
                    let capLeft = cap[b.id] || 0;
                    if (b.id === lastOtherBowler) continue;
                    if (b.id === lastThisEnd) continue;
                    if (capLeft < minPerSpell) {
                        // Lift maxPerBowler if needed — better to exceed cap than leave overs unassigned
                        cap[b.id] = minPerSpell;
                        capLeft = minPerSpell;
                    }
                    const c = Math.min(deficit, capLeft, maxPerSpell);
                    if (c >= minPerSpell) {
                        spells.push({ player: b, overs: c, phase: 'Death overs', end: endName });
                        cap[b.id] -= c;
                        deficit -= c;
                    }
                }
            }

            // Strategy 3: absolute last resort — if STILL deficit (extremely rare),
            // extend any spell regardless of cap (exceed maxPerBowler)
            if (deficit > 0) {
                for (const spell of spells) {
                    if (deficit <= 0) break;
                    const canAdd = Math.min(deficit, maxPerSpell - spell.overs);
                    if (canAdd > 0) {
                        spell.overs += canAdd;
                        deficit -= canAdd;
                    }
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
        const plan = [];
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

        // Fix adjacency violations: no bowler may bowl consecutive overs.
        // Run multiple passes since a swap can introduce new violations.
        // Admin rules enforced: max 8 per spell (OD), 4 per spell (T20),
        // max 10 per bowler (OD), 4 per bowler (T20), no consecutive overs.
        for (let pass = 0; pass < 3; pass++) {
            let fixed = false;
            for (let i = 1; i < plan.length; i++) {
                if (plan[i].player.id === plan[i - 1].player.id) {
                    let swapped = false;
                    for (let j = i + 1; j < plan.length; j++) {
                        const prevId = i >= 2 ? plan[i - 2].player.id : null;
                        if (plan[j].player.id !== plan[i - 1].player.id && plan[j].player.id !== prevId) {
                            const nextId = j + 1 < plan.length ? plan[j + 1].player.id : null;
                            if (plan[i - 1].player.id !== nextId) {
                                [plan[i], plan[j]] = [plan[j], plan[i]];
                                swapped = true;
                                fixed = true;
                                break;
                            }
                        }
                    }
                    if (!swapped) {
                        console.warn(`[FTP Advisor] Adjacency violation: ${plan[i].player.name} bowls consecutive overs at slot ${i}`);
                    }
                }
            }
            if (!fixed) break;
        }

        // ---- Assign startOver and tactics ----
        const seamBoost = pitchEffect.seam > 1.1;
        const spinBoost = pitchEffect.spin > 1.1;
        const battingFriendly = pitchEffect.bat > 1.1;
        const captain = lineup.find(p => p.isCaptain);
        const captaincy = captain ? (captain.captaincy || 5) : 5;
        const captainCanExec = captaincy >= 8;
        const captainIsWeak = captaincy < 5;

        let gibsonNext = 1;
        let southernNext = 2;

        plan.forEach((spell) => {
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

            if (spell.end === 'Gibson') {
                spell.startOver = gibsonNext;
                gibsonNext += spell.overs * 2;
            } else {
                spell.startOver = southernNext;
                southernNext += spell.overs * 2;
            }
        });

        return plan;
    }

    // ============================================================
    // TACTICAL ADVICE GENERATOR
    // ============================================================
    // ============================================================
    // ORDERS PAGE SCRAPER
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
                    players.push({ id: opt.value, name: opt.textContent.trim() });
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
                <span class="ftp-stat-badge blue">${context.matchType} \u00B7 ${context.overs}ov</span>
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

        // Age filtering for youth matches
        let ageWarning = '';
        if (context.isYouthOnly) {
            const beforeCount = enrichedPlayers.length;
            enrichedPlayers = enrichedPlayers.filter(p => {
                if (p.age !== undefined && p.age !== null) return p.age < context.maxAge + 1;
                return p.isYouth || (!p.isSenior && !p.isYouth);
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
        const battingOrder = recommendBattingOrder(lineup);
        const bowling = allocateBowlingSpells(lineup, context, opponentAnalysis);

        // Display toss
        const tossColor = tossRec.decision === 'bat' ? 'green' : 'blue';
        const tossIcon = tossRec.decision === 'bat' ? '\u{1F3CF}' : '\u{1F3C3}';
        document.getElementById('ftp-toss').innerHTML = `
            <div class="ftp-info-box success" style="text-align:center;">
                <div style="font-size:22px;margin-bottom:4px;">${tossIcon}</div>
                <div style="font-weight:700;font-size:16px;color:var(--vj-text);">${tossRec.decision === 'bat' ? 'Bat First' : 'Bowl First'}</div>
                <div class="vj-text-xs vj-text-secondary vj-mt-4">${tossRec.reason}</div>
            </div>
            ${ageWarning}
        `;

        // Display batting order
        displayBattingOrder(battingOrder);

        // Display bowling
        displayBowling(bowling);
        } catch (err) {
            console.error('[FTP Advisor] Error in updateOrdersAdvisor:', err);
            const ctx = document.getElementById('ftp-context');
            if (ctx) ctx.innerHTML = `<div class="ftp-alert danger">Error: ${err.message}<div class="vj-text-xs vj-mt-4">Check console (F12) for details.</div></div>`;
        }
    }

    function displayBattingOrder(battingOrder) {
        let html = '<table class="ftp-table"><thead><tr><th>#</th><th>Player</th><th>Bat</th><th>Form</th><th>L/R</th><th>Tac</th></tr></thead><tbody>';
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
        html += '<div class="vj-text-xs vj-text-muted vj-mt-4" style="text-align:center;">C = Captain \u00B7 WK = Wicketkeeper \u00B7 N=Normal D=Defensive A=Aggressive</div>';
        document.getElementById('ftp-batting').innerHTML = html;
    }

    function displayBowling(bowlingSpells) {
        let html = '<table class="ftp-table"><thead><tr><th>#</th><th>End</th><th>Over</th><th>Bowler</th><th>Bowl</th><th>Ovs</th><th>Tac</th><th>Phase</th></tr></thead><tbody>';
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
                { id: 'ftp-current-pitches', label: 'Current Pitches', icon: '\u{1F4CD}', iconColor: 'red', collapsible: true, collapsed: true },
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

        const pitchRecs = [
            { type: 'One Day (Senior)', ...recommendPitchForSquad(seniorSeamRating, seniorSpinRating, seniorBatRating) },
            { type: 'Twenty20 (Senior)', ...recommendPitchForSquad(seniorSeamRating, seniorSpinRating, seniorT20BatRating) },
            { type: 'Youth OD', ...recommendPitchForSquad(youthSeamRating, youthSpinRating, youthBatRating) },
            { type: 'Youth T20', ...recommendPitchForSquad(youthSeamRating, youthSpinRating, youthT20BatRating) }
        ];

        let recHtml = '';
        pitchRecs.forEach(rec => {
            const pitchEffect = PITCH_EFFECTS[rec.pitch] || PITCH_EFFECTS.Even;
            recHtml += `<div class="ftp-rec low" style="margin:5px 0;">
                <div class="vj-flex-between"><span class="vj-fw-700">${rec.type}</span><span class="ftp-stat-badge green">${rec.pitch}</span></div>
                <div class="vj-text-xs vj-text-muted vj-mt-4">${pitchEffect.desc}</div>
                <div class="vj-text-xs vj-text-secondary vj-mt-4">${rec.reason}</div>
            </div>`;
        });
        document.getElementById('ftp-pitch-recs').innerHTML = recHtml;

        const currentPitches = document.querySelectorAll('table.data tbody tr');
        let currentHtml = '<table class="ftp-table"><thead><tr><th>Class</th><th>Current</th></tr></thead><tbody>';
        currentPitches.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
                const className = cells[0]?.textContent.trim() || '';
                const pitchSpan = cells[1]?.querySelector('.popuphelp');
                const currentPitch = pitchSpan ? pitchSpan.textContent.trim() : cells[1]?.textContent.trim() || '';
                currentHtml += `<tr><td style="font-weight:600;">${className}</td><td><span class="ftp-stat-badge green">${currentPitch}</span></td></tr>`;
            }
        });
        currentHtml += '</tbody></table>';
        document.getElementById('ftp-current-pitches').innerHTML = currentHtml;

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
  --vj-navy: #0f1729; --vj-navy-mid: #1a2744; --vj-navy-light: #243352;
  --vj-gold: #c8a951; --vj-gold-dim: #a38b3e;
  --vj-card: #ffffff; --vj-surface: #f4f6f9; --vj-border: #e2e6ec; --vj-border-light: #eef1f5;
  --vj-text: #1e293b; --vj-text-secondary: #64748b; --vj-text-muted: #94a3b8;
  --vj-green: #059669; --vj-green-bg: #ecfdf5; --vj-green-border: #a7f3d0;
  --vj-red: #dc2626; --vj-red-bg: #fef2f2; --vj-red-border: #fecaca;
  --vj-amber: #d97706; --vj-amber-bg: #fffbeb; --vj-amber-border: #fde68a;
  --vj-blue: #2563eb; --vj-blue-bg: #eff6ff; --vj-blue-border: #bfdbfe;
  --vj-purple: #7c3aed; --vj-purple-bg: #f5f3ff;
  --vj-teal: #0d9488; --vj-teal-bg: #f0fdfa;
  --vj-orange: #ea580c; --vj-orange-bg: #fff7ed;
  --vj-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --vj-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
  --vj-shadow-md: 0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.04);
  --vj-shadow-lg: 0 10px 25px rgba(0,0,0,0.1), 0 4px 10px rgba(0,0,0,0.05);
  --vj-radius: 10px; --vj-radius-sm: 6px; --vj-radius-xs: 4px;
  --vj-transition: 0.2s cubic-bezier(0.4,0,0.2,1);
}

/* Panel */
#ftp-advisor-panel {
  position: fixed; top: 50px; right: 20px; width: 440px; max-height: 88vh;
  background: var(--vj-surface); border-radius: var(--vj-radius);
  box-shadow: var(--vj-shadow-lg), 0 0 0 1px rgba(0,0,0,0.04);
  z-index: 999999; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px; color: var(--vj-text); display: flex; flex-direction: column;
  overflow: hidden;
  animation: vjPanelIn 0.3s cubic-bezier(0.16,1,0.3,1);
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
}
#ftp-advisor-content::-webkit-scrollbar { width: 5px; }
#ftp-advisor-content::-webkit-scrollbar-track { background: transparent; }
#ftp-advisor-content::-webkit-scrollbar-thumb { background: var(--vj-border); border-radius: 10px; }

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
  padding: 8px 10px; margin: 4px 0; transition: all var(--vj-transition);
}
.ftp-rec:hover { box-shadow: var(--vj-shadow); transform: translateX(1px); border-left-width: 4px; }
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
                { id: 'ftp-squad-stats', label: 'Squad Overview', icon: '\u{1F4CA}', iconColor: 'green' },
                { id: 'ftp-squad-sell-seniors', label: 'Sell Candidates (Seniors)', icon: '\u{1F4B0}', iconColor: 'red', collapsible: true, collapsed: true },
                { id: 'ftp-squad-sell-youth', label: 'Sell Candidates (Youth)', icon: '\u{1F331}', iconColor: 'amber', collapsible: true, collapsed: true }
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

        // Keep/sell recommendations for own team
        if (isMyTeam && !isLimitedView) {
            const seniorSellEl = document.getElementById('ftp-squad-sell-seniors');
            const youthSellEl = document.getElementById('ftp-squad-sell-youth');
            if (seniorSellEl) seniorSellEl.innerHTML = generateSeniorSellList(players);
            if (youthSellEl) youthSellEl.innerHTML = generateYouthSellList(players);
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
            const name = nameLink.textContent.trim();

            // Training page columns: Player | Age | Fatigue | Form | Rating | Training Program | Previous Week
            // No skill columns — skills MUST come from squad cache

            // Extract age from second cell (format "25.05")
            const ageText = cells[1]?.textContent.trim() || '';
            const ageMatch = ageText.match(/(\d+)/);
            const age = ageMatch ? parseInt(ageMatch[1]) : 99;

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
    function estimateWeeklyTrainingGain(programKey, player, academySpeed) {
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
        const result = {};
        for (const [skill, basePoints] of Object.entries(rates)) {
            const ageM = skill === 'power' ? ageMult.power : skill === 'endurance' ? ageMult.endurance : ageMult.primary;
            const hasGiftedMatch = isProdigy || talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes(skill));
            const talentM = hasGiftedMatch ? (1 + TRAINING_TALENT_BONUS) : 1;
            const slowdownM = getSkillSlowdownMultiplier(player[skill] || 0);
            result[skill] = Math.round(basePoints * academyRatio * ageM * talentM * slowdownM);
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
            simPlayer.age = player.age + (week - 1) / 52;
            const gains = estimateWeeklyTrainingGain(programKey, simPlayer, academySpeed);
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
     * Returns { finalSkills, finalProgress, levelUps, timeline, weeks }
     * where timeline is [{ program, fromWeek, toWeek }] — the actual
     * program-switch history, e.g. Fielding wk1-8, Batting wk9-140, ...
     */
    function simulateAdaptiveTrainingPlan(player, weeks, academySpeed, squadContext) {
        const state = {};
        ADAPTIVE_PLAN_SKILLS.forEach(skill => {
            state[skill] = { level: Math.min(15, Math.round(player[skill] || 0)), progress: 0 };
        });

        const levelUps = [];
        const timeline = [];
        let currentProgram = null;
        let programStartWeek = 1;

        for (let week = 1; week <= weeks; week++) {
            const simPlayer = Object.assign({}, player);
            ADAPTIVE_PLAN_SKILLS.forEach(skill => { simPlayer[skill] = state[skill].level; });
            simPlayer.age = player.age + (week - 1) / 52;
            simPlayer.fatigue = week === 1 ? player.fatigue : 8;

            const rec = recommendTraining(simPlayer, squadContext);
            const program = rec.program;

            if (program !== currentProgram) {
                if (currentProgram !== null) timeline.push({ program: currentProgram, fromWeek: programStartWeek, toWeek: week - 1 });
                currentProgram = program;
                programStartWeek = week;
            }

            if (program === 'rest') continue; // no skill gain this week
            const gains = estimateWeeklyTrainingGain(program, simPlayer, academySpeed);
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
        return { finalSkills, finalProgress, levelUps, timeline, weeks };
    }

    // ============================================================
    // TRAINING RECOMMENDATION ENGINE
    // ============================================================

    // Helper: detect player role + talent flags (shared by all paths)
    function _detectPlayerContext(player) {
        const isBatsman = player.batting >= player.bowling && player.batting >= player.keeping;
        const isBowler = player.bowling > player.batting && player.bowling > player.keeping;
        const isKeeper = player.keeping >= player.batting && player.keeping >= player.bowling && player.keeping >= 4;
        const isAllrounder = Math.abs(player.batting - player.bowling) <= 2 && player.batting >= 4 && player.bowling >= 4;
        const isWristSpinner = player.bowlerType === 'rws' || player.bowlerType === 'lws';
        const isProdigy = player.talents.some(t => t.toLowerCase().includes('prodigy'));
        const hasGiftedBatting = player.talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes('batting'));
        const hasGiftedBowling = player.talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes('bowling'));
        const hasGiftedTechnique = player.talents.some(t => t.toLowerCase().includes('gifted') && t.toLowerCase().includes('technique'));
        return { isBatsman, isBowler, isKeeper, isAllrounder, isWristSpinner, isProdigy,
                 hasGiftedBatting, hasGiftedBowling, hasGiftedTechnique };
    }

    // Youth training path (age < 21)
    function _recommendYouthTraining(rec, player, ctx) {
        const { academySpeed, setProgram } = ctx;
        const { isBowler, isKeeper, isAllrounder, isWristSpinner, hasGiftedBatting, hasGiftedBowling, hasGiftedTechnique, isProdigy } = ctx;

        if (player.fielding < 6) {
            setProgram('fielding', `Youth: Fielding is ${skillLabel(player.fielding)}. Get fielding to Capable first — early pops are cheap and fast. Improves run-saving, catching, and runout opportunities. Academy speed: ${Math.round(academySpeed * 100)}%.`, 'high');
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

        if (player.technique < primarySkill - 1) {
            if (isBowler) {
                setProgram('bowlingtech', `Technique (${skillLabel(player.technique)}) is lagging behind bowling (${skillLabel(player.bowling)}). High bowling + low technique = takes wickets but bowls poor deliveries.`, 'high');
            } else {
                setProgram('battingtech', `Technique (${skillLabel(player.technique)}) is lagging behind batting (${skillLabel(player.batting)}). High batting + low technique = inconsistent batting.`, 'high');
            }
            return;
        }

        if (isAllrounder && player.batting >= 4 && player.bowling >= 4) {
            setProgram('allrounder', `Youth all-rounder: Batting (${skillLabel(player.batting)}) and bowling (${skillLabel(player.bowling)}) are close. AR training develops both equally.`, 'high');
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

        if (player.fielding < 7) {
            setProgram('fielding', `Senior: Fielding is ${skillLabel(player.fielding)}. Push to Reliable before age slows training. Wiki: fielding to Reliable/Capable first is best ROI.`, 'medium');
            return;
        }

        if (age >= 24 && age <= 27 && player.power < 8) {
            setProgram('strength', `Age ${age}: Power training peaks mid-20s. Currently ${skillLabel(player.power)}. Strength trains power and endurance. Window closes after ~27.`, 'medium');
            return;
        }

        if (age >= 25 && player.power < player.batting - 2) {
            setProgram('strength', `Age ${age}: Power (${skillLabel(player.power)}) is weak relative to batting (${skillLabel(player.batting)}). Strength catches up power.`, 'low');
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

        const primarySkill = isBowler ? player.bowling : isKeeper ? player.keeping : player.batting;
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

    function recommendTraining(player, squadContext) {
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
            rec.warnings.push(`Squad has ${squadSize} players (>25 limit). Training penalty: ${((squadSize - 25) * 7.5).toFixed(1)}% per extra player.`);
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
        // already computed above (academy/age/talent/slowdown).
        if (rec.program !== 'rest') {
            rec.weeklyGain = estimateWeeklyTrainingGain(rec.program, player, academySpeed);
            const programDef = TRAINING_PROGRAMS[rec.program];
            if (rec.weeklyGain && programDef && programDef.primary) {
                rec.primarySkill = programDef.primary;
                rec.weeksToNextLevel = weeksToNextLevel(rec.weeklyGain[programDef.primary]);
                // 12-week outlook: keeps training this program and shows
                // where the primary skill actually lands, not just the
                // next single level-up.
                rec.projection = simulateTrainingPlan(player, rec.program, 12, academySpeed);
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
        const efficiency = players.length <= 25 ? 100 : Math.max(0, 100 - ((players.length - 25) * 7.5));
        // Squad-wide summary badge — uses the game's own live overall
        // efficiency (avg of Senior/Youth Training Efficiency %, already
        // scraped in parseAcademyDoc) rather than the derived ACADEMY_SPEED
        // curve, since this squad has a real mix of ages the single
        // level-based estimate can't represent as accurately.
        const academySpeed = academyInfo ? (academyInfo.trainingEfficiency != null ? academyInfo.trainingEfficiency / 100 : (ACADEMY_SPEED[academyInfo.levelNum] || 1.00)) : 1.00;
        const academyLevel = academyInfo ? academyInfo.level : 'unknown';

        let statsHtml = `
            <div class="vj-flex vj-gap-6 vj-mb-8" style="flex-wrap:wrap;">
                <span class="ftp-stat-badge blue">Squad: ${players.length}</span>
                <span class="ftp-stat-badge ${efficiency < 100 ? 'red' : 'green'}">${efficiency.toFixed(0)}%</span>
                <span class="ftp-stat-badge purple">${academyLevel} (${Math.round(academySpeed * 100)}%)</span>
            </div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Average age</span><span class="ftp-stat-value">${avgAge.toFixed(1)}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Youth (&lt;21)</span><span class="ftp-stat-value">${youth.length}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Aging (30+)</span><span class="ftp-stat-value">${aging.length}</span></div>
            <div class="ftp-stat-row"><span class="ftp-stat-label">Avg fatigue</span><span class="ftp-stat-value">${avgFatigue.toFixed(1)}/10</span></div>
            ${fatigued.length > 0 ? `<div class="ftp-alert danger" style="margin-top:4px;"><span>\u26A0</span><div>Fatigued: ${fatigued.map(p => p.name).join(', ')}</div></div>` : ''}
            ${players.length > 25 ? `<div class="ftp-alert warning" style="margin-top:4px;"><span>\u26A0</span><div>Squad has ${players.length} players (&gt;25 limit). Training penalty: ${((players.length - 25) * 7.5).toFixed(1)}% per extra player.</div></div>` : ''}
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
                <div class="vj-flex-between"><span class="ftp-rec-name">${priorityIcon} ${p.name} <span class="vj-text-xs vj-text-muted">(${p.age})</span></span><span class="vj-text-xs ${isAlreadyCorrect ? 'vj-text-muted' : ''}">${isAlreadyCorrect ? '\u2705' : '\u27A1'}</span></div>
                <div class="ftp-rec-current">Now: ${currentProg} \u00B7 Bat ${skillLabel(p.batting).slice(0,3)} \u00B7 Bowl ${skillLabel(p.bowling).slice(0,3)} \u00B7 Tech ${skillLabel(p.technique).slice(0,3)} \u00B7 Field ${skillLabel(p.fielding).slice(0,3)} \u00B7 End ${skillLabel(p.endurance).slice(0,3)}${p.keeping > 0 ? ` \u00B7 Keep ${skillLabel(p.keeping).slice(0,3)}` : ''}</div>
                <div class="ftp-rec-program">\u2192 ${TRAINING_PROGRAM_LABELS[rec.program] || rec.program}${rec.weeksToNextLevel ? ` <span class="vj-text-xs vj-text-muted">(~${rec.weeksToNextLevel}wk to next level)</span>` : ''}</div>
                ${gains ? `<div class="ftp-rec-gains">${gains.gains.join(' | ')}</div>` : ''}
                ${rec.projection && rec.primarySkill ? `<div class="ftp-rec-gains" style="color:var(--vj-blue);">\ud83d\udcc5 ${formatTrainingOutlook(rec.projection, rec.primarySkill, p[rec.primarySkill])}</div>` : ''}
                <div class="ftp-rec-reason">${rec.reason}</div>
                ${rec.warnings.length > 0 ? `<div class="ftp-rec-warnings">\u26A0 ${rec.warnings.join(' \u00B7 ')}</div>` : ''}
            </div>`;
        });
        document.getElementById('ftp-training-recs').innerHTML = recsHtml;
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
    function evaluateYouthRecruit(player) {
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
        // Primary skill (what they're best at)
        const primarySkill = Math.max(batting, bowling, keeping);
        const primaryName = primarySkill === keeping ? 'keeping' : primarySkill === bowling ? 'bowling' : 'batting';

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

        // --- ROLE DETECTION ---
        const isBatsman = batting >= bowling && batting >= keeping;
        const isBowler = bowling > batting && bowling > keeping;
        const isKeeper = keeping >= batting && keeping >= bowling && keeping >= 3;
        const isAllrounder = Math.abs(batting - bowling) <= 2 && batting >= 3 && bowling >= 3;

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
        const evalEl = document.getElementById('ftp-recruit-eval');
        const recentRecruits = youthPlayers.filter(p => p.experience <= 1 && p.age <= 17);
        if (recentRecruits.length > 0) {
            const recruit = recentRecruits.sort((a, b) => a.age - b.age)[0];
            const eval_ = evaluateYouthRecruit(recruit);
            const verdictBadge = eval_.verdict === 'elite' ? 'green' : eval_.verdict === 'strong' ? 'green' : eval_.verdict === 'promising' ? 'blue' : eval_.verdict === 'average' ? 'amber' : 'red';

            evalEl.innerHTML = `<div class="ftp-rec ${eval_.verdict === 'release' ? 'critical' : eval_.verdict === 'weak' ? 'high' : eval_.verdict === 'average' ? 'medium' : 'low'}">
                <div class="vj-flex-between"><span class="ftp-rec-name">${recruit.name} <span class="vj-text-xs vj-text-muted">(age ${recruit.age})</span></span><span class="ftp-stat-badge ${verdictBadge}">${eval_.verdict.toUpperCase()}</span></div>
                <div class="vj-text-xs vj-text-secondary vj-mt-4">Score: ${eval_.score}/25 \u00B7 Role: ${eval_.roleFit}</div>
                <div class="vj-text-xs vj-text-muted vj-mt-4">Bat ${skillLabel(recruit.batting)} \u00B7 Bowl ${skillLabel(recruit.bowling)} \u00B7 Keep ${skillLabel(recruit.keeping)} \u00B7 Tech ${skillLabel(recruit.technique)} \u00B7 End ${skillLabel(recruit.endurance)} \u00B7 Pwr ${skillLabel(recruit.power)} \u00B7 Field ${skillLabel(recruit.fielding)}</div>
                <div class="ftp-rec-program vj-mt-4">\u2192 ${TRAINING_PROGRAM_LABELS[eval_.recommendedTraining] || eval_.recommendedTraining}</div>
                ${eval_.warnings.length > 0 ? `<div class="ftp-rec-warnings vj-mt-4">\u26A0 ${eval_.warnings.join(' \u00B7 ')}</div>` : ''}
            </div>`;
        } else if (youthPlayers.length > 0) {
            let html = '';
            const evalCache = new Map();
            const getEval = (p) => { if (!evalCache.has(p.id)) evalCache.set(p.id, evaluateYouthRecruit(p)); return evalCache.get(p.id); };
            const sorted = [...youthPlayers].sort((a, b) => getEval(b).score - getEval(a).score);
            sorted.slice(0, 10).forEach(p => {
                const ev = getEval(p);
                const badge = ev.verdict === 'elite' ? 'green' : ev.verdict === 'strong' ? 'green' : ev.verdict === 'promising' ? 'blue' : ev.verdict === 'average' ? 'amber' : 'red';
                html += `<div class="ftp-stat-row" style="padding:4px 0;">
                    <span class="vj-text-xs" style="font-weight:600;">${p.name} (${p.age})</span>
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
        // Attendance is capped by capacity; not all supporters attend every match
        // Typical attendance rate: 30-60% of supporters for home matches
        const EST_ATTENDANCE_RATE = 0.45; // 45% of supporters attend a home match on average
        const estAttendance = supporters > 0
            ? Math.min(Math.round(supporters * EST_ATTENDANCE_RATE), capacity)
            : Math.min(Math.round((division <= 2 ? 3000 : division <= 3 ? 2000 : 1200)), capacity);
        const utilizationPct = capacity > 0 ? Math.round((estAttendance / capacity) * 100) : 0;

        rec.details.push(`Capacity: ${capacity.toLocaleString()} seats`);
        rec.details.push(`Weekly maintenance: $${weeklyMaintenance.toLocaleString()}/wk (${capacity} \u00D7 $1)`);
        rec.details.push(`Est. weekly gate revenue (100% full): $${estWeeklyGate.toLocaleString()}`);
        rec.details.push(`Est. weekly net gate contribution: $${netGatePerWeek.toLocaleString()}`);
        if (supporters > 0) {
            rec.details.push(`Supporters: ${supporters.toLocaleString()} (${supporterGrowth > 0 ? '+' : ''}${supporterGrowth}/wk)`);
            rec.details.push(`Est. attendance: ~${estAttendance.toLocaleString()} (${utilizationPct}% full, ~${Math.round(EST_ATTENDANCE_RATE * 100)}% of supporters)`);
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
                const targetCap = Math.max(MIN_CAPACITY, estAttendance + 1000);
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
                const targetCap = Math.max(MIN_CAPACITY, estAttendance + 1500);
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
        if (resultsEl) {
            const results = scrapeTransferResults();
            if (results.length > 0) {
                // Evaluate each player against squad stats
                const evaluated = results.map(p => {
                    const ev = evaluateTransferTarget(p, squadStats);
                    ev.rank = calculateRank(p, squadStats);
                    return { ...p, eval: ev };
                });

                // ---- FILTERS ----
                // Separate youth (16-20) and senior (21+) evaluations
                // Youth: evaluated against age curve, no age limit
                // Seniors: max age 27 (matches the oldest "base" screenshot
                // benchmark) — the base itself (checkScoutBenchmark) is what
                // actually gates skill/wage/experience per age.
                const SENIOR_MAX_AGE = 27;

                const ageFiltered = evaluated.filter(e => {
                    const age = Math.round(e.age);
                    return age >= 21 && age > SENIOR_MAX_AGE;
                }).length;

                const filtered = evaluated.filter(e => {
                    const age = Math.round(e.age);
                    const isYouth = age < 21;

                    // Age filter (seniors only — peak is 25-27, decline starts 28+)
                    if (!isYouth && age > SENIOR_MAX_AGE) {
                        e.eval.warnings.push(`Age ${age} — past prime years for senior transfer`);
                        return false;
                    }
                    // Filter out poor/weak verdicts (failed minimums)
                    if (e.eval.verdict === 'poor' || e.eval.verdict === 'weak') {
                        return false;
                    }
                    return true;
                });

                const verdictFiltered = evaluated.length - ageFiltered - filtered.length;
                const skipped = evaluated.length - filtered.length;
                const priorityBuys = filtered;

                // Sort: best buy to worst — ELITE first, then STRONG, then ADEQUATE; within verdict, highest rank first; cheapest first on ties
                const verdictOrder = { elite: 0, strong: 1, adequate: 2 };
                priorityBuys.sort((a, b) => (verdictOrder[a.eval.verdict] ?? 9) - (verdictOrder[b.eval.verdict] ?? 9) || b.eval.rank - a.eval.rank || (a.price || 0) - (b.price || 0));

                function renderTransferResults(players, totalScanned, ageFilteredCount, verdictFilteredCount, detailsFetched) {
                    let html = `<div class="vj-flex vj-gap-6 vj-mb-8" style="flex-wrap:wrap;">
                        <span class="ftp-stat-badge green">${players.length} Target${players.length !== 1 ? 's' : ''}</span>
                        <span class="ftp-stat-badge neutral">${totalScanned} Total Scanned</span>
                        ${ageFilteredCount > 0 ? `<span class="vj-text-xs vj-text-muted" style="align-self:center;">${ageFilteredCount} over age limit</span>` : ''}
                        ${verdictFilteredCount > 0 ? `<span class="vj-text-xs vj-text-muted" style="align-self:center;">${verdictFilteredCount} below threshold</span>` : ''}
                        ${!detailsFetched ? `<button id="ftp-fetch-details-btn" class="vj-btn vj-btn-sm" style="font-size:11px;padding:2px 8px;cursor:pointer;">\u21BB Fetch Experience & Wages</button>` : `<span class="ftp-stat-badge neutral">\u2713 Details fetched</span>`}
                    </div>`;

                    if (players.length === 0) {
                        html += '<div class="vj-text-sm vj-text-muted">No targets found. Try adjusting search filters (age, bowling type, skill ranges).</div>';
                    } else {
                        players.forEach((p, i) => {
                            const ev = p.eval;
                            const badgeClass = ev.verdict === 'elite' ? 'green' : ev.verdict === 'strong' ? 'green' : 'warn';
                            const primarySkill = Math.max(p.batting, p.bowling);
                            const primaryName = p.batting >= p.bowling ? 'Bat' : 'Bowl';

                            // Build detail line — show experience/wage only if fetched
                            const detailParts = [
                                `${primaryName} ${skillLabel(primarySkill)}`,
                                `Tech ${skillLabel(p.technique)}`,
                                `Field ${skillLabel(p.fielding)}`,
                                `End ${skillLabel(p.endurance)}`
                            ];
                            if (p.bowlerType) detailParts.push(`<span class="vj-fw-700">${p.bowlerType.toUpperCase()}</span>`);
                            if (p.rating) detailParts.push(`Rating ${p.rating.toLocaleString()}`);
                            if (detailsFetched && p.experience != null && p.experience > 0) detailParts.push(`Exp ${skillLabel(p.experience)}`);
                            if (detailsFetched && p.captaincy != null && p.captaincy > 0) detailParts.push(`Capt ${skillLabel(p.captaincy)}`);
                            if (detailsFetched && p.wage != null && p.wage > 0) detailParts.push(`Wage $${p.wage.toLocaleString()}/wk`);
                            if (p.price) detailParts.push(`Price $${p.price.toLocaleString()}`);
                            if (detailsFetched && p.talents && p.talents.length > 0) detailParts.push(`<span style="color:var(--vj-gold);">${p.talents.join(', ')}</span>`);

                            html += `<div class="ftp-rec low" style="padding:6px 8px;margin:3px 0;">
                                <div class="vj-flex-between">
                                    <span class="vj-fw-700" style="font-size:12px;">#${i+1} ${p.name} <span class="vj-text-xs vj-text-muted">(${p.age}yo)</span></span>
                                    <div style="display:flex;gap:4px;align-items:center;">
                                        <span class="ftp-stat-badge ${badgeClass}">${ev.verdict.toUpperCase()}</span>
                                    </div>
                                </div>
                                <div class="vj-text-xs vj-text-muted" style="line-height:1.4;margin-top:2px;">
                                    ${detailParts.join(' \u00B7 ')}
                                </div>
                                ${ev.warnings.length > 0 ? `<div class="vj-text-xs vj-text-muted" style="color:var(--vj-red);line-height:1.4;margin-top:2px;">\u26A0 ${ev.warnings.join(' \u00B7 ')}</div>` : ''}
                                ${ev.strengths.length > 0 ? `<div class="vj-text-xs vj-text-muted" style="color:var(--vj-green);line-height:1.4;margin-top:2px;">\u2713 ${ev.strengths.join(' \u00B7 ')}</div>` : ''}
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
                        });
                        // Re-filter: remove players who now fail updated evaluation.
                        // The base (checkScoutBenchmark, including its experience
                        // minimum per age) is already enforced inside
                        // evaluateTransferTarget above via verdict === 'poor' —
                        // no separate experience check needed here.
                        const reFiltered = priorityBuys.filter(p => {
                            const age = Math.round(p.age);
                            const isYouth = age < 21;
                            if (!isYouth && age > SENIOR_MAX_AGE) return false;
                            if (p.eval.verdict === 'poor' || p.eval.verdict === 'weak') return false;
                            return true;
                        });
                        const reAgeFiltered = priorityBuys.filter(p => { const age = Math.round(p.age); return age >= 21 && age > SENIOR_MAX_AGE; }).length;
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
        // Age-based youth wage caps (community-backed):
        // 16yo: $2,000 (covers average/reasonable skills)
        // 17yo: $3,000 (covers capable skills)
        // 18yo: $5,000 (covers reliable skills)
        // 19yo: $7,000 (covers accomplished skills)
        // 20yo: $12,000 (covers expert/outstanding skills)
        const YOUTH_WAGE_CAPS = { 16: 2000, 17: 3000, 18: 5000, 19: 7000, 20: 12000 };
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

    // ============================================================
    // SELL RECOMMENDATIONS — SQUAD PAGE
    // Always shows a prioritized list of players to sell, ranked by
    // urgency. Uses age, skill levels, technique, rating vs peers,
    // and replaceability to score each player.
    // ============================================================
    function generateSeniorSellList(players) {
        if (!players || players.length === 0) return '<div class="vj-text-sm vj-text-muted">No players found.</div>';
        const seniors = players.filter(p => p.isSenior);
        if (seniors.length === 0) return '<div class="vj-text-sm vj-text-muted">No senior players found.</div>';

        const avg = (arr, key) => arr.length > 0 ? arr.reduce((s, p) => s + (p[key] || 0), 0) / arr.length : 0;
        const avgRating = avg(seniors, 'rating');
        const avgPrimary = avg(seniors.map(p => ({...p, primary: Math.max(p.batting||0, p.bowling||0)})), 'primary');

        const scored = seniors.map(p => {
            let sellScore = 0;
            const reasons = [];
            const primary = Math.max(p.batting || 0, p.bowling || 0);
            const isAllrounder = (p.batting || 0) >= 7 && (p.bowling || 0) >= 7;

            // Age penalty — older = more urgent to replace
            if (p.age >= 35) { sellScore += 20; reasons.push(`Age ${p.age} — well past peak`); }
            else if (p.age >= 32) { sellScore += 15; reasons.push(`Age ${p.age} — declining`); }
            else if (p.age >= 30) { sellScore += 10; reasons.push(`Age ${p.age} — past prime`); }
            else if (p.age >= 28) { sellScore += 5; }

            // Primary skill deficit — the most important factor
            if (primary < 5) { sellScore += 15; reasons.push(`Primary skill ${skillLabel(primary)} — too weak for senior cricket`); }
            else if (primary < 7) { sellScore += 10; reasons.push(`Primary skill ${skillLabel(primary)} — below standard`); }
            else if (primary < 9) { sellScore += 5; }

            // Technique — community rule: technique amplifies all performance
            if ((p.technique || 0) < 5) { sellScore += 10; reasons.push(`Technique ${skillLabel(p.technique)} — limits ceiling`); }
            else if ((p.technique || 0) < 7) { sellScore += 5; }

            // Rating relative to squad average
            if (avgRating > 0 && (p.rating || 0) < avgRating * 0.5) {
                sellScore += 15; reasons.push(`Rating ${p.rating || '?'} — far below squad avg (${Math.round(avgRating)})`);
            } else if (avgRating > 0 && (p.rating || 0) < avgRating * 0.7) {
                sellScore += 10; reasons.push(`Rating below squad average`);
            } else if (avgRating > 0 && (p.rating || 0) < avgRating * 0.85) {
                sellScore += 5;
            }

            // All-rounder bonus — harder to replace
            if (isAllrounder) { sellScore -= 10; }

            // Captain/keeper bonus — harder to replace
            if (p.isCaptain) { sellScore -= 5; reasons.push('Captain — hard to replace'); }
            if (p.role === 'WK' || (p.keeping || 0) >= 6) { sellScore -= 5; }

            // Bowler type premium/value — don't sell a genuine fast bowler cheaply
            if (['rf', 'lf'].includes(p.bowlerType)) { sellScore -= 8; }
            else if (['rfm', 'lfm', 'rws', 'lws'].includes(p.bowlerType)) { sellScore -= 5; }

            return { player: p, sellScore, reasons };
        }).sort((a, b) => b.sellScore - a.sellScore);

        // Show top sell candidates (those with sellScore > 0 = some reason to sell)
        const candidates = scored.filter(r => r.sellScore > 0);
        if (candidates.length === 0) {
            return `<div class="ftp-info-box success">
                <div class="vj-fw-700">No strong sell candidates</div>
                <div class="vj-text-xs vj-text-secondary vj-mt-4">All senior players are performing adequately. Focus on upgrading the weakest through transfers.</div>
            </div>`;
        }

        let html = `<div class="vj-text-xs vj-text-muted vj-mb-4">Ranked by urgency to sell. ${candidates.length} of ${seniors.length} seniors flagged.</div>`;
        candidates.forEach((r, i) => {
            const sev = r.sellScore >= 20 ? 'critical' : r.sellScore >= 10 ? 'high' : 'medium';
            html += `<div class="ftp-rec ${sev}" style="padding:6px 8px;margin-bottom:4px;">
                <div class="vj-flex-between">
                    <span class="vj-fw-700" style="font-size:12px;">${i+1}. ${r.player.name} <span class="vj-text-xs vj-text-muted">(${r.player.age}yo \u00B7 ${skillLabel(r.player.batting)}/${skillLabel(r.player.bowling)} \u00B7 R${r.player.rating || '?'})</span></span>
                    <span class="ftp-stat-badge ${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'neutral'}">${r.sellScore}pts</span>
                </div>
                ${r.reasons.length ? r.reasons.map(r2 => `<div class="vj-text-xs" style="color:var(--vj-${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'muted'});">\u2022 ${r2}</div>`).join('') : ''}
            </div>`;
        });

        html += `<div class="vj-text-xs vj-text-muted vj-mt-4">Replace with transfers: prioritize fast bowlers, wrist spinners, and high-technique players aged 16-27.</div>`;
        return html;
    }

    function generateYouthSellList(players) {
        if (!players || players.length === 0) return '<div class="vj-text-sm vj-text-muted">No players found.</div>';
        const youth = players.filter(p => p.isYouth);
        if (youth.length === 0) return '<div class="vj-text-sm vj-text-muted">No youth players found.</div>';

        const scored = youth.map(p => {
            let sellScore = 0;
            const reasons = [];
            const ydEval = evaluateYouthDevelopment(p);
            const primaryName = getYouthPrimarySkillName(p);
            const primaryValue = p[primaryName] || 0;
            let behindStats = [];
            let aheadStats = [];

            if (ydEval) {
                behindStats = ydEval.rows.filter(r => r.status === 'behind');
                aheadStats = ydEval.rows.filter(r => r.status === 'ahead');

                // Behind on 2+ stats = development failure
                if (behindStats.length >= 2) {
                    sellScore += 15;
                    reasons.push(`Behind on ${behindStats.length} stats: ${behindStats.map(r => r.label).join(', ')}`);
                } else if (behindStats.length === 1) {
                    sellScore += 8;
                    reasons.push(`Behind on ${behindStats[0].label} (${behindStats[0].value} vs target ${behindStats[0].min})`);
                }

                // Age 20 and behind = final youth year wasted
                if (p.age >= 20 && behindStats.length >= 1) {
                    sellScore += 20;
                    reasons.push(`Age 20 — final youth year, behind development curve`);
                }

                // Age 19+ and primary significantly behind
                if (p.age >= 19 && ydEval.rows[0] && ydEval.rows[0].status === 'behind' && (ydEval.rows[0].min - ydEval.rows[0].value) >= 2) {
                    sellScore += 15;
                    reasons.push(`Primary skill ${ydEval.rows[0].min - ydEval.rows[0].value} behind target — unlikely to catch up`);
                }
            } else {
                // Outside youth window
                if (p.age > 20) {
                    const primarySkill = Math.max(p.batting || 0, p.bowling || 0);
                    if (primarySkill < 7) {
                        sellScore += 12;
                        reasons.push(`Age ${p.age} with primary skill only ${primarySkill} — should have progressed more`);
                    }
                }
            }

            // Very low overall skill regardless of age
            const overallSkill = ((p.batting || 0) + (p.bowling || 0) + (p.technique || 0) + (p.fielding || 0)) / 4;
            if (overallSkill < 4) {
                sellScore += 10;
                reasons.push(`Very low overall skill (${overallSkill.toFixed(1)} avg) — unlikely to develop`);
            } else if (overallSkill < 5) {
                sellScore += 5;
            }

            // Technique deficit (community rule: technique critical)
            if ((p.technique || 0) < 4 && ydEval) {
                sellScore += 8;
                reasons.push(`Technique ${skillLabel(p.technique)} — limits development ceiling`);
            }

            // Ahead of curve = keep
            if (ydEval && behindStats.length === 0 && aheadStats.length >= 1) {
                sellScore -= 10;
            }

            return { player: p, sellScore, reasons };
        }).filter(r => r.sellScore > 0)
          .sort((a, b) => b.sellScore - a.sellScore);

        if (scored.length === 0) {
            return `<div class="ftp-info-box success">
                <div class="vj-fw-700">No youth sell candidates</div>
                <div class="vj-text-xs vj-text-secondary vj-mt-4">All youth players are developing on track or ahead of the curve.</div>
            </div>`;
        }

        let html = `<div class="vj-text-xs vj-text-muted vj-mb-4">Youth players behind the 16-20 development curve. ${scored.length} of ${youth.length} flagged.</div>`;
        scored.forEach((r, i) => {
            const sev = r.sellScore >= 20 ? 'critical' : r.sellScore >= 10 ? 'high' : 'medium';
            html += `<div class="ftp-rec ${sev}" style="padding:6px 8px;margin-bottom:4px;">
                <div class="vj-flex-between">
                    <span class="vj-fw-700" style="font-size:12px;">${i+1}. ${r.player.name} <span class="vj-text-xs vj-text-muted">(age ${Math.round(r.player.age)} \u00B7 ${skillLabel(r.player.batting)}/${skillLabel(r.player.bowling)})</span></span>
                    <span class="ftp-stat-badge ${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'neutral'}">${r.sellScore}pts</span>
                </div>
                ${r.reasons.map(r2 => `<div class="vj-text-xs" style="color:var(--vj-${sev === 'critical' ? 'red' : sev === 'high' ? 'amber' : 'muted'});">\u2022 ${r2}</div>`).join('')}
            </div>`;
        });

        html += `<div class="vj-text-xs vj-text-muted vj-mt-4">Free roster spots for better youth recruits or transfer targets.</div>`;
        return html;
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
                const opponentIds = allKeys
                    .filter(k => k.indexOf(OPPONENT_TIMESTAMP_PREFIX) === 0)
                    .map(k => k.slice(OPPONENT_TIMESTAMP_PREFIX.length));
                if (opponentIds.length) {
                    let oppHtml = '<table class="ftp-table"><thead><tr><th>Team</th><th>Players</th><th>Last Updated</th><th>Status</th></tr></thead><tbody>';
                    opponentIds.forEach(id => {
                        const age = getDataAgeText(OPPONENT_TIMESTAMP_PREFIX + id);
                        const stale = isStale(OPPONENT_TIMESTAMP_PREFIX + id, STALE_OPPONENT_HOURS);
                        const cached = loadOpponentCache(id);
                        const count = cached ? cached.players.length : 0;
                        const fullSkillCount = cached ? cached.players.filter(p => p.hasFullSkills).length : 0;
                        const playersCell = count === 0
                            ? '<span class="ftp-stat-badge red">0 found</span>'
                            : fullSkillCount === 0
                                ? `${count} <span class="vj-text-xs vj-text-muted">(skills hidden)</span>`
                                : `${count}`;
                        oppHtml += `<tr><td>Team ${id}</td><td>${playersCell}</td><td class="vj-text-xs vj-text-muted">${age}</td><td><span class="ftp-stat-badge ${stale ? 'amber' : 'green'}">${stale ? 'Stale' : 'Fresh'}</span></td></tr>`;
                    });
                    oppHtml += '</tbody></table>';
                    oppEl.innerHTML = oppHtml;
                } else {
                    oppEl.innerHTML = '<div class="vj-text-xs vj-text-muted">No opponent scouting data cached.</div>';
                }
            } catch (e) {
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
        const name = nameEl ? nameEl.textContent.trim() : 'This player';

        const bowlerTypeSpan = doc.querySelector('span.bowlerType');
        let bowlerType = bowlerTypeSpan ? bowlerTypeSpan.textContent.trim().toLowerCase() : '';

        // Age/rating/wage live in one free-text paragraph, same place
        // fetchPlayerPageDetails() already reads wage from.
        let age = null, rating = 0, wage = 0;
        const paddedPs = doc.querySelectorAll('.panel .padded p');
        if (paddedPs.length > 0) {
            const infoText = paddedPs[0].textContent;
            const ageMatch = infoText.match(/(\d{1,2})y(\d{1,2})w/);
            if (ageMatch) age = parseInt(ageMatch[1], 10) + parseInt(ageMatch[2], 10) / 52;
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
                    const t = title.split('|')[0].trim();
                    if (t) player.talents.push(t);
                });
                if (player.talents.length === 0) {
                    const text = td.textContent.trim();
                    if (text && text !== 'None') player.talents = text.split(',').map(t => t.trim()).filter(Boolean);
                }
            }
        });

        player.hasFullSkills = skillFieldsFound >= 5; // batting/bowling/technique/power/fielding at minimum
        return player;
    }

    /**
     * Ranks this candidate against squad players in the same age
     * bracket (exact age first, falls back to all seniors if nobody
     * matches — a small squad may have no exact-age peer). Returns the
     * peers sorted worst-rank-first, i.e. best-sell-candidate-first, so
     * a caller can show "if you sign this player, here's who to move
     * on, starting with the clearest cut."
     */
    function comparePlayerToSquadPeers(candidate, squadPlayers) {
        const squadStats = computeSquadStats(squadPlayers);
        const candidateAge = Math.round(candidate.age);
        let peers = squadPlayers.filter(p => Math.round(p.age) === candidateAge && p.age >= 21);
        let groupLabel = `age ${candidateAge}`;
        if (peers.length === 0) {
            peers = squadPlayers.filter(p => p.age >= 21);
            groupLabel = 'all seniors (no exact age match in squad)';
        }
        const candidateRank = calculateRank(candidate, squadStats);
        const ranked = peers
            .map(p => ({ player: p, rank: calculateRank(p, squadStats) }))
            .sort((a, b) => a.rank - b.rank);
        const wouldReplace = ranked.filter(r => candidateRank > r.rank);
        return { candidateRank, groupLabel, wouldReplace, allPeers: ranked, squadStats };
    }

    /**
     * Training-potential grid for a youth player: for each training
     * program relevant to their role, projects where the program's
     * primary skill lands at several horizons (12wk, 26wk, 1yr, and
     * "to age 20" — the end of their development window). Reuses
     * simulateTrainingPlan() (same verified per-week formula as the
     * Training page's "12wk outlook") run separately per horizon —
     * cheap pure arithmetic, no reason to complicate it with snapshotting.
     * This assumes training ONE program continuously for the whole
     * horizon with no rest/fatigue weeks — a real plan would switch
     * programs over time (e.g. fielding first, then primary), so treat
     * the longer columns as a ceiling estimate for that program alone,
     * not a forecast of the advisor's actual staged recommendation.
     */
    function buildTrainingPotentialGrid(player, academySpeed, longHorizonWeeks, longHorizonLabel) {
        const pd = _detectPlayerContext(player);
        const programs = ['fielding'];
        if (pd.isAllrounder) programs.push('allrounder');
        else if (pd.isKeeper) programs.push('keeping');
        else if (pd.isBowler) programs.push('bowling', 'bowlingtech');
        else programs.push('batting', 'battingtech');

        const horizons = [12, 26, 52];
        const horizonLabels = ['12wk', '26wk', '1yr'];
        if (longHorizonWeeks && longHorizonWeeks > 52) {
            horizons.push(longHorizonWeeks);
            horizonLabels.push(longHorizonLabel || 'long-term');
        }

        const rows = programs.map(programKey => {
            const programDef = TRAINING_PROGRAMS[programKey];
            const primary = programDef.primary;
            const cells = horizons.map(w => {
                const proj = simulateTrainingPlan(player, programKey, w, academySpeed);
                return proj ? skillLabel(proj.finalSkills[primary]) : '—';
            });
            return { label: TRAINING_PROGRAM_LABELS[programKey], cells };
        });
        return { horizonLabels, rows };
    }

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
        const squadStats = computeSquadStats(squadPlayers);
        const isYouth = Math.round(player.age) < 21;
        const evalResult = evaluateTransferTarget(player, squadStats);
        const rank = calculateRank(player, squadStats);
        const keepVerdict = evalResult.verdict === 'poor' || evalResult.verdict === 'weak' ? 'RELEASE' : 'KEEP';
        const badgeClass = keepVerdict === 'KEEP' ? 'green' : 'red';

        let html = `<div class="vj-flex-between vj-mb-4">
                <span class="vj-fw-700" style="font-size:14px;">${player.name} <span class="vj-text-xs vj-text-muted">(${Math.round(player.age)}yo)</span></span>
                <span class="ftp-stat-badge ${badgeClass}" style="font-size:13px;">${keepVerdict}</span>
            </div>
            <div class="vj-text-xs vj-text-muted vj-mb-4">Verdict: ${evalResult.verdict.toUpperCase()} · Rank ${rank}/10 · ${Math.max(player.batting, player.bowling) ? (player.batting >= player.bowling ? 'Bat' : 'Bowl') + ' ' + skillLabel(Math.max(player.batting, player.bowling)) : ''} · Tech ${skillLabel(player.technique)} · Field ${skillLabel(player.fielding)}</div>`;

        if (evalResult.strengths.length > 0) {
            html += `<div class="vj-text-xs vj-mt-4" style="color:var(--vj-green);">✓ ${evalResult.strengths.join(' · ')}</div>`;
        }
        if (evalResult.warnings.length > 0) {
            html += `<div class="vj-text-xs vj-mt-4" style="color:var(--vj-red);">⚠ ${evalResult.warnings.join(' · ')}</div>`;
        }
        if (isYouth) {
            const yd = evaluateYouthDevelopment(player);
            if (yd) {
                html += `<div class="vj-text-xs vj-mt-8"><span class="vj-fw-700">16-20 development curve:</span> ${yd.overallStatus === 'behind' ? '<span style="color:var(--vj-red);">Behind curve</span>' : '<span style="color:var(--vj-green);">On track</span>'}</div>`;
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
            const academyInfo = loadAcademyCache();
            const academySpeed = getAcademySpeedForPlayer(player, academyInfo);
            const squadContext = { size: squadPlayers.length, academyInfo, financeInfo: loadFinanceCache() };
            const trainingRec = recommendTraining(player, squadContext);
            const academyNote = academyInfo ? `your current ${academyInfo.level} academy (${isYouth ? academyInfo.youthEfficiency : academyInfo.seniorEfficiency}% ${isYouth ? 'youth' : 'senior'} training efficiency)` : 'an unknown academy level (visit the Academy page to cache it for a more accurate estimate)';

            let tHtml = `<div class="vj-text-xs vj-text-muted vj-mb-4">Recommended now: <span class="vj-fw-700">${TRAINING_PROGRAM_LABELS[trainingRec.program] || trainingRec.program}</span>${trainingRec.projection && trainingRec.primarySkill ? ` — ${formatTrainingOutlook(trainingRec.projection, trainingRec.primarySkill, player[trainingRec.primarySkill])}` : ''}</div>`;

            const planWeeks = isYouth ? Math.max(52, Math.round(Math.max(1, 20 - player.age) * 52)) : (player.age >= 30 ? 52 : 104);
            const planLabel = isYouth ? 'Development plan to age 20' : (player.age >= 30 ? '1yr training outlook' : '2yr training outlook');

            // Adaptive plan — the actual staged advice (fielding first,
            // then primary skill for youth; maintenance-focused for
            // aging players, etc), re-decided every simulated week via
            // recommendTraining() itself, not one program locked in forever.
            const plan = simulateAdaptiveTrainingPlan(player, planWeeks, academySpeed, squadContext);
            tHtml += `<div class="vj-fw-700 vj-mb-4">${planLabel}</div>`;
            tHtml += `<div class="vj-text-xs vj-mb-4">${plan.timeline.map(t => `<span class="vj-fw-700">${TRAINING_PROGRAM_LABELS[t.program] || t.program}</span> (wk${t.fromWeek}${t.toWeek > t.fromWeek ? `-${t.toWeek}` : ''})`).join(' → ')}</div>`;
            tHtml += `<div style="overflow-x:auto;"><table class="ftp-table"><thead><tr><th>Skill</th><th>Now</th><th>Projected</th></tr></thead><tbody>`;
            ADAPTIVE_PLAN_SKILLS.forEach(skill => {
                const before = skillLabel(Math.round(player[skill] || 0));
                const after = skillLabel(plan.finalSkills[skill]);
                if (before === after && plan.finalSkills[skill] === Math.round(player[skill] || 0) && (plan.finalProgress[skill] || 0) === 0) return; // untouched skill, skip
                tHtml += `<tr><td style="text-transform:capitalize;">${skill}</td><td>${before}</td><td>${before === after ? after : `<span class="vj-fw-700">${after}</span>`}</td></tr>`;
            });
            tHtml += '</tbody></table></div>';
            tHtml += `<div class="vj-text-xs vj-text-muted vj-mt-4">Assumes ${academyNote}, week 1's real fatigue then a healthy baseline after (fatigue/matches aren't simulated), and re-picks the training program every week using the same staged logic as the live recommendation above — this is the realistic plan, not a single-program ceiling.</div>`;

            // Single-program comparison — kept as a secondary "what if
            // I specialized in just this the whole time" reference.
            const grid = buildTrainingPotentialGrid(player, academySpeed, planWeeks, planLabel.match(/\d+yr/) ? planLabel.match(/\d+yr/)[0] : 'to age 20');
            tHtml += `<div class="vj-fw-700 vj-mt-8 vj-mb-4">If you specialized in one program (ceiling comparison)</div>`;
            tHtml += `<div style="overflow-x:auto;"><table class="ftp-table"><thead><tr><th>Program</th>${grid.horizonLabels.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>`;
            grid.rows.forEach(r => {
                tHtml += `<tr><td>${r.label}</td>${r.cells.map(c => `<td>${c}</td>`).join('')}</tr>`;
            });
            tHtml += '</tbody></table></div>';
            tHtml += `<div class="vj-text-xs vj-text-muted vj-mt-4">Each row assumes training that ONE program continuously the whole time — nobody actually trains like this, it's here to show the ceiling for a single focus vs the realistic mixed plan above.</div>`;
            trainingEl.innerHTML = tHtml;
        }

        // Squad comparison — who this player would realistically replace.
        // Most useful for 21+ (peer-age comparison against your senior
        // squad); youth are development bets, not direct swaps, so this
        // section is skipped for them rather than forcing a comparison
        // that doesn't mean much yet.
        if (!isYouth && squadPlayers.length > 0) {
            const cmp = comparePlayerToSquadPeers(player, squadPlayers);
            let cHtml = `<div class="vj-text-xs vj-text-muted vj-mb-4">Compared against ${cmp.groupLabel} in your squad (${cmp.allPeers.length} player${cmp.allPeers.length === 1 ? '' : 's'}). This player ranks ${cmp.candidateRank}/10.</div>`;
            if (cmp.wouldReplace.length > 0) {
                cHtml += `<div class="vj-fw-700 vj-mb-4">Would replace (best sell first):</div>`;
                cmp.wouldReplace.forEach(r => {
                    cHtml += `<div class="ftp-stat-row"><span class="ftp-stat-label">${r.player.name}</span><span class="ftp-stat-value">Rank ${r.rank}/10</span></div>`;
                });
            } else {
                cHtml += `<div class="vj-text-sm vj-text-muted">Doesn't clearly outrank anyone in this group — not an obvious replacement for your current squad.</div>`;
            }
            compareEl.innerHTML = cHtml;
        } else if (isYouth) {
            compareEl.innerHTML = '<div class="vj-text-xs vj-text-muted">Squad comparison is shown for senior (21+) players only — a 16-20yo is a development bet, not a like-for-like swap yet.</div>';
        } else {
            compareEl.innerHTML = '<div class="vj-text-xs vj-text-muted">No squad data cached yet — visit your Senior Squad page once to enable comparison.</div>';
        }

        // Feeds the same evaluation into the AI-recommendations scaffold's
        // context assembly (buildAIContextSnapshot) so that plumbing is
        // exercised end-to-end even though no AI call is wired up yet —
        // see AI_ENDPOINT_URL in the scaffold above.
        window._ftpLastPlayerContext = buildAIContextSnapshot({
            squadStats, ruleBasedRecommendation: { player: player.name, keepVerdict, verdict: evalResult.verdict, rank }
        });
    }

    // ============================================================
    // INIT — every page fetches fresh data first, then shows advisor
    // ============================================================
    async function init() {
        const pageType = detectPageType();
        console.log('[FTP Advisor] Page:', pageType);

        // --- SCRAPE CURRENT PAGE DATA (if on a data page) ---
        if (pageType === 'squad') {
            // Scrape squad from current page DOM immediately
            const players = scrapeSquad();
            if (players.length > 0) {
                const urlParams = new URLSearchParams(window.location.search);
                const teamId = urlParams.get('teamId');
                if (!teamId || teamId === String(TEAM_ID)) {
                    savePlayerCache(players);
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
        // could be hours old.
        if (pageType !== 'squad') {
            const forceRefresh = pageType === 'orders';
            fetchAllData({ force: forceRefresh }).then(() => {
                // Re-run the advisor after data is refreshed
                if (pageType === 'orders') updateOrdersAdvisor();
                else if (pageType === 'training') updateTrainingAdvisor();
                else if (pageType === 'ground') updateGroundAdvisor();
                else if (pageType === 'academy') updateAcademyAdvisor();
                else if (pageType === 'youthrecruit') updateYouthRecruitAdvisor();
                else if (pageType === 'club') updateClubStatusUI();
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
