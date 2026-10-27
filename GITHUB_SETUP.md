# ClipAtlas — create and connect GitHub repository

This folder is a standalone source repository for your **existing** Cloudflare Worker. It does **not** contain Cloudflare account credentials, users, D1 contents, or the local Wrangler authentication state.

## 1. Create the repository

At https://github.com/new, create `ClipAtlas` under `epoon2`, preferably **Private** initially. Do not initialize with a README, .gitignore or license (this folder already has them).

## 2. Connect this local folder

Open PowerShell in the **folder containing `package.json`** and run:

```powershell
git init
git branch -M main
git add .
git status
git commit -m "Initial ClipAtlas Cloudflare app"
git remote add origin https://github.com/epoon2/ClipAtlas.git
git push -u origin main
```

If `git commit` asks for your Git identity, configure `git config --global user.name` and `git config --global user.email` with your own GitHub identity. Sign in if Git requests authorization.

## 3. Preserve the current production website

`wrangler.toml` ships with a **placeholder** `database_id`. Before deploying, replace it with the **existing** `clipatlas-db` database ID currently in your working project (see your Cloudflare dashboard or `npx wrangler d1 list`). **Do not create a second database.**

```powershell
npm.cmd install
npm.cmd test
npm.cmd run deploy
```

Do not re-run the initial D1 schema migration on the existing database unless you add a new migration. Deployment still requires your existing Cloudflare login. The GitHub push does not automatically deploy the site.

## 4. Future work

Keep feature branches separate from `main` and test before merging. If you later connect GitHub to Cloudflare for automatic deployment, make sure its build command, D1 binding and branch settings match your deployed Worker. Avoid copying actual TikTok account exports or account backups into this repository.
