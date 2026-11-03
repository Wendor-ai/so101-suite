import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const base = (site ?? new URL('https://so101-suite.pages.dev')).origin;
  const body = `User-agent: *
Allow: /
Disallow: /app/
Disallow: /og/

Sitemap: ${base}/sitemap-index.xml
`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
