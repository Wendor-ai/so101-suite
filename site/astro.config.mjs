import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteDocLinks } from './src/plugins/rewrite-doc-links.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Set SITE_URL at build time to your real domain (canonical links, Open Graph and the sitemap use it).
const site = (process.env.SITE_URL || 'https://so101-suite.pages.dev').replace(/\/+$/, '');

export default defineConfig({
  site,
  trailingSlash: 'always',
  compressHTML: true,
  devToolbar: { enabled: false },
  build: { format: 'directory', inlineStylesheets: 'never' },
  integrations: [
    sitemap({
      // /404 and the social-card page are not for search results.
      filter: (page) => !/\/(404|og)\/?$/.test(new URL(page).pathname),
    }),
  ],
  markdown: {
    shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false, wrap: false },
    remarkPlugins: [rewriteDocLinks],
  },
  vite: {
    // Never inline scripts/assets as data: URIs, so the Content-Security-Policy can say script-src 'self' only.
    build: { assetsInlineLimit: 0 },
    // Content for Learn / Glossary lives in ../app and ../docs.
    server: { fs: { allow: [path.resolve(here, '..')] } },
  },
});
