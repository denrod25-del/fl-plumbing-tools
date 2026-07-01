# AuditScout — Internal Site QA

AuditScout is an **additive, internal** quality-assurance toolkit for the FL
Plumbing Tools static site. It scans every HTML file in the repo (homepage, the
249 tool pages, the local/PBC city pages, the trust pages, and `/get-matched/`)
and reports on link integrity, SEO metadata, structured data, placeholder
content, accessibility, and static performance signals.

It touches **nothing** on the public site. All of AuditScout lives under `/qa/`
and `.github/`, plus a single added `robots.txt`. No existing page, calculator,
URL, form, homepage tool list, sitemap entry, or nav item is modified.

## Contents

| File | Purpose |
|------|---------|
| `qa/audit.mjs` | The audit engine (Node, ESM, **zero dependencies** — Node built-ins only). |
| `qa/report.json` | Machine-readable results from the latest run (written by the engine / CI). |
| `qa/report.sample.json` | A committed example so the dashboard renders before the first CI run. |
| `qa/index.html` | The dashboard (served at `/qa/`), self-contained, `noindex`. |
| `qa/README.md` | This file. |
| `.github/workflows/qa.yml` | CI: static audit gate + best-effort browser (console + Lighthouse) job. |
| `robots.txt` | Adds `Disallow: /qa/` (dashboard is internal). |

## Run it locally

From the repository root:

```bash
# 1. Run the audit engine — writes qa/report.json (and qa/report.sample.json if missing)
node qa/audit.mjs

# 2. View the dashboard. It uses fetch(), so serve over HTTP (not file://):
npx http-server . -p 8080      # or:  python3 -m http.server 8080
# then open http://127.0.0.1:8080/qa/
```

The engine prints an overall score, per-category scores, and severity totals,
and exits non-zero if any **Critical** issue is found (used for CI gating).

The dashboard loads `qa/report.json` (falling back to `qa/report.sample.json`).
The **Run live audit** button re-checks the *deployed* pages in your browser via
same-origin `fetch()` of the URLs in `/sitemap.xml` — so it only works when the
dashboard is opened from the live origin (`https://flplumbingtools.com/qa/`), not
from `localhost` fetching a different host.

## What each check covers

The engine groups checks into six weighted categories.

**Internal Links (weight 25).** Every `<a href>` in the static body (scripts and
styles are stripped first, and template-literal hrefs like `href="${'{'}...}"` are
skipped) is resolved against the actual files in the repo. Root-absolute
(`/about/`), directory (`/dir/` -> `dir/index.html`), and explicit-file links are
all resolved. Unresolvable internal links are **Critical**.

**SEO Metadata (weight 20).** Missing `<title>` or canonical (**High**); missing
meta description, missing Open Graph, or a duplicate `<title>` across pages
(**Medium/High**); missing Twitter Card (**Low**). Duplicate titles and
descriptions are also listed explicitly.

**Structured Data / JSON-LD (weight 15).** Each `application/ld+json` block is
`JSON.parse`d; a parse error is **Critical**. Pages with no JSON-LD are
**Medium**; tool pages missing a `BreadcrumbList` are **Low**.

**Content / Placeholders (weight 10).** Conservative, visible-text-only scan for
bracket tokens (`[Company]`, `[License…]`, `[Email]`, `[Phone]`, `[effective
date]`, …), `lorem ipsum`, `TODO`, `FIXME`, `{{mustache}}`, and `%%TOKEN%%`.
Because scripts, styles, and tag attributes are removed before scanning, calculator
JS tokens (`[S.region]`) and attribute/CSS selectors (`[type=text]`, `[data-x]`)
**cannot** produce false positives. The bare word "placeholder" in prose is
deliberately **not** flagged (it appears in legitimate editorial copy).

**Accessibility (weight 20).** Exactly one `<h1>` per page (**High** if none,
**Medium** if multiple); heading-order skips (**Low**); `<img>` without `alt`
(**High**); `<html lang>` present (**High** if missing); form controls with an
accessible name via `<label for>`, an **implicit wrapping** `<label>`,
`aria-label`, `aria-labelledby`, or `title` (**Medium** if missing). Controls
removed from tab order (`tabindex="-1"`, e.g. Mailchimp honeypot fields) and
non-interactive types are excluded. Presence of `:focus` styles and a skip link
are **Low** signals. Headings and controls are evaluated on the script-stripped
body so JS-injected template markup is not miscounted.

**Performance — static signals (weight 10).** Counts external / render-blocking
`<script src>` and `<link rel=stylesheet>` (should be **0**; any is **High**),
page byte weight (large pages are **Low**, plus a "largest pages" list), and inline
CSS/JS size.

### Scoring model (transparent)

For each page, per category, the worst issue determines a credit:
`clean = 1.0`, `Low = 0.9`, `Medium = 0.6`, `High/Critical = 0.0`. The category
score is `round(100 × mean(credit))` across all pages. The overall score is the
weighted mean of category scores using the weights above (which sum to 100). The
model and weights are echoed into `report.json` so the number is always auditable.

## How CI gating works

`.github/workflows/qa.yml` runs on **push to `main`**, **pull requests**, and
**manual dispatch**.

- **Job `audit`** (blocking): checks out, sets up Node, runs `node qa/audit.mjs`,
  always uploads `qa/report.json` as an artifact, then a gate step **fails the
  build** if there is any Critical issue **or** if the overall score is below
  **80**.
- **Job `browser`** (best-effort, `continue-on-error: true`): serves the site
  locally, uses **Playwright** to capture **console errors** on key URLs
  (homepage, a tool page, `/get-matched/`, a city page, `/about/`), and runs
  **Lighthouse** (performance / a11y / best-practices / SEO) on key URLs. Results
  are uploaded as the `qa-browser-checks` artifact. This job never blocks the
  pipeline — flaky browsers won't fail a merge — but its findings are always
  surfaced as artifacts.

**Report handling.** We keep it simple and robust: `report.json` is produced
fresh in CI and uploaded as an **artifact** (not committed back to the branch),
which avoids bot-commit loops and keeps the workflow read-only against the repo.
The committed `qa/report.sample.json` guarantees the dashboard renders before any
CI run. To refresh the committed snapshot, run `node qa/audit.mjs` locally and
commit the updated `qa/report.json`.

## Honest limitations

- **Console errors / runtime JS failures** are not detectable by static analysis.
  They come only from the Playwright job (or from the dashboard's live pass, which
  still cannot see console output — only fetch-level results).
- **Lighthouse / Core Web Vitals** require a real headless browser and come only
  from the CI Lighthouse job.
- **HTTP headers, security headers, redirects, caching, and TLS** are enforced at
  the host / Cloudflare layer and are **not** visible from repo files. Verifying
  them needs the live host.
- **Placeholder detection** is intentionally conservative (visible text only) and
  may miss unusual placeholder styles in exchange for near-zero false positives.
- The dashboard's **live audit** runs same-origin only; it audits a sample of
  sitemap URLs by default (configurable, or "all pages") to stay responsive.
