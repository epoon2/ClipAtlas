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
- An encrypted backup/export system, email verification/reset, per-field collaborative merging, automated video metadata enrichment, itinerary maps, and bulk export processing are future features.

## Test

- `npm test` runs every automated test: the import and itinerary rules in `public/core.js` (the real file, loaded by `tests/load-core.cjs`), the TikTok link reader and lookup in `src/tiktok.js` (with TikTok faked), and `/api/enrich` through the real Worker (with D1 faked).
- `node tests/browser.mjs` runs the whole site in Chromium against an in-memory stand-in for D1 and a fake TikTok: sign up, paste links, analyze, filter, reload. It needs Playwright (`npm i -D playwright && npx playwright install chromium`), so it is not part of `npm test`.

## Static website vs hosted accounts

GitHub Pages is suitable for a personal browser-only app, but accounts cannot safely be created with only static HTML. This version uses Cloudflare Workers for API endpoints and Cloudflare D1 for server-side account records, so users can sign up and open their own private library from different devices.

## Automatic metadata enrichment

After signing in and importing TikTok links, choose **Analyze unreviewed links** on the Discoveries page. It looks up the next **40** links that need it, one at a time, and saves after each one; click again for the next batch. **View filled-in clips** jumps to the ones that got details, and the **analysis** filter shows any group.

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
