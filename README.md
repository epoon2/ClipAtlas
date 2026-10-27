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

`npm test` runs the original import/de-duplication/itinerary core tests. Cloud authentication and D1 integration need to be manually smoke-tested after `wrangler dev` because the test suite does not yet emulate D1 or the Cloudflare runtime.

## Static website vs hosted accounts

GitHub Pages is suitable for a personal browser-only app, but accounts cannot safely be created with only static HTML. This version uses Cloudflare Workers for API endpoints and Cloudflare D1 for server-side account records, so users can sign up and open their own private library from different devices.

## Automatic metadata enrichment (new)

After signing in and importing TikTok links, choose **Analyze unreviewed links** on the Discoveries page. The authenticated Cloudflare Worker requests TikTok's official public `oEmbed` endpoint for each HTTPS TikTok URL. A conservative keyword classifier infers category, city, country and hashtags **only from returned title/caption text**. It also fills creator and title when available. It does not fabricate venue names, descriptions, prices, addresses, audio transcripts, or on-screen text. Existing nonblank fields and Reviewed status are preserved.

Unreachable, private, deleted, unresolvable short links and TikTok request failures remain unverified and need manual review. API is rate limited (180 metadata requests per signed-in account per hour) and processes one request at a time. Export a backup before large imports. No external AI provider or TikTok API key is required. Deploy this updated Worker and static assets using `npm run deploy`.
