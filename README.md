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

- `npm test` runs every automated test: the import and itinerary rules in `public/core.js` (the real file, loaded by `tests/load-core.cjs`), the TikTok link reader and lookup in `src/tiktok.js` (with TikTok faked), auto-review in `src/understand.js` (with Workers AI faked), and `/api/enrich` and `/api/understand` through the real Worker (with D1 faked).
- `xvfb-run -a node tests/autoreview.mjs` runs auto-review end to end in a headed Chromium: the page shares its own tab, a stand-in TikTok player makes a sound and shows text, and a fake Workers AI checks that it got a 16 kHz WAV with sound and screenshots that show the player.
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

## Auto-review

**✦ Auto-review clips** on the Discoveries page fills clips in by itself. TikTok's export has only links and dates, and TikTok's lookup no longer gives captions, so ClipAtlas finds out what a clip is about the way a person would: it plays it.

1. Press **Start**. The browser asks to share the tab: keep **This tab** and turn on **Also share tab audio** (Chrome or Edge on a computer).
2. Each clip plays in TikTok's official embedded player inside the dialog, silently (the shared sound is not played on the speakers). **Videos play to their end** (at most 10 minutes); the page records the tab's sound and takes a screenshot about every 5 seconds (at least 3, at most 18), none in a clip's first 1.5 seconds. **Slideshows** (photo posts) are walked slide by slide with the player's `navigateTo` command (up to 35 slides). Each slide is screenshotted only once it has finished loading: at least a second after it is asked for, unchanged for 0.8 seconds, not one flat color (a blank, still loading; a plain slide is taken after 5 seconds), and different from the slide before (unless 4 seconds pass; at most 10 seconds). The page asks for slide 2 once after the player loads, so a slideshow answers with `onImageChange` and a video ignores it. TikTok's player offers no playback-speed command to other sites (its own gear menu has one, which a person can set by hand; auto-review follows the player's clock at any speed). To save time, each clip's AI work runs while the next clips play (at most two waiting), and results are saved in order. A video is done when its clock reaches the end, when it says it ended, or when its clock stops within its last 2 seconds (TikTok's "Watch this video on TikTok" end card); the player is then removed at once. **If the tab is hidden** (another tab, minimized, or covered), the browser stops drawing it, so the clip pauses and carries on when the tab is back.
3. **Transcript:** the sound is sent a piece (at most 55 seconds) at a time to `/api/transcribe`, which runs Whisper (`@cf/openai/whisper-large-v3-turbo`, OpenAI's speech-to-text model hosted by Cloudflare); quiet pieces are skipped and the pieces' words are joined. **Details:** the screenshots go to `/api/understand` (`src/understand.js`) as sheets of up to three side by side (at most six sheets; a longer slideshow is sampled evenly). First **look**: a vision model (`@cf/meta/llama-4-scout-17b-16e-instruct`, else `llama-3.2-11b-vision-instruct`, else `mistral-small-3.1-24b-instruct`) says in plain words what each sheet shows and writes out the text on it. Then **decide**: a text model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, else `llama-3.1-8b-instruct-fp8`, else `@cf/google/gemma-4-26b-a4b-it`; in JSON mode) turns the transcript, what was seen and the account's categories (with their sort words) into the details. Its answer is checked: the category must be one of the account's (else Unsorted), every field has a length limit, and the model is told to fill in places only when they were said or shown (it can still be wrong, which is what the badge is for).
4. The clip gets its title, category (only if it was Unsorted), place, city, country (only where empty), tags, and the text on the video as its caption (if empty). The transcript, that text and a one-line summary are kept and searchable. Notes and anything the person wrote are never replaced.
   The look step writes out every piece of text on the screenshots (the caption, words on the video or slides, signs, menus, prices, names, addresses) once each, leaving out the player's buttons, the like/comment/share/save counts and the music name, and notes the `@name` of the account that posted it, which fills **Creator** when that is empty.
5. **While it runs**, the dialog shows how long the run has taken and about how long is left; each finished clip shows how many words were heard, how many screenshots or slides were read and how long it took; at the end, the total time and the average per clip. **What was said** also shows in a clip's **Edit** dialog (with **Copy**).
6. **What to get** can be **Transcript only**: just the words, no screenshots read and nothing else changed (details found earlier stay). The transcript shows under **What was said** in Review mode, with a **Copy** button, is searchable, and is a `transcript` column in the CSV export.
7. With **Mark them reviewed** (on by default) the clip counts as reviewed and gets an **✦ Auto-reviewed** badge. The status filter **Auto-reviewed (check these)** lists them; saving one in Review mode removes the badge.

Clips are tried once: a clip that would not play (private or removed) or where nothing was heard or seen is not tried again unless **Also redo** is ticked; failed ones are tried again, and a transcript-only clip is picked up by a later details run. Short links (`vm.tiktok.com`) have no video number and cannot play in the embedded player.

**Cost and limits.** Workers AI runs on the Cloudflare account the site is deployed on. About $0.0008 of AI per clip, so the free daily allowance (10,000 neurons) covers roughly 100 to 150 clips a day; when it is used up, the run stops with a message and continues the next day. Transcripts alone cost only the speech-to-text part, about 200 minutes of sound a day for free. `AUTO_REVIEW_DAILY_LIMIT` (wrangler.toml, default 300) caps clips per account per day (and four times as many transcript pieces). The library is one saved file of at most 2 MB; when it is nearly full, new transcripts are kept to their first 500 characters. Each clip plays in real time, so 200 clips of about 45 seconds take about 2.5 hours; the tab must stay open and on screen.

**Setup.** `wrangler.toml` has `[ai] binding = "AI"`; deploying is enough. Workers AI retires models now and then (`llama-3.1-8b-instruct` was retired in May 2026), so each step has a short list of models in `src/understand.js` (`VISION_MODELS`, `TEXT_MODELS`); a retired one is skipped. How the picture goes with the question is not fully documented, so each vision model is tried four ways (prompt with bare base64, OpenAI-style message parts, messages plus `image`, prompt with a data URL) and the first model and way that work are kept; a reply that says it got no picture does not count. If none works, the run says so and does not try them all again for ten minutes. A model that asks for a one-time "agree" to its license gets it automatically.

**When it fails.** **Check the AI setup** in the auto-review dialog (`/api/aicheck`) tries listen, look and decide once on a test sound and picture and shows each step's result with the service's own error message. A failed clip shows the same detail in the run's list (for example `AI problem (look: 5006: …)`) and on its badge, and the browser console logs one line per clip (`ClipAtlas auto-review`). The Worker logs AI errors too (`npx wrangler tail`).

**Privacy.** The sound and screenshots are sent to Cloudflare Workers AI for that one request and not stored by ClipAtlas. Nothing is downloaded from TikTok.

## Choosing many clips

**☐ Select** above the clip cards turns on checkboxes: click cards to pick them, or **Select all shown** (with a category filter on, it reads "Select all 23 in 🍜 Food"). Then **Move to category**, **Mark reviewed**, or **Delete**. Deleting asks first and can be undone for 12 seconds from the message that follows. In Settings, the clip count next to each category ("12 clips") jumps to Discoveries with that category's clips already selected, so deleting a whole category's clips is two clicks.

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
