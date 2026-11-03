# SO-101 Suite website

The public site and the no-install demo for SO-101 Suite. A static [Astro](https://astro.build) site, served by Cloudflare.
No Tailwind, no UI library, no web fonts, no analytics, no third-party scripts. Plain CSS (the same design tokens as the app), a few kilobytes of vanilla JavaScript, inline SVG icons.

## Requirements

- Node 22.12 or newer (Astro 6). The latest Astro (7) needs Node 22.23.4 or newer, so this site uses Astro 6 until your Node is that new.
- [pnpm](https://pnpm.io). Run everything from this `site/` folder.

```bash
pnpm install        # astro and @astrojs/sitemap, nothing else
pnpm dev            # http://localhost:8140  (syncs the app first)
pnpm build          # writes dist/
pnpm preview        # http://localhost:8141  (serves dist/)
pnpm check          # scans dist/ for broken links, missing alt text and other problems; exits non-zero on any
```

## How the demo works

`/demo` is a full-screen iframe of `/app/?demo=1`. `/app` is a copy of the real app, with no changes, running its in-browser mock backend.

`scripts/sync-app.mjs` (run by `pnpm dev` and `pnpm build`, or by hand with `pnpm sync`) copies:

| From | To |
|---|---|
| `../app/suite` | `public/app` |
| `../app/vendor` | `public/app/vendor` |
| `../app/assets` (URDF, STL, images, licence files only) | `public/app/assets` |
| `../docs/screenshots/*.png` | `public/screenshots` |

It is idempotent (unchanged files are skipped, removed files are removed) and uses copy-on-write clones where the filesystem has them. `public/app` and `public/screenshots` are generated and git-ignored.

Deep links work: `/demo/#/calibrate` opens the app on the Calibrate page, and `/demo/?scenario=ready&seed=7` is passed through to the app.

## Content comes from the repository

| Page | Source | If it is missing |
|---|---|---|
| `/learn`, `/learn/<id>` | `../app/suite/js/content/learn.js` | One build warning, and the page says the articles are being written |
| `/glossary` | `../app/suite/js/content/glossary.js` | Same |
| Parts list on `/learn` | `../app/suite/js/content/anatomy.js` | Section is left out |
| `/docs`, `/docs/<id>` | `../docs/**/*.md` (not `superpowers/`, `design/`, `screenshots/`, `LEARNINGS.md`, `README.md`) | Empty state with links to GitHub |
| `/modules` | `../modules/*/module.json` | Only the built-in Pick and place card |
| Screenshots | `../docs/screenshots/<name>.png` | A tidy placeholder (see `<Shot>`), never a broken image |

The docs get their links fixed for the web: `other.md` becomes `/docs/other/`, `docs/screenshots/x.png` becomes `/screenshots/x.png`, any other repo file becomes a GitHub link (`src/plugins/rewrite-doc-links.mjs`).
Learn and glossary strings may use `<b> <i> <em> <strong> <code> <kbd> <br> <a>`. Hash links such as `#/glossary` or `#/calibrate` are mapped to the matching site page or to `/demo/#/calibrate`.

## Social preview image

`/og` is a 1200 by 630 page made for a screenshot. Capture it at exactly that size and save it as `public/og.png`. Every page already points at `/og.png`, and `pnpm check` warns until the file exists.

## Configuration

- `SITE_URL` (environment variable at build time) sets the canonical domain used in links, Open Graph tags, the sitemap and `robots.txt`. The default is `https://so101-suite.wendor-d8f.workers.dev`.
- `public/_headers` has a strict Content-Security-Policy (`script-src 'self'`: the site has no inline scripts), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and cache rules. Hashed files under `/_astro` and the big static files under `/app/assets` and `/app/vendor` are cached for a year. Screenshots for a day, and the app's own JS and CSS for an hour, because they keep their file names.
- `public/_redirects` has a few short links (`/try`, `/install`, `/github`).
- Astro telemetry is switched off by `scripts/astro.mjs`, which every script goes through.
- Build output with Astro 6.4 prints one notice that `markdown.remarkPlugins` is deprecated. It still works; moving it needs `@astrojs/markdown-remark` as a direct dependency, which this project avoids.

## Deploy (Cloudflare)

The site is plain static files, served by Cloudflare as a Worker with static assets. Nothing here deploys by itself; `wrangler.jsonc` says what to publish (`dist/`, with the `404.html` page for unknown addresses). The live site is at <https://so101-suite.wendor-d8f.workers.dev>.

```bash
cd site
pnpm install
pnpm build && pnpm check                       # builds dist/ and checks every link
SITE_URL=https://your-domain.example pnpm build    # only if you serve it from your own domain
npx wrangler login                             # once; opens a browser
npx wrangler deploy                            # publishes dist/ as the Worker named in wrangler.jsonc
```

- The build needs the rest of the repository next to `site/`, because it reads `../app`, `../docs` and `../modules`.
- `SITE_URL` sets the canonical address (links, Open Graph tags, sitemap, `robots.txt`). Change `name` in `wrangler.jsonc` to publish under another Worker name, and add your own domain in the Cloudflare dashboard (Workers > your Worker > Settings > Domains).
- `public/_headers` and `public/_redirects` are honoured by Cloudflare static assets, so the security headers and short links work as they do locally.
- Node: `.node-version` asks for 22 (22.12 or newer).

## Layout

```
astro.config.mjs        site URL, sitemap, trailing slashes, Shiki themes, link plugin
public/                 _headers, _redirects, favicon (app/ and screenshots/ appear here after sync)
scripts/                sync-app.mjs, check.mjs, astro.mjs (runs the Astro CLI with telemetry off)
src/content.config.ts   the docs collection
src/data/               site facts and FAQ, content loaders (learn, glossary, anatomy, modules), docs loader
src/components/         Header, Footer, Icon, ArmArt (hero SVG), InstallTabs, Shot, LearnBody, ...
src/layouts/Base.astro  head, meta, JSON-LD, skip link
src/pages/              one file per route
src/scripts/            theme-init.js (runs before paint), site.js (theme, tabs, copy, glossary filter), demo.js
src/styles/site.css     tokens (same as app/suite/css/suite.css), layout and components
```
