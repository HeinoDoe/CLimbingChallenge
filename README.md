# Climbing Challenge

A website that tracks the squad's ranked climb and in-game challenges in League of Legends. It shows:

- how much LP everyone gained or lost since the challenge started (you pick the start time)
- where everyone stands right now and how far each player moved since the start or this week
- rank over time
- leaderboards for pentakills, quadrakills, win streaks, KDA, vision and more
- a feed of everyone's latest games

It runs for free on GitHub. A scheduled job fetches data from the Riot API every hour and saves it into this repository. The website is a static page on GitHub Pages that reads that saved file. Your API key stays in a GitHub secret and never reaches the website.

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer. There are no packages to install.

1. Copy `.env.example` to `.env` and paste your Riot API key into it (see step 1 below for getting one). `.env` is ignored by git.
2. `npm run update` fetches ranks and games and writes `docs/data.json`.
3. `npm start` serves the site on <http://localhost:8000>. Open <http://localhost:8000/?demo=1> to see it with sample data.

Edit `docs/index.html` and reload the browser to see changes.

**Heads-up:** once the GitHub Action is running, it commits a fresh `docs/data.json` every hour. Run `git pull` before you start working, and don't commit a `data.json` from a local test run unless you mean to replace the live data.

## Setting the starting point

`startAt` in `squad.config.json` is when the challenge starts. LP gains and game stats count from that moment.

- **Start right now:** `npm run start-now`. This sets `startAt` to the current time, records everyone's current rank as their starting rank, and writes `docs/data.json`. Commit and push `squad.config.json` and `docs/data.json` afterwards.
- **Start at a set time:** put a date and time in `startAt`, for example `"2026-10-01T18:00:00+02:00"`, and push. The site shows "Challenge starts …" until then. The starting rank is recorded on the first update after that time, so trigger the workflow by hand right at the start (Actions → Update squad data → Run workflow) if you want it exact. Otherwise it's taken at the next hourly run.

Riot's API only returns the current rank, never past LP, so a starting rank can only be recorded at or after the start, not backdated. Changing `startAt` resets everyone's starting rank and game counters. Players who were unranked at the start get their starting rank once they finish placements.

## Setup (about 15 minutes)

### 1. Get a Riot API key

1. Sign in at <https://developer.riotgames.com> with your Riot account.
2. On the dashboard you'll see a **Development API Key**. It works immediately but **expires every 24 hours**, so only use it for testing.
3. For something that keeps running, click **Register Product** and choose **Personal API Key**. Describe it honestly, for example: "Private stats page tracking ranked progress for my group of 6 friends." Riot reviews it by hand, which can take a while. Once it's approved the key doesn't expire.

### 2. The repository

The code lives at <https://github.com/HeinoDoe/CLimbingChallenge>. It must stay **Public**, because GitHub Pages is free only for public repositories.

### 3. Add the API key as a secret

1. In the repository, go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name it `RIOT_API_KEY` and paste your key as the value.

When you replace a development key the next day, edit this same secret.

### 4. Turn on the website

1. Go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, then branch `main` and folder `/docs`. Click **Save**.
3. After a minute or two the page shows your site's address, `https://heinodoe.github.io/CLimbingChallenge/`. That's the link to share.

### 5. Run the first update

1. Open the **Actions** tab. If GitHub asks, click to enable workflows.
2. Choose **Update squad data**, then **Run workflow**.
3. When the run turns green, reload your site.

After that it updates by itself every hour.

The first few runs catch up on older games, 60 per player per run, because of Riot's rate limits. While that's happening, the site says how many games are still loading.

## Customising

Everything about the squad lives in `squad.config.json`:

| Setting | What it does |
| --- | --- |
| `squadName` | The big title on the page. |
| `platform` / `region` | `euw1` / `europe` for EUW. EUNE is `eun1` / `europe`. |
| `startAt` | When the challenge starts. LP gains and game stats count from here. Changing it restarts the counters on the next run. See "Setting the starting point". |
| `queues` | `420` = Solo/Duo, `440` = Flex. For example, add `400` to include normal draft. |
| `maxNewMatchesPerPlayerPerRun` | How many older games to catch up per run. Keep it at 60 or lower on a personal key. |
| `players` | For each person: `name` (shown on the site), `riotId` (`Name#TAG`) and `role` (optional). Add or remove friends here. |

To add or change a challenge, edit the `CHALLENGES` list near the top of the script in `docs/index.html`. Each board is a title, a description and a `value` function. You can use these tracked stats:

`games`, `wins`, `kills`, `deaths`, `assists`, `doubleKills`, `tripleKills`, `quadraKills`, `pentaKills`, `firstBloods`, `soloKills`, `visionScore`, `timePlayed`, `damage`, `curStreak`, `bestWinStreak`, `maxKills`

## Good to know

- **Rank history starts when you switch it on.** Riot's API only gives the current rank and LP, not past LP. The "Climb over time" graph fills in from day one onwards.
- **Game stats can be backdated.** Pentas, streaks and so on come from match history, so if you set `startAt` in the past they go back to it. LP gains can't be backdated (see "Setting the starting point").
- **LP is shown on one scale.** Every division is 100 points, so promotions and demotions show up as a smooth climb or drop. Master, Grandmaster and Challenger share one open-ended scale.
- **The data is public.** Anyone with the link can see `docs/data.json`: ranks and match stats, which are public in League anyway.
- **If updates stop,** check the Actions tab. A red run almost always means the API key expired (development keys last 24 hours). The run log says so explicitly.
- **Riot's rules** require the "isn't endorsed by Riot Games" line at the bottom of the page. Leave it in.

## Files

```
squad.config.json               who to track, and the start time
package.json                    npm start / npm run update / npm run start-now
.env.example                    template for your local API key
scripts/update.mjs              fetches data from the Riot API (Node 18+)
scripts/serve.mjs               local web server for docs/
.github/workflows/update.yml    runs the script every hour and saves the result
docs/index.html                 the website
docs/data.json                  the data (written by the script, don't edit)
docs/data.sample.json           sample data for ?demo=1
```
