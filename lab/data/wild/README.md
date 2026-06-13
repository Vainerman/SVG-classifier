# Test-Wild set — real-website icons

The deployment-distribution set (plan §5.6). **This is the primary KPI** — release is
gated on Test-Wild accuracy, not on in-distribution library accuracy (§5.9). It is also the
engine of the iteration loop (§5.10): harvest hard real-web icons → extend taxonomy → retrain.

Unlike `../raw/` (filename = label), real-site icons have **no filename label**. We bootstrap
**weak labels** from the icon's own accessible name — `aria-label`, `<title>`,
`aria-labelledby`, an `icon-*` class, or a `<use>`/`<img>` source filename. These are exactly
the extension's *free-label* signals (§4.6 step 4). Weak labels **must be human-reviewed**
before counting as ground truth (`reviewed: true` in `manifest.jsonl`).

## Harvest recipe

**1. Extract on a live page** — run this in the page console (or via the Chrome MCP
`javascript_tool`) on a target site, then copy the JSON it logs:

```js
JSON.stringify([...document.querySelectorAll('svg')].flatMap(svg => {
  const byId = id => id && (document.getElementById(id)?.textContent || '').trim();
  const cls = [...svg.classList].find(c => /^(icon[-_])|[-_]icon$/.test(c));
  const name =
    svg.getAttribute('aria-label') ||
    svg.querySelector('title')?.textContent ||
    byId(svg.getAttribute('aria-labelledby')) ||
    svg.closest('[aria-label]')?.getAttribute('aria-label') ||
    svg.closest('button,a')?.getAttribute('title') ||
    (cls ? cls.replace(/(^icon[-_])|([-_]icon$)/,'') : '') ||
    (svg.querySelector('use')?.getAttribute('href')?.split('#').pop() || '');
  if (!name || !name.trim()) return [];                 // keep only weakly-labeled
  const src = svg.getAttribute('aria-label') ? 'aria-label'
            : svg.querySelector('title') ? 'title'
            : cls ? 'class' : 'other';
  return [{ svg: svg.outerHTML, name: name.trim(), name_source: src, page_url: location.href }];
}))
```

**2. Ingest** — save the JSON to `harvest.json` (or pipe it) and run:

```bash
python3 ingest_wild.py harvest.json      # writes raw/<site>/*.svg + appends manifest.jsonl
```

Dedup is by normalized-SVG hash, so re-running across many pages accumulates uniques.

**3. Review** — open `manifest.jsonl`, verify each `label` against the glyph, fix mistakes,
set `"reviewed": true`. Only `reviewed` rows should enter the Test-Wild evaluation split.

## manifest.jsonl schema

```jsonc
{ "path": "raw/github-com/home-1a2b3c4d.svg", "svg_hash": "…", "label": "home",
  "name_source": "aria-label", "page_url": "https://github.com/", "site": "github-com",
  "reviewed": false }
```

## Status

Empty — awaiting a harvest pass over a sample of popular sites. The library data in `../raw/`
is sufficient to start training (Train/Val/Test-ID/Test-OOD); fill this in before trusting
deployment numbers.
