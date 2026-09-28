# Climbing Challenge

A points competition for the squad's ranked games in League of Legends. The website shows:

- **Standings:** total points per player (LP earned + achievements + end awards), with a tap-to-expand breakdown
- **End awards:** who's leading each award right now, and the winners once the challenge is over
- the challenge dates and a countdown to the end
- where everyone stands in rank, how far they moved since the start or this week, and rank over time
- a players table and a feed of everyone's latest games
- a Prime League tab with our draft pool, comps and a scouting tool

It runs for free on GitHub. A scheduled job fetches data from the Riot API every 30 minutes, scores it and saves it into this repository. The website is a static page on GitHub Pages that only displays that saved file. Your API key stays in a GitHub secret and never reaches the website.

## How scoring works

**Total = LP earned + achievements + end awards.** End awards only count once the challenge is over; until then they show as "ausstehend".

**LP earned:** net Solo/Duo LP change during the challenge, on one scale where every division is 100 LP (Plat 4 0 LP → Plat 1 0 LP = +300; Master and above is one open-ended scale). Losses subtract, so it can be negative.
- The starting rank is the first rank snapshot at or after the start. Riot's API has no past LP, so it's recorded on the first update after the start. Players unranked at that point start from their first ranked snapshot.
- After the end date, LP is frozen at the last snapshot before the end.

**Achievements** (live):

| | Points |
| --- | --- |
| Each different champion played | +5 |
| Pentakill | +10 |
| Quadrakill (one that didn't become a penta) | +5 |
| Off-role win: a win where your position isn't the `role` in the config | +5 |

Off-role only works for players with a role of `Top`, `Jungle`, `Mid`, `ADC` or `Support`. Anything else (for example `""` or `"Fill"`) never counts, and games with no position are skipped.

**End awards** (+10 each, handed out after the end date; everyone tied for first gets the full points):

Most games · Highest win rate · Highest KDA · Lowest KDA · Best vision score per minute · Longest win streak · Longest losing streak · Most deaths per game · One-trick

Win rate, both KDA awards, vision and deaths per game need at least `minGames` (20) games. **One-trick:** each player's best champion by win rate (with at least 10 games on it); the two players with the highest such win rate get +10 each, and anyone tied at the cut-off does too.

Only ranked games played between the start and end date count (the queues in `queues`). Remakes don't count.

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer. There are no packages to install.

1. Copy `.env.example` to `.env` and paste your Riot API key into it (see step 1 below for getting one). `.env` is ignored by git.
2. `npm run update` fetches ranks and games, scores them and writes `docs/data.json`.
3. `npm start` serves the site on <http://localhost:8000>. Open <http://localhost:8000/?demo=1> to see it with sample data.
4. `npm test` runs the scoring tests. `npm run sample` rebuilds the demo data in `docs/data.sample.json`.

Edit `docs/index.html` and reload the browser to see changes.

**Heads-up:** the GitHub Action commits a fresh `docs/data.json` every 30 minutes. Run `git pull` before you start working, and don't commit a `data.json` from a local test run unless you mean to replace the live data.

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

The workflow runs every 30 minutes, but GitHub starts scheduled runs late or skips some when it's busy. To update right away: **Actions → Update squad data → Run workflow**.

Run it by hand right after the challenge starts and right after it ends, so the LP baseline and the frozen final LP are as exact as possible.

## Customising

Everything lives in `squad.config.json`:

| Setting | What it does |
| --- | --- |
| `squadName` | The big title on the page. |
| `platform` / `region` | `euw1` / `europe` for EUW. |
| `challenge.start` / `challenge.end` | First and last day of the challenge (`YYYY-MM-DD`, both days included, midnight in `challenge.timeZone`). Changing them re-processes all games on the next runs. |
| `challenge.timeZone` | Time zone for the dates. Default `Europe/Berlin`. |
| `challenge.lpQueue` | Which queue's LP counts. `solo` or `flex`. |
| `challenge.minGames` | Games needed for the rate-based awards (win rate, KDA, vision, deaths). |
| `challenge.oneTrickMinGames` | Games on one champion needed for the one-trick award. |
| `challenge.points` | Points for every achievement and award. |
| `queues` | `420` = Solo/Duo, `440` = Flex. Only these games count for achievements and awards. |
| `maxNewMatchesPerPlayerPerRun` | How many games to catch up per player per run. Keep it at 60 or lower on a personal key. |
| `players` | For each person: `name` (shown on the site), `riotId` (`Name#TAG`) and `role` (`Top`, `Jungle`, `Mid`, `ADC`, `Support`, or empty). |

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
scripts/make-sample.mjs         builds docs/data.sample.json (npm run sample)
scripts/serve.mjs               local web server for docs/
.github/workflows/update.yml    runs the update every 30 minutes and saves the result
docs/index.html                 the website
docs/data.json                  the data (written by the script, don't edit)
docs/data.sample.json           sample data for ?demo=1
```
