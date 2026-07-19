# 🏏 FTP Advisor

A Tampermonkey userscript that turns [From the Pavilion](https://www.fromthepavilion.org) into a game you can make *informed* decisions in — tactics, training, transfers, and squad management, all backed by actual numbers instead of gut feel.

No more guessing whether to bowl or bat first. No more training a player's technique for six weeks when their endurance was the real bottleneck. No more transfer targets that look great until you notice the wage.

> ☕ **If this project saved you time or made your life a little easier, consider [buying me a coffee](https://ko-fi.com/jadax).** It helps me maintain this project, fix bugs, and build new features — always appreciated, never expected. ❤️

---

## ✨ What it does

FTP Advisor adds a floating advisor panel to every major page of the game, each one tailored to what you're doing there:

| Page | What you get |
|---|---|
| 🎯 **Match Orders** | Toss recommendation, best XI, batting order, and bowling spell allocation — all weighted by pitch type, weather, and the opposition |
| 🏋️ **Training** | Per-player training recommendations based on age-decay curves, skill-slowdown, and training talents — plus a youth development-curve check |
| 💰 **Transfer Market** | Scores every search result against age-specific skill/wage benchmarks, flags real value picks, and generates sell lists for players worth offloading |
| 🔍 **Opponent Scouting** | Pulls your next opponent's squad automatically so you're not walking in blind |
| 🌱 **Youth Recruitment** | Evaluates recruits against community-backed age curves so you're not overpaying for a 16-year-old who won't develop |
| 🏟️ **Ground & Academy** | Recommends pitch type, capacity upgrades, and academy investment based on your finances |
| 📊 **Club Dashboard** | One glance at how fresh your cached data is, your next fixture, and supporter trends |

Everything runs locally in your browser. Your data stays yours.

## 🤔 Why this exists

From the Pavilion is a deep, numbers-heavy game — skills, fatigue, form, pitch effects, training curves — but the game itself only shows you raw values, one page at a time. Turning that into an actual *decision* means cross-referencing half a dozen pages in your head, every single week.

This script does that cross-referencing for you.

## 🚀 Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Firefox, Edge, Safari — all supported).
2. Click the link below — Tampermonkey will pop up an install prompt automatically:

   👉 **[Install FTP Advisor](https://raw.githubusercontent.com/Jadax/ftp-advisor/main/ftp-advisor_user.js)**
3. Click **Install**, then head to [fromthepavilion.org](https://www.fromthepavilion.org) and log in.

That's it — no build step, no dependencies, no account to create.

## 🎮 Usage

Just play the game normally. The advisor panel appears automatically on pages it supports (Squad, Match Orders, Training, Ground, Fixtures, Academy, Youth Recruit, Finances, Transfer Market, Club) and stays out of your way everywhere else.

- Panels are **draggable** — move them wherever suits your screen.
- Each panel has a **refresh button** to pull fresh data on demand.
- Data is **cached locally** (squad, finances, academy, ground, opponents) so the script doesn't hammer the site — freshness is shown right in the panel.

## ⚙️ Configuration

On first run, the script tries to auto-detect your team from the page. If that fails, it'll ask you once for your Team ID (the number in your own squad URL, e.g. `seniors.htm?teamId=1234`) and remember it from then on — no config file, no setup screen.

## ❓ FAQ

**Does this automate anything or play the game for me?**
No. It's read-only analysis and recommendations — you still make every decision and click every button yourself.

**Will this get me banned?**
It only reads pages you already have access to, the same way your browser normally would. That said, automation tools sit in a gray area for most browser games — use your own judgement about your server's rules.

**Why does opponent scouting show fewer stats than my own squad?**
That's the game, not a bug — the game only exposes limited data (age, experience, form, wage, rating) for teams you don't own.

**It's not detecting my team correctly. What do I do?**
Open Tampermonkey's dashboard, find FTP Advisor's storage, clear the `ftp_config_team_id` value, and reload — you'll be prompted again.

## 🤝 Contributing

Found a bug or have an idea? [Open an issue](https://github.com/Jadax/ftp-advisor/issues) — screenshots or a copy of the relevant page's HTML make fixes much faster, since the game requires a login to inspect directly.

It's a single-file script (`ftp-advisor_user.js`), so pull requests are easy to review — just make sure `node --check ftp-advisor_user.js` passes before opening one.

## 📄 License

MIT — do whatever you'd like with it.
