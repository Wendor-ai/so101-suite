// Docs collection: every markdown file in ../docs except internal material.
// docs/superpowers (specs and plans) and docs/design (internal design notes) are not published, and
// LEARNINGS.md is the owner's first-person engineering log. Its lessons reach readers through the Learn articles instead.
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const docs = defineCollection({
  loader: glob({
    pattern: ['**/*.{md,mdx}', '!superpowers/**', '!design/**', '!screenshots/**', '!LEARNINGS.md', '!**/README.md', '!**/_*'],
    base: process.env.SITE_DOCS_DIR || '../docs', // SITE_DOCS_DIR is only for testing the pipeline with sample files
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    order: z.number().optional(),
  }),
});

export const collections = { docs };
