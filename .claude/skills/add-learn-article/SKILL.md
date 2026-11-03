---
name: add-learn-article
description: Add or edit a Learn article or glossary term in the SO-101 Suite (app/suite/js/content/learn.js and glossary.js), shown in the app's Learn section, the command palette and the website. Use when asked to "add a Learn article", "write a tutorial or explainer", "document a concept for beginners", "add a glossary term", or "explain X in the app".
---

# Add a Learn article

Articles are plain data in `app/suite/js/content/learn.js` (default export: an array). The app (`#/learn`, `#/learn/<id>`), the command palette and the website (`/learn/<id>/`, read at build time) all pick a new article up by themselves: no registration. Write it with `explain-for-beginners` (voice, terms); hands-on steps with `write-physical-instructions`.

## Procedure

1. **Read** two existing articles in `learn.js` (for example `meet-your-arm`, `safety-checklist`) and the terminology table in `docs/design/information-architecture.md` section 7.
2. **Add an object to the array** (order in the array is the order of the Previous/Next links):

   ```js
   {
     id: "how-leader-follower-sync",        // kebab-case, unique; it is the URL
     title: "How the follower copies the leader",
     level: "start",                         // "start" | "next" | "deep"  (hub sections: Start here, Next up, Go deeper)
     minutes: 4,                             // honest reading time
     summary: "One or two plain sentences that make someone want to read it.",
     body: [
       "A paragraph. May use <b>, <i>, <code> and #/ hash links.",
       { list: ["item one", "item two"] },
       { steps: ["Do one thing.", "Do the next thing."] },          // numbered; one action each
       { callout: { kind: "tip", text: "..." } }                    // kind: tip | warn | safety | why | ok
     ],
     links: [{ label: "Why calibrate", href: "#/learn/why-calibrate" }, { label: "Official guide", href: "https://huggingface.co/docs/lerobot/so101" }]
   }
   ```
3. **Rules for the text:** second person, short sentences, define each new word once; use the inline tags `<b> <i> <code>` (the header of `learn.js` allows only those; `rich()` in `app/suite/js/ui.js` and the site also accept `<em> <strong> <kbd> <br> <a href>`); internal links are hash routes (`#/learn/<id>`, `#/glossary/<id>`, `#/calibrate`); external links are full `https://` URLs and open in a new tab. No unverifiable claims (no counts, prices, benchmarks). Link the official sources rather than copying them. No personal data.
4. **Glossary:** a word a beginner may not know needs an entry in `app/suite/js/content/glossary.js`: `{ id, term, short, long, see: [other ids] }` (`short` is one sentence, `long` a short paragraph; every `see` id must exist). First mentions of glossary terms inside articles become tap-to-explain links automatically (up to 14 per article); a word that is also an everyday word is excluded in the `NO_AUTO` list in `app/suite/js/pages/learn.js`.
5. **Safety content** (anything that can move, drop or pinch) goes first in a `safety` callout and follows `docs/LEARNINGS.md`; never contradict it.
6. **Check it:** run the demo (`uv run so101 start --demo --no-browser --port 8150`, or no backend with `?demo=1`) and open `#/learn/<id>` at 1280 px and 360 px, dark and light: it renders, links work, callouts read well, the next/previous cards make sense, the palette (Cmd/Ctrl+K) finds it, and the console is clean. Stop the server.
7. **Website (if you can):** `cd site && pnpm build && pnpm check` (broken links and missing alt text fail it).
8. **Update** `docs/FAQ.md` or `docs/TROUBLESHOOTING.md` if the article answers a recurring question.

## Verify

```bash
node --test "tests/js/*.test.mjs"                       # the mock still passes
node -e "import('./app/suite/js/content/learn.js').then(m => console.log(m.default.map(a => a.id + ' (' + a.level + ')').join('\n')))"   # the file still loads; your id is in the list
```

Done when: the article loads in the app and on the site build, every link resolves, every new word is in the glossary, tests green, and you stated what you could not verify (for example claims about hardware you could not test).
