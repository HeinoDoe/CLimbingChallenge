# Climbing Challenge

A points competition for the squad's ranked games in League of Legends. **Solo/Duo and Flex are two separate competitions**, each with its own tab, standings and awards. The website shows:

- **Standings:** total points per player (LP earned + achievements + end awards), with a tap-to-expand breakdown
- **End awards:** who's leading each award right now (faded until it's final), and the winners once the challenge is over
- **Tagesrückblick:** about 5 highlights from the previous day, written automatically after midnight
- where everyone stands in rank, how far they moved since the start or this week, and rank over time
- a players table and a feed of everyone's latest games
- a Prime League tab with game day draft plans for each opponent, our draft pool, comps and a scouting tool

It runs for free on GitHub. A background timer fetches data from the Riot API once an hour, scores it and saves it into this repository. The website is a static page on GitHub Pages that only displays that saved file. Your API key stays in a GitHub secret and never reaches the website.

## How scoring works

Solo/Duo and Flex are scored separately with the same rules: the Solo/Duo tab only uses Solo/Duo games and Solo/Duo LP, the Flex tab only Flex games and Flex LP.

**Total = LP earned + achievements + end awards.** End awards only count once the challenge is over. Until then the standings and award boards show who's currently leading, faded and slightly blurred, plus small chips naming the awards each player leads.

**LP earned:** net LP change in that queue during the challenge, on one scale where every division is 100 LP (Plat 4 0 LP → Plat 1 0 LP = +300; Master and above is one open-ended scale). Losses subtract, so it can be negative.
- The starting rank is the first rank snapshot at or after the start. Riot's API has no past LP, so it's recorded on the first update after the start. Players unranked at that point start from their first ranked snapshot.
- After the end date, LP is frozen at the last snapshot before the end.

**Achievements** (live):

| | Points |
| --- | --- |
| Each different champion played | +5 |
| Pentakill | +10 |
| Quadrakill (one that didn't become a penta) | +5 |

**End awards** (+10 each, handed out after the end date; everyone tied for first gets the full points):

Most games · Highest win rate · Highest KDA · Lowest KDA · Best vision score per minute · Longest win streak · Longest losing streak · Most deaths per game · One-trick

Win rate, both KDA awards, vision and deaths per game need at least `minGames` (20) games. **One-trick:** each player's best champion by win rate (with at least 10 games on it); the two players with the highest such win rate get +10 each, and anyone tied at the cut-off does too.

**Weekly bounties** (`challenge.bounties`): a side quest per week. The first player to win games on `target` different champions between `start` and `end` gets `points` right away (players who reach it in the same game share it). Week 1: 10 different champions, +20, until Sunday 4.10. The bounty card sits above the news; the (!) next to each player shows the champions they've won with so far. The daily Discord post shows the progress, and reaching 9/10 triggers a heads-up post. To add next week's bounty, add another entry with a new `id`, `start` and `end`.

Only ranked games played between the start and end date count. Remakes don't count (Riot's early-surrender flag), but short games that ended in a normal surrender, e.g. after a leaver, do.

**Trial run:** with `challenge.preview.start` set, the site scores a trial from that day until the real start, so you can see live results early. When the real challenge starts, everything resets automatically: game stats are counted again from the real start and the LP baseline is taken fresh. Remove `preview` if you don't want a trial.

## Daily review

After every finished day (midnight in `challenge.timeZone`), the update writes a **Tagesrückblick** with up to 5 highlights for that day, picked in this order: day winner (Solo/Duo points), pentakills, a new leader, the biggest LP loss, promotions and demotions, the best and worst game, the Flex day winner, quadrakills, streaks of 4+, the biggest grinder, and who didn't play. The first day starts at the challenge start, not midnight.

Reviews are kept in `docs/data.json`. A day is only written once every game is processed, so a day with games still loading waits for the next run. The logic lives in `scripts/review.mjs` (tests in `scripts/review.test.mjs`).

## Prime League game days

The Prime League tab has a **Game days** section (days 1–6). Everything about a game day lives in `docs/prime/gamedays.json`: our roster, each day's date and opponent roster, and the written draft plan (bans, picks and counters per role, comps, draft order, game plan).

To prepare a new game day:

1. Add the date and the opponent's five Riot IDs and roles to that day in `docs/prime/gamedays.json`, and push.
2. Run **Actions → Scout opponent** with the day number. It uses the `RIOT_API_KEY` secret to pull both rosters' ranks, last 30 ranked games, top mastery and last 15 tournament games (Prime League games are tournament-code games, so their past team drafts and bans show up), and saves `docs/prime/scout-day<N>.json`.
3. Write the `plan` for that day (or ask Claude to). The page shows the scouting tables as soon as the scout file exists, and the plan once it's in `gamedays.json`.

**Results** come in by themselves: from the game day's start time, every hourly update looks for our tournament games (2 hours before to 10 hours after the start) and saves the result, both lineups with KDA and the bans to `docs/prime/results.json` (`scripts/results.mjs`). The game day page then shows the result above the plan, including how many of our picks came from it, and the day's Discord post lists it.

## Discord posts

The update posts **once a day** to one Discord channel through a webhook, shortly after midnight when the day is finished. The post holds:

- the **Tagesrückblick** (which already covers pentakills and a new leader)
- the **leaderboard**: top 3 and last place, with ▲/▼ since yesterday
- the **weekly bounty**: progress, or who completed it
- our **Prime League games** of that day, if there were any

The one exception: when someone gets within one of a bounty's target (e.g. **9/10**), a short heads-up is posted right away, once per player and bounty (or a "geschafft" post if they jump straight to the target). Nothing else is posted on its own. To see what the daily post looks like: **Actions → Test Discord post → Run workflow**.

A webhook only ever posts into the channel it was created in. To set it up for the General chat:

1. In Discord, hover the **#general** channel → ⚙️ **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**. Name it (e.g. "Climbing Challenge"), then **Copy Webhook URL**. You need the "Manage Webhooks" permission on the server.
2. On GitHub: **Settings → Secrets and variables → Actions → New repository secret**, name `DISCORD_WEBHOOK_URL`, paste the URL.

Without the secret nothing is posted. The webhook URL lets anyone post into that channel, so keep it only in the GitHub secret. Logic: `scripts/notify.mjs` (tests in `scripts/notify.test.mjs`). Posts are only sent after the new data is saved, and nothing is posted after a reset (when all games are counted again).

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer. There are no packages to install.

1. Copy `.env.example` to `.env` and paste your Riot API key into it (see step 1 below for getting one). `.env` is ignored by git.
2. `npm run update` fetches ranks and games, scores them and writes `docs/data.json`.
3. `npm start` serves the site on <http://localhost:8000>. Open <http://localhost:8000/?demo=1> to see it with sample data.
4. `npm test` runs the scoring tests. `npm run sample` rebuilds the demo data in `docs/data.sample.json`.

Edit `docs/index.html` and reload the browser to see changes.

**Heads-up:** the GitHub Action commits a fresh `docs/data.json` every hour. Run `git pull` before you start working, and don't commit a `data.json` from a local test run unless you mean to replace the live data.

## Setup

### 1. Get a Riot API key

1. Sign in at <https://developer.riotgames.com> with your Riot account.
2. On the dashboard you'll see a **Development API Key**. It works immediately but **expires every 24 hours**, so only use it for testing.
3. For something that keeps running, click **Register Product** and choose **Personal API Key**. Describe it honestly, for example: "Private stats page tracking ranked progress for my group of 8 friends." Riot reviews it by hand, which can take a while. Once it's approved the key doesn't expire.

### 2. The repository

The code lives at <https://github.com/HeinoDoe/CLimbingChallenge>. It must stay **Public**, because GitHub Pages is free only for public repositories.

### 3. Add the API key as a secret

1. In the repository, go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret** (or edit the existing one).
3. Name it `RIOT_API_KEY` and paste your key as the value.

When you replace a development key the next day, edit this same secret. Nothing is lost while it's expired: missed games are caught up on the next run.

### 4. Turn on the website

1. Go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, then branch `main` and folder `/docs`. Click **Save**.
3. The site is at <https://heinodoe.github.io/CLimbingChallenge/>.

### 5. Updating

The **Hourly timer** workflow (`.github/workflows/timer.yml`) starts **Update squad data** once an hour. GitHub's built-in schedule often skips runs for hours, so the timer stays running instead and restarts itself every 5 hours; a backup schedule restarts it if the chain ever breaks. It's free on public repositories. To pause updates, disable **Hourly timer** in the Actions tab.

To update right away: **Actions → Update squad data → Run workflow**.

Run it by hand right after the challenge starts and right after it ends, so the LP baseline and the frozen final LP are as exact as possible.

## Customising

Everything lives in `squad.config.json`:

| Setting | What it does |
| --- | --- |
| `squadName` | The big title on the page. |
| `platform` / `region` | `euw1` / `europe` for EUW. |
| `challenge.start` / `challenge.end` | First and last day of the challenge (`YYYY-MM-DD`, both days included, midnight in `challenge.timeZone`). A full timestamp like `2026-09-30T17:40:00+02:00` starts at that exact moment. Changing them re-processes all games on the next runs. |
| `challenge.timeZone` | Time zone for the dates. Default `Europe/Berlin`. |
| `challenge.bounties` | Weekly bounties: `id`, `type` (`distinctChampionWins`), `queue` (`solo`/`flex`), `title`, `desc`, `target`, `points`, `start`, `end`. |
| `challenge.preview.start` | Optional trial run from this day until `challenge.start`. Resets automatically when the real challenge starts. |
| `challenge.minGames` | Games needed for the rate-based awards (win rate, KDA, vision, deaths). |
| `challenge.oneTrickMinGames` | Games on one champion needed for the one-trick award. |
| `challenge.points` | Points for every achievement and award. |
| `queues` | `420` = Solo/Duo, `440` = Flex. Each is its own competition; other queues are ignored. |
| `maxNewMatchesPerPlayerPerRun` | How many games to catch up per player per run. Keep it at 60 or lower on a personal key. |
| `players` | For each person: `name` (shown on the site), `riotId` (`Name#TAG`) and `role` (only shown on the site). |

All scoring lives in `scripts/challenge.mjs`. If you change what it tracks per game, bump `STATS_VERSION` at the top: the next runs then reset everyone's game stats and re-process every challenge game (rank history is kept). Add a test in `scripts/challenge.test.mjs` for new rules.

## Good to know

- **Pentakills and quadrakills:** Riot's `quadraKills` counter also counts the quadra inside every pentakill (checked on real matches). The script subtracts those, so a penta gives +10, not +15.
- **Catching up:** each run processes up to 60 new games per player, so after a date change or `STATS_VERSION` bump it can take a few runs until everything is counted. The page says how many games are still loading.
- **The data is public.** Anyone with the link can see `docs/data.json`: ranks and match stats, which are public in League anyway.
- **If updates stop,** check the Actions tab. A red run almost always means the API key expired (development keys last 24 hours). The run log says so explicitly.
- **Riot's rules** require the "isn't endorsed by Riot Games" line at the bottom of the page. Leave it in.

## Files

```
squad.config.json               players and challenge settings
package.json                    npm start / update / test / sample
.env.example                    template for your local API key
scripts/update.mjs              fetches data from the Riot API and writes docs/data.json
scripts/challenge.mjs           the scoring: dates, per-game stats, LP, achievements, awards
scripts/challenge.test.mjs      scoring tests (npm test)
scripts/review.mjs              the daily review highlights
scripts/review.test.mjs         daily review tests (npm test)
scripts/notify.mjs              the daily Discord post (built in the update, sent by the workflow)
scripts/notify.test.mjs         tests for Discord posts, results and ▲/▼ places
scripts/results.mjs             finds our Prime League games and saves the results
scripts/riot.mjs                small Riot API client used by scout.mjs and results.mjs
scripts/make-sample.mjs         builds docs/data.sample.json (npm run sample)
scripts/scout.mjs               scouts both rosters of a Prime League game day
scripts/serve.mjs               local web server for docs/
.github/workflows/update.yml    runs one update and saves the result
.github/workflows/timer.yml     starts the update once an hour
.github/workflows/scout.yml     "Scout opponent": runs scripts/scout.mjs for a game day
docs/prime/gamedays.json        Prime League game days: opponents and draft plans
docs/prime/scout-day<N>.json    scouting data for a game day (written by the scout)
docs/prime/results.json         our Prime League results (written by the update)
docs/index.html                 the website
docs/data.json                  the data (written by the script, don't edit)
docs/data.sample.json           sample data for ?demo=1
```
