# Dashboard deployment

## Current state

- Workflow at `.github/workflows/pages.yml` deploys `dashboard/` plus
  the small JSON manifests + extracted text + markdown to GitHub Pages
  on every relevant master push.
- The PDF binaries themselves are NOT in the deployment — they live in
  the GitHub Release at
  `https://github.com/omgitzyeoku-collab/UFO/releases/tag/v1.0-release-01-mirror`
  and the dashboard's inline pdf.js viewer fetches from there.

## GitHub Pages note

Pages is **not available on the free plan for private repos**. The
workflow is ready; it'll deploy the moment one of these conditions is
met:

1. Repo is made public (`gh repo edit omgitzyeoku-collab/UFO --visibility public`)
2. Account upgrades to GitHub Pro ($4/month)
3. Repo moves to a Pro/Team/Enterprise org

If none of those, the deployment alternatives below all work for free
with private repos.

## Alternatives for free private hosting

### Cloudflare Pages (recommended)
1. Sign in at <https://pages.cloudflare.com>
2. Connect GitHub → authorise omgitzyeoku-collab/UFO
3. Build command: empty
4. Build output directory: `_site` (or copy the bash from
   `.github/workflows/pages.yml` step "Stage site" into a build script)
5. Deploy. Custom domain free.

### Vercel
1. Sign in at <https://vercel.com> with GitHub
2. Import omgitzyeoku-collab/UFO
3. Set output directory equivalent to the workflow's `_site/`
4. Deploy.

### Netlify
1. Sign in at <https://netlify.com>
2. New site from Git → omgitzyeoku-collab/UFO
3. Build command: equivalent to workflow stage step
4. Publish directory: `_site`

## Run locally now

The dashboard already works locally:
```
cd dashboard && node serve.mjs
# → http://localhost:4173/
```
