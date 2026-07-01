# FL Plumbing Tools — Accessibility Fixes Report (Run B, verified-current tree)

**Repository:** github.com/denrod25-del/fl-plumbing-tools
**HEAD processed:** `6822634` (`git reset --hard origin/main`; `git ls-remote` remote main = `6822634…`) — **verified current**, includes the Phase 1–4 production upgrade.
**Supersedes:** the earlier `a11y-fixes/` run, which was built on stale `9e1020f` (pre-upgrade) and must NOT be deployed.
**Method:** same deterministic script (`_apply_a11y_fixes.py`), byte-preserving insert-only edits. Files only, no push.

## Pre-flight verification
- `git rev-parse HEAD` = `682263421f14…` → begins `6822634`. ✔
- Working tree clean (0 modified); 279 HTML files (upgrade added pages vs 271 before).
- Sample page `bidet-installation/fl_bidet_installation.html` contains ALL required markers:
  `name="referrer"` (Phase 4), `Florida Quick Answers` (Phase 3), `p2-` nav class (Phase 2), `rel="canonical"`. ✔

## Summary
| Metric | Count |
|---|---|
| HTML files scanned | 279 |
| **Files changed** | **186** |
| FIX 1 — controls given an accessible name | **2,251** |
| &nbsp;&nbsp;• `for="…"` added to existing `<label>` | 1,546 |
| &nbsp;&nbsp;• `aria-label` from adjacent/visible text | 612 |
| &nbsp;&nbsp;• `aria-label` from placeholder / name / id fallback | 93 |
| FIX 2 — heading-order skips fixed | **117** across 83 pages |
| &nbsp;&nbsp;• `role="heading" aria-level="N"` (appearance-safe) | 117 |
| &nbsp;&nbsp;• relevel (tag changed) | 0 |
| Controls skipped (ambiguous) | 0 |
| Controls excluded (inside `aria-hidden` honeypots) | 21 |

Counts are identical to the intended Run A — the two a11y fixes are orthogonal to the Phase 1–4 content, so the same controls/headings are addressed, now layered on top of the upgraded pages.

## Zero-regression verification (run on OUTPUT files)
- **Insert-only proof:** original text is a strict subsequence of every one of the 186 outputs — no byte deleted/modified; additive attributes only; identical line counts. (0 violations)
- **0** form controls without an accessible name.
- **0** heading-order skips remaining.
- **Phase 1–4 preserved — 0 markers lost:** every `name="referrer"`, `Florida Quick Answers`, `p2-`, `rel="canonical"`, and `application/ld+json` present in an input is still present in its output.
- **Protected regions byte-identical:** canonical, referrer meta (Phase 4), OG/Twitter meta, JSON-LD/schema, meta description, `<nav>`, `<footer>`, all `<form>` open tags (Mailchimp `action`, `/get-matched/`), and URLs.
- **Inline calculator JS:** `<script>` blocks byte-identical; `node --check` passes on all sampled scripts.

## Files
- Changed HTML under this folder, preserving repo paths (186 files).
- `_apply_a11y_fixes.py` — deterministic script used.
- `_manifest.csv` — per-file counts.
