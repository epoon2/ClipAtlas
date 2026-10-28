# ClipAtlas — hosted TikTok collection planner with accounts

A Cloudflare Workers + D1 edition of the local-first ClipAtlas MVP. Every registered user gets a **private library** (saved TikTok links, collections, location metadata, itinerary days). Includes sign-up, sign-in, secure HTTP-only sessions, D1 account storage, server-side library revisions that prevent accidental overwrites, backup export, and explicit local-library migration.

**Deployment status:** This ZIP contains deployable source code. It is **not live until you connect a Cloudflare account and deploy**. Do not publish a made-up workers.dev URL.

## Architecture

- **Hosting:** Cloudflare Worker Static Assets serves `public/` and `/api/*` routes run `src/worker.js`.
- **Database:** D1 stores users, session hashes, and each user's JSON library under their user ID. User data never appears in public assets. Uploaded TikTok archives are parsed in the browser; the server stores only the curated ClipAtlas data.
- **Account security:** Passwords are salted and PBKDF2-SHA256-hashed (100,000 iterations (Cloudflare Workers PBKDF2 maximum)), session tokens are random and stored only as SHA-256 hashes, 14-day HttpOnly/Secure/SameSite=Strict cookies. Origin checks for writes; per-IP throttles for sign-ups/logins. The client uses revisions to reject concurrent stale writes.
- **No TikTok sign-in or automated scraping.** Users can import their own exports or paste TikTok URLs.

## Deploy on Cloudflare (one-time setup)

1. Make a free Cloudflare account and install Node.js 20+ and npm on your computer. Download/extract this ZIP, then open a terminal in `clipatlas-cloudflare`.
2. Run `npm install` and `npx wrangler login`. Approve the browser authentication for your Cloudflare account.
3. Run `npx wrangler d1 create clipatlas-db`. Wrangler prints the new D1 database ID.
4. Open `wrangler.toml` and replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with the actual ID.
5. Run `npm run db:remote` to create the tables. **Apply migrations before deploying**.
6. Run `npm test`, then `npm run deploy`.
7. Wrangler prints the real URL, generally `https://clipatlas-planner.<your-cloudflare-subdomain>.workers.dev`. Visit it, register an account, and confirm the library survives a reload. All registrants get separate data.
8. Optional: add a custom domain under **Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Domains & Routes**.

For development, run `npm run db:local` followed by `npm run dev` and test at the local address Wrangler prints. **Do not point development at production D1**. GitHub Pages alone cannot securely host the login/database API.

## Account and data safety

- Accounts require an email address, name, and password of 12–128 characters. The email is used for sign-in only; no email is sent.
- **Email verification and password-reset emails are not implemented yet.** Do not rely on this for unrecoverable personal data: download JSON backups frequently. Admin account recovery is currently a future task.
- To stop public sign-up after you create accounts, set `REGISTRATION_ENABLED = "false"` in `wrangler.toml` and redeploy.
- D1 library uploads are limited to 2 MB and contain curated records, not the entire TikTok account export. Each user has an isolated `user_id`-keyed record.
- If a save conflicts with a different tab or device, the app stops cloud saves and urges you to download a JSON backup before reloading. It does not silently overwrite the other user's changes.
- To import data from the old local-only ClipAtlas: open the hosted site **using the same browser/profile and same origin only if storage permits** and click **Import this browser’s old local library**. A separate origin usually cannot access the original file:// or other website storage; export JSON on the old app and import it into the hosted app instead.
- An encrypted backup/export system, email verification/reset, per-field collaborative merging, itinerary maps, and bulk export processing are future features.

## Test

- `npm test` runs every automated test: the import and itinerary rules in `public/core.js` (the real file, loaded by `tests/load-core.cjs`), the TikTok link reader and lookup in `src/tiktok.js` (with TikTok faked), auto-review in `src/understand.js` (with Workers AI faked), Gemini in `src/gemini.js` and page reading in `src/readpage.js` (with Google and the web faked), and `/api/enrich` and `/api/understand` through the real Worker (with D1 faked).
- `xvfb-run -a node tests/autoreview.mjs` runs auto-review end to end in a headed Chromium: the page shares its own tab, a stand-in TikTok player makes a sound and shows text, and a fake Workers AI checks that it got a 16 kHz WAV with sound and screenshots that show the player. The speed extension is loaded too, and the run checks the measured speed, the retry after a passing player error, the AI use it reports and the message when the allowance runs out.
- `node tests/itinerary.mjs` runs the Itinerary in Chromium: the Overview and Fill the days (with Undo), days, cities per day, + Plan going to the city's day, By city, the export, a reload and a phone screen.
- `node tests/notes.mjs` adds web pages and notes in Chromium against a fake web and a fake Gemini: reading a page, a site that refuses (then pasted text), a typed note, a TikTok pasted as a web link, the places found, the cards, search, Ask, planning, a reload and a phone screen.
- `node tests/browser.mjs` runs the whole site in Chromium against an in-memory stand-in for D1 and a fake TikTok: sign up, paste links, look up, Review mode (TikTok's player replaced by a stub page, with a check that the CSP lets it load), settings, reload. It needs Playwright (`npm i -D playwright && npx playwright install chromium`), so it is not part of `npm test`.

## Static website vs hosted accounts

GitHub Pages is suitable for a personal browser-only app, but accounts cannot safely be created with only static HTML. This version uses Cloudflare Workers for API endpoints and Cloudflare D1 for server-side account records, so users can sign up and open their own private library from different devices.

## Your own categories and tabs

Each account has its own categories (Settings). A category has a name, an emoji and **sort words**:

- A clip whose title, caption, notes or tags contain a category's sort words is sorted there. This happens on import, after a TikTok lookup, and with **Sort Unsorted clips now**. Only Unsorted clips are moved; a category you picked yourself is never changed.
- Separate words with commas. `a+b` needs both words, like `taipei+food`. Words of 4 or more letters, phrases and Chinese match anywhere (so `food` is found in `#taiwanfood`); shorter words match as whole words (`eat` is not found in `seats`).
- The category with the most matching words wins (`a+b` counts as two); a tie goes to the one higher in the list. Each sorted clip shows **Sorted by:** and the words that matched.
- Rename (clips follow), reorder, merge into another category, or delete (clips go to Unsorted). A CSV can bring its own category names; they are added to the list.

**New accounts** pick a starter set: Travel planning, Research, Recipes & cooking, Shopping & finds, or Start empty. It fills in starter categories and tabs, all editable. More starter categories can be added later from Settings; only missing ones are added.

**Accounts from before** this version keep the first version's list (Taiwan · Food, Taiwan · Shopping, Taiwan · Activities, Dates & restaurants, Travel ideas, Points & miles, Other) with sort words, plus any category name their clips use, and keep the Itinerary.

**Tabs:** the Itinerary can be turned off in Settings (planned stops are kept). A research board and a checklist are planned as more tab types.

Stored in the library as `categories: [{id, name, emoji, words}]` and `settings: {purpose, tabs: {itinerary}}`; clips refer to a category by name.

## Itinerary

The **Itinerary** tab (on for the Travel starter) turns saved clips into a draft trip, **place by place**: a TikTok that names several restaurants, shops or sights adds each one on its own, linked back to the TikTok.

- **Places.** Auto-review lists every place a clip names or shows (name, kind, city, country, its street address when the clip says or shows one, a short note on what to get or do there); a clip card says "📍 4 places: …". The kinds are fixed, the same for every trip: 🍜 Food, 🛍️ Shopping, 🏯 Sightseeing, 🎟️ Activities, 🛏️ Stay. **Edit** shows the places to rename, re-kind, move to another city, remove or add; once changed there, a later auto-review leaves them as they are. A clip with no places listed counts as one place (its place or title, its city, and a kind taken from its category). Clips reviewed before places were listed get them from a run with **Also redo** ticked (one Gemini request each).

- **Overview** (the first view when nothing is planned yet) shows what the saved places of a country add up to (pick the country, or Everywhere): how many places in how many cities and from how many clips, the count per kind, and for each city its places per kind and their names. Places with no city yet are counted, with a link to them. Each city gets a number of days, suggested from how many places it has (one day each, most places first, then each extra day to the busiest city; never more days than places) or taken from the days already set; change the numbers and the order (↑ ↓), and choose which kinds go on days. **Fill the days** then puts each city on its days in that order and spreads its places over them: a mix of kinds (one of each in turn, each on the day with the fewest of that kind), named places first, at most 8 stops a day; what does not fit stays in By city. It replaces the current days after asking, and **Undo** in the message puts them back.
- **How many days:** type any number from 1 to 30. Going down asks first; stops on later days move to the new last day, and the cities set for later days are cleared.
- **Cities for each day:** under each day, type a city or pick one from the cities of your saved clips (most-saved first), then press Enter; a day can have several (up to six), and ✕ takes one off. A day with cities says how many clips saved there are not planned yet, with **Show them**. A stop whose city is not one of its day's cities says so ("not in Tainan").
- **+ Plan** in Discoveries puts each of a clip's places on the first day set to its city (else day 1), and the message says which days. A stop made before the clip's places were listed stays one stop for the whole clip, with its places shown and **Give each place its own stop**; picking a day for one of its places in By city does the same.
- **By city** (the switch above the days) lists every saved place by city, separate from the days: cities with the most places first, then each city's places by kind (food, shopping, sightseeing, activities, stay), each with the TikTok it is from and a day picker that plans it on a day, moves it, or takes it off ("Not planned"). "Taipei" and "taipei " count as one city. Places with no city yet are listed last, folded: type a city next to one and press Enter (picked from your saved cities or new) and it moves into that city. **✎** on any place (in By city, and **✎ Edit** on a stop in Days) opens its clip in Edit at that place's city, to fix its city, name, kind or the clip's other details; a place changed there or given a city here is yours, and a later auto-review leaves the clip's places as they are.
- **Where each place is.** A place with an address shows it (📍) in Days and By city. Every place also gets a Google Maps link: 📍 in By city, **Map ↗** (or **📍 Find it on Google Maps ↗**) under a stop in Days. It searches Google Maps for the address when there is one, otherwise for the name, city and country (`mapsUrl` in `public/core.js`); it costs nothing and needs no key. The AI writes down an address only when the clip (or page) says or shows it, never from memory, because a made-up address is worse than none. To add one, paste it from Google Maps into the place's **Address** box in Edit. Gemini's free tier cannot look places up on Google Maps (that tool is paid-only), so addresses are not looked up automatically.
- **Export plan** downloads the days as Markdown, each day headed with its cities (a day with cities but no stops says so), each place with its kind, where it is, its note, its address and Google Maps link, and the TikTok it is from.

Stored in the library as `dayCount` (1 to 30), `dayCities: {"1": ["Taipei"], …}`, `plan: [{id, recordId, placeId?, day, note}]` (no `placeId`: the whole clip) and, on each clip, `places: [{id, name, type, city, country, address, note}]` with `placesBy` (`auto` or `person`); the rules are `placeType`, `cleanPlaces`, `tripItems`, `planDays`, `prunePlan`, `splitClipStop`, `cleanDayCount`, `cleanDayCities`, `dayForClip`, `cityList`, `cityBoard`, `tripCountries`, `tripItemsIn`, `tripOverview`, `suggestDays` and `autoFill` in `public/core.js`. `node tests/itinerary.mjs` checks them in a real browser.

## Auto-review

**✦ Auto-review clips** on the Discoveries page fills clips in by itself. TikTok's export has only links and dates, and TikTok's lookup no longer gives captions, so ClipAtlas finds out what a clip is about the way a person would: it plays it.

1. Press **Start**. The browser asks to share the tab: keep **This tab** and turn on **Also share tab audio** (Chrome or Edge on a computer).
2. Each clip plays in TikTok's official embedded player inside the dialog, silently (the shared sound is not played on the speakers). **Videos play to their end** (at most 10 minutes); the page records the tab's sound and takes a screenshot about every 5 seconds (at least 3, at most 18), none in a clip's first 1.5 seconds. **Slideshows** (photo posts) are walked slide by slide with the player's `navigateTo` command (up to 35 slides). Each slide is screenshotted only once it has finished loading: at least a second after it is asked for, unchanged for 0.8 seconds, not one flat color (a blank, still loading; a plain slide is taken after 5 seconds), and different from the slide before (unless 4 seconds pass; at most 10 seconds). The page asks for slide 2 once after the player loads, so a slideshow answers with `onImageChange` and a video ignores it. TikTok's player offers no playback-speed command to other sites, and a site cannot reach into another site's frame, so faster playback comes from a small browser extension (see **Playback speed** below); auto-review follows the player's clock at any speed and shows the speed it measured. To save time, each clip's AI work runs while the next clips play (at most two waiting), and results are saved in order. A video is done when its clock reaches the end, when it says it ended, or when its clock stops within its last 2 seconds (TikTok's "Watch this video on TikTok" end card); the player is then removed at once. **If the tab is hidden** (another tab, minimized, or covered), the browser stops drawing it, so the clip pauses and carries on when the tab is back.
   **A player that errors, never loads or stops early** (for example `player error 1`, a passing media error) is played once more after 1.5 seconds; only then does the clip count as "would not play" (its badge says "tried twice"). A removed or private clip (`NOT_FOUND`) is not tried again.
3. **Transcript:** the sound is sent a piece (at most 55 seconds) at a time to `/api/transcribe`, which runs Whisper (`@cf/openai/whisper-large-v3-turbo`, OpenAI's speech-to-text model hosted by Cloudflare); quiet pieces are skipped and the pieces' words are joined. **Details:** the screenshots go to `/api/understand` (`src/understand.js`) as sheets of up to three side by side. To spend less of the daily allowance, a slideshow sends every slide (at most 18, sampled evenly), while a video first drops screenshots that look the same as the one before (a still picture) and then sends at most 6 when 30 or more words were said (the words carry it) or at most 12 when not (`pickShots` in `public/core.js`). First **look**: a vision model (`@cf/meta/llama-4-scout-17b-16e-instruct`, else `llama-3.2-11b-vision-instruct`, else `mistral-small-3.1-24b-instruct`) says in plain words what each sheet shows and writes out the text on it. Then **decide**: a text model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, else `llama-3.1-8b-instruct-fp8`, else `@cf/google/gemma-4-26b-a4b-it`; in JSON mode) turns the transcript, what was seen and the account's categories (with their sort words, as examples) into the details. It settles the place, city and country before the category, and is told to prefer a category for the place the clip is in (such as a "Taiwan" one for a shop in Taipei) over general ones such as "Other". Its answer is checked: the category must be one of the account's (else Unsorted), every field has a length limit, and the model is told to fill in places only when they were said or shown (it can still be wrong, which is what the badge is for).
4. The clip gets its title, category (only if it was Unsorted), place, city, country (only where empty), tags, and the text on the video as its caption (if empty). The transcript, that text and a one-line summary are kept and searchable. Notes and anything the person wrote are never replaced.
   The look step writes out every piece of text on the screenshots (the caption, words on the video or slides, signs, menus, prices, names, addresses) once each, leaving out the player's buttons, the like/comment/share/save counts and the music name, and notes the `@name` of the account that posted it, which fills **Creator** when that is empty.
5. **What it finds, as it goes.** While a clip plays, the line under the counts says how far in it is, how many screenshots it has taken and whether sound is coming in (🔊 hearing sound, or 🔇 quiet). When the clip ends, its line in the list says it is being read (by Gemini or Cloudflare, while the next clip plays), and a few seconds later the result takes its place and opens: where it is, the AI's summary, every place it found with its kind, city and note, what was heard, the text on screen and what the pictures show, the new tags, and what it filled in (and which of your own details it kept). The newest result stays open and the earlier ones fold; click one to open it again. A clip already in another category stays there, and when the AI would have chosen a different one, the result says so with a **Move it to …** button.
6. **While it runs**, the dialog shows how long the run has taken, about how long is left and how much of the free AI allowance it has used; each finished clip shows how many words were heard, how many screenshots were taken and read (or slides), how long it took, the speed it played at and whether it took a second try; at the end, the total time, the average per clip, and the AI used per clip with how many clips the free allowance fits. **What was said** also shows in a clip's **Edit** dialog (with **Copy**).
7. **What to get** can be **Transcript only**: just the words, no screenshots read and nothing else changed (details found earlier stay). The transcript shows under **What was said** in Review mode, with a **Copy** button, is searchable, and is a `transcript` column in the CSV export.
8. With **Mark them reviewed** (on by default) the clip counts as reviewed and gets an **✦ Auto-reviewed** badge. The status filter **Auto-reviewed (check these)** lists them; saving one in Review mode removes the badge.

Clips are tried once: a clip that would not play (private or removed) or where nothing was heard or seen is not tried again unless **Also redo** is ticked; failed ones are tried again, and a transcript-only clip is picked up by a later details run. Short links (`vm.tiktok.com`) have no video number and cannot play in the embedded player.

**Gemini (free tier), the first choice when set up.** With a free key from Google, auto-review sends each clip to Google's Gemini API in **one request**: the whole clip's sound (16 kHz WAV; 8 kHz past 5 minutes, so even a 10-minute clip stays under Google's 20 MB), the screenshot sheets (repeats dropped, at most 12 screenshots for a video, every slide of a slideshow up to 18) and the prompt, with the answer's JSON shape and the category limited to your own (`geminiRequest` and `readGeminiAnswer` in `public/core.js`). It writes out what was said, the text on screen, what the screenshots show, the creator, title, summary, place, city, country, category and tags in one go, and the answer is checked like Cloudflare's. **AI** in the auto-review dialog chooses **Gemini, then Cloudflare** (the default when the key is set) or **Cloudflare only**.

- **Limits.** Google sets the free tier's requests per minute and per day by model and project; they are shown in Google AI Studio (Rate limit page), and requests per day start again at midnight Pacific. When Google says to slow down, the clip waits as long as Google asks (at most a minute, up to four times). When a model's requests for today are used up, the next model is tried; when all are, the rest of the run goes to Cloudflare, and the dialog says so with the time Gemini's come back. When both are used up, the run stops and says when each comes back; finished clips are saved, and **Continue** carries on with the rest. The time line counts the Gemini requests of the run.
- **Models.** Each model has its own free daily limit. On a free key in October 2026 the Flash-Lite models allowed 500 requests a day each and the full Flash models 20, so clips go to `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`, `gemini-3.8-flash`, `gemini-3.6-flash` (about 1,000 clips a day in all), and questions about a collection to `gemini-3.8-flash` first. When one model's requests for the day are used up, the next is tried. A model that does not exist on the key, or has no free requests (limit 0), is skipped for an hour. To choose your own, set `GEMINI_MODELS` (clips) or `GEMINI_ASK_MODELS` (questions), comma-separated, to models AI Studio lists.
- **How it is sent.** The page builds the request and the Worker (`/api/gemini`, `src/gemini.js`) passes it on unread, adding the key: reading and re-writing megabytes of base64 would cost more CPU than the Workers Free plan allows. The key never reaches the browser. Only signed-in accounts can use it, only those in `GEMINI_USERS` when that is set, at most twice `AUTO_REVIEW_DAILY_LIMIT` requests per account a day, at most 19 MB each.
- **Privacy.** On the free tier, Google may use what is sent (here, the sound and screenshots of public TikToks) to improve its products, including human review. Do not use it for anything private.
- **Setup (once).**
  1. Open [Google AI Studio](https://aistudio.google.com/apikey), sign in and press **Create API key** (free; it makes a Google Cloud project if you have none). Check the free limits on its Rate limit page.
  2. In Cloudflare: **Workers & Pages → clipatlas-planner → Settings → Variables and Secrets → Add**, type **Secret**, name `GEMINI_API_KEY`, value the key, then **Deploy**. Secrets stay through every later deploy from GitHub.
  3. Recommended: another secret `GEMINI_USERS` with the email you sign in to ClipAtlas with, so only your account can use the key.
  4. Reload ClipAtlas, open **Auto-review**: **AI** shows **Gemini, then Cloudflare**, and **Check the AI setup** has a **Gemini** line with the model that answered.
- **Local AI later.** The page builds the request and reads the answer itself, so a model running on your own computer (in the browser, or Ollama) can be added as another choice that gives the same result.

**Cost and limits.** Workers AI runs on the Cloudflare account the site is deployed on. Its free allowance is 10,000 neurons a day and starts again at midnight UTC (5 PM in California in summer, 4 PM in winter). A real run in October 2026 used about 330 neurons a clip, so about 30 clips a day; with fewer screenshots sent for videos, expect roughly 30 to 50 depending on the mix (videos with plenty said cost least, slideshows most). Each answer from `/api/transcribe` and `/api/understand` says how many neurons it used (`neurons`; from Whisper's minutes of sound and the models' token counts, at the rates on Cloudflare's pricing page; left out when a model does not report its tokens), and the run adds them up. When the allowance is used up, the run stops and says when it comes back in local time; pressing Start again then carries on with the clips not done. On the Workers Paid plan ($5 a month), use beyond the free allowance costs $0.011 per 1,000 neurons, about $3 to $4 per 1,000 clips. Transcripts alone cost only the speech-to-text part, about 200 minutes of sound a day for free. `AUTO_REVIEW_DAILY_LIMIT` (wrangler.toml, default 300) caps clips per account per day (and four times as many transcript pieces). The library is one saved file of at most 2 MB; when it is nearly full, new transcripts are kept to their first 500 characters. Each clip plays in real time (or faster with the extension), so 200 clips of about 45 seconds take about 2.5 hours at normal speed and under 2 at 1.5×; the tab must stay open and on screen.

**Playback speed.** TikTok's embedded player has a speed setting in its own gear menu, but it does not let other sites change it, and a site cannot click inside another site's frame. The **ClipAtlas playback speed** extension (`extension/`, two small files) does it for auto-review: it runs only inside TikTok's embedded player (`https://www.tiktok.com/player/*`), and only when the player's address ends in `#clipatlas-speed=1.5`, which ClipAtlas adds during auto-review (the part after `#` is never sent to TikTok). It sets the video's speed, as the gear menu does, and sets it again if the player changes it back. It reads nothing from the page and sends nothing anywhere; Review mode and TikTok embeds on other sites play at normal speed. To install it in Chrome or Edge: download or clone this repository, open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, press **Load unpacked** and choose the `extension` folder. **Playback speed** in the auto-review dialog picks Normal, 1.5× (the default) or 2×; speech-to-text gets less accurate above about 1.5×. If 1.5× is picked but clips play at normal speed, the dialog says the extension does not seem to be on.

**Setup.** `wrangler.toml` has `[ai] binding = "AI"`; deploying is enough. Workers AI retires models now and then (`llama-3.1-8b-instruct` was retired in May 2026), so each step has a short list of models in `src/understand.js` (`VISION_MODELS`, `TEXT_MODELS`); a retired one is skipped. How the picture goes with the question is not fully documented, so each vision model is tried four ways (OpenAI-style message parts, which llama-4-scout takes and so goes first; prompt with bare base64; messages plus `image`; prompt with a data URL) and the first model and way that work are kept; a reply that says it got no picture does not count. If none works, the run says so and does not try them all again for ten minutes. A model that asks for a one-time "agree" to its license gets it automatically.

**When it fails.** **Check the AI setup** in the auto-review dialog (`/api/aicheck`) tries listen, look and decide once on a test sound and picture and shows each step's result with the service's own error message, then (when the key is set) one Gemini request with the same sound and picture. A failed clip shows the same detail in the run's list (for example `AI problem (look: 5006: …)`) and on its badge, and the browser console logs one line per clip (`ClipAtlas auto-review`). The Worker logs AI errors too (`npx wrangler tail`).

**Privacy.** The sound and screenshots are sent to Cloudflare Workers AI or, when it is set up, Google's Gemini API (see above for what Google may do with free-tier data) for that one request and not stored by ClipAtlas. Nothing is downloaded from TikTok.

## Web pages and notes

A collection can hold more than TikToks. **＋ Add a TikTok, link or note** asks what you are adding:

- **🔗 Web link**: a guide, a blog post, a Reddit thread, a credit-card review. **↧ Read the page** fetches the page once through the Worker (`/api/readpage`, `src/readpage.js`) and puts its text in the box, without its menus, scripts, forms and footer; it fills in the title when that is empty. Saving without pressing it reads the page then. Some sites refuse to be read by a server (Reddit often does), and pages that only show their text with JavaScript have none to read; ClipAtlas says so and does not work around it. Paste the text into the box instead (Edit), and it is read from that. Tracking parts of the link (`utm_…`, `fbclid` and the like) are dropped, and the same page cannot be saved twice.
- **📝 Note**: anything typed in, such as a friend's list of places or opening hours copied from a guide.

**The AI reads them.** After a page or note is saved, or its text changes, the AI reads it the way auto-review reads a clip, from its text alone: a title and summary, the category (from your categories), tags and **every place it names**, each with its kind, city and a short note. Gemini goes first (one request; `geminiTextRequest` in `public/core.js`), then Cloudflare's text model (`/api/understand` with the text and no pictures). What you wrote is kept, and places you edited are not replaced. **✦ Read** on the card reads it again.

**Where they show up.**

- **Cards** say 🔗 WEB PAGE or 📝 NOTE, with ✦ Read once the AI has read them. A page's card has **↗ Open** (the page) instead of Watch.
- **Search** finds words in their text.
- **Ask** uses them as sources alongside the clips, with up to 12,000 characters of each one's text.
- **Itinerary:** **+ Plan** and By city work on their places. A stop links back to the page it is from, or says "From your note".

They are not counted in "Needs review", and Review mode, auto-review and the TikTok lookup skip them. Something added while a collection is open goes into that collection.

**Limits.** The Worker reads at most 100 pages per account a day, each within 10 seconds and 1.5 MB, from public addresses only: no TikTok links (TikToks are saved as TikToks), no private network addresses, IP numbers or unusual ports. At most 20,000 characters of a page's text are kept. The library is one saved file of at most 2 MB; when it is nearly full, only the first 3,000 characters of a new page are kept, and ClipAtlas says so.

Stored on each item as `kind` (`link` or `note`; a TikTok has none), `body` (the text) and `readAt`. A note has no link; its key is `note:<id>`. `node tests/notes.mjs` checks all of this in a real browser.

## Ask about a collection

**✦ Ask about …** above the clip cards answers any question from what a collection holds (or all your clips, with no collection open): "Where should I eat in Tainan?", "Which places do several sources recommend?", "Sort everything by city, then food, sights, activities and shopping", or for a points-and-cards collection "Which card should I get next?". The page numbers the items (newest saved first) and sends, for each, its title, category, city, places with their notes, summary, the text on screen, what was said, its caption, your notes and its link (`askSources` and `askPrompt` in `public/core.js`). The AI is told to answer only from those, to cite them like [3], to say when they don't cover something (general knowledge is labeled as such), and for money, health or legal questions to report what the sources say, that it may be out of date, and not to present it as personal advice. The answer shows with each number linking to its clip (a note opens in Edit); it is kept with the collection (the newest 40 questions in all), with **Ask again** (with the clips as they are now) and **Delete**.

Gemini answers first, on the stronger models (`gemini-3.8-flash`, then `gemini-3.6-flash`, then the Flash-Lite ones; `GEMINI_ASK_MODELS` to change), with up to 400,000 characters of sources. When Gemini can't (used up for today, or not set up), Cloudflare's text model answers through `/api/ask` with shorter sources (60,000 characters; at most 60 questions per account a day). Ctrl+Enter asks.

## Choosing many clips

**☐ Select** above the clip cards turns on checkboxes: click cards to pick them, or **Select all shown** (with a category filter on, it reads "Select all 23 in 🍜 Food"). Then **Move to category**, **Add to collection** (an existing one or a new one; the same menu can take them out of a collection they are in), **Mark reviewed**, or **Delete**. Deleting asks first and can be undone for 12 seconds from the message that follows. In Settings, the clip count next to each category ("12 clips") jumps to Discoveries with that category's clips already selected, so deleting a whole category's clips is two clicks.

## Review mode

The main way to fill in clips. **▶ Review clips** on the Discoveries page (or **▶ Watch** on any card) opens each clip in TikTok's official embedded player (`https://www.tiktok.com/player/v1/<video id>`) beside a short form: title, category, place, city, country, tags, collections, notes and caption.

- **Which clips:** Needs review (default), Unsorted, All clips, any collection, or, from **Watch**, the clips on screen with the current filters, starting at that card. Newest saved first.
- **Category suggestions:** as you type, the categories' sort words suggest a category. For a clip that was Unsorted the suggestion is picked for you until you choose one yourself, and the card later shows "Sorted by: …". For any other clip it is offered with a **Use it** button.
- **Keys:** Enter saves and goes to the next clip (Ctrl/⌘+Enter also works inside the notes boxes), Ctrl/⌘+→ skips, Ctrl/⌘+← goes back, Esc closes. Leaving a clip with unsaved changes asks first. "Mark as reviewed when I save" is on by default.
- **Nothing is looked up.** The video plays in the viewer's own browser straight from TikTok, so there is no rate limit and nothing goes through the Worker. Private or removed videos show TikTok's own message in the player. Short links (`vm.tiktok.com/…`) have no video number, so they show a note and an **Open on TikTok** link instead.
- The page's Content Security Policy allows frames only from `https://www.tiktok.com`.

## Automatic lookup (optional)

Under **Automatic lookup (optional)** on the Discoveries page, choose **Look up unreviewed links**. As of October 2026 TikTok's oEmbed answers most lookups with no title or creator and rate-limits the Worker, so this usually finds little; Review mode is the dependable way. It looks up the next **40** links that need it, one at a time, and saves after each one; click again for the next batch. **View filled-in clips** jumps to the ones that got details, and the **analysis** filter shows any group.

How a link is looked up (`src/tiktok.js`):

1. **Cleaned and read.** Invisible characters (zero-width spaces, non-breaking spaces), wrapping `<>` or quotes, trailing punctuation and tracking parameters are removed. Accepted: `/@creator/video/ID`, the export's share links `/share/video/ID` on `tiktok.com` **and `tiktokv.com`**, `/video/ID`, `/v/ID.html`, `/embed/v2/ID`, photo posts, and `vm.`/`vt.tiktok.com` and `/t/` short links. `http://` is upgraded to `https://`.
2. **Full address.** A share or short link has no creator handle, so the Worker asks TikTok where it leads (plain requests, at most 3 redirects, TikTok hosts only) and uses the address with the handle. The handle is never made up.
3. **oEmbed.** TikTok's documented oEmbed endpoint is asked about that address (or the share link, if TikTok did not redirect). A rate limit (429) stops the batch at once.

Every clip keeps what happened (`enrichment: {status, reason, retryable, at}`), shown as a badge:

| Badge | Status | Reasons | Looked up again |
|---|---|---|---|
| Filled in | `enriched` | TikTok returned a title or creator | no |
| No useful details | `empty` | `EMPTY_METADATA`: TikTok answered with no title and no creator | after a week |
| Not public or removed | `unavailable` | `NOT_PUBLIC` | after a week |
| Lookup failed | `failed` | `RATE_LIMITED`, `TIMEOUT`, `TIKTOK_ERROR`, `BAD_RESPONSE` | next run |
| Link not accepted | `rejected` | `NOT_TIKTOK_LINK`, `NO_VIDEO_IN_LINK`, `INVALID_URL`, `LINK_TOO_LONG`, `LINK_HAS_LOGIN` | next run |

Only `enriched` counts as filled in; the first version also counted empty answers. Clips analyzed by that version are sorted into these groups automatically, and its empty "successes" are looked up again. When TikTok gives the full address, the clip's link is updated to it (the original stays in `originalUrl`).

A conservative keyword classifier suggests category, city, country and hashtags **only from the returned title**. It does not invent venue names, prices, addresses, transcripts or on-screen text. Existing non-blank fields and Reviewed clips are kept. The Worker allows 180 lookups per account per hour.
