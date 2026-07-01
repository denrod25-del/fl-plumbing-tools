#!/usr/bin/env node
/*
 * AuditScout — Site QA Engine for FL Plumbing Tools
 * ---------------------------------------------------
 * Internal, additive static-analysis tool. Scans every HTML file in the repo
 * (homepage, tool pages, PBC/local pages, trust pages, get-matched) and reports
 * on link integrity, SEO metadata, structured data, placeholder content,
 * accessibility heuristics and static performance signals.
 *
 * Dependency-light by design: uses only Node.js built-ins (fs, path, url) plus a
 * small, self-contained regex-based HTML scanner. No network, no npm install.
 * Runnable from the repo root with:  node qa/audit.mjs
 *
 * Outputs:
 *   qa/report.json         machine-readable results (per category, offending URLs, severities, scores)
 *   qa/report.sample.json  written only if it does not already exist (committed example for the dashboard)
 *
 * IMPORTANT: This engine only READS files. It never modifies any page.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root = parent of the qa/ directory that holds this script.
const REPO_ROOT = path.resolve(__dirname, '..');
const QA_DIR = __dirname;
const CANONICAL_HOST = 'flplumbingtools.com';

// Directories we never scan (our own tooling, VCS, deps, CI).
const IGNORE_DIRS = new Set(['.git', 'qa', '.github', 'node_modules']);

/* -------------------------------------------------------------------------- */
/*  Severity + scoring model (transparent, documented)                        */
/* -------------------------------------------------------------------------- */
// Category weights sum to 100. Overall score = weighted average of category scores.
const CATEGORY_WEIGHTS = {
  links: 25,          // internal link integrity
  accessibility: 20,  // a11y heuristics
  metadata: 20,       // title / description / canonical / OG / Twitter
  structuredData: 15, // JSON-LD parse + expected types
  content: 10,        // placeholder / TODO / lorem text
  performance: 10,    // render-blocking resources, page weight
};

// Per-page credit for a category, based on the worst issue found on that page:
//   clean = 1.0, only Low = 0.9, only Medium = 0.6, any High/Critical = 0.0
// Category score = round(100 * average(credit) across all pages).
function creditForWorst(worst) {
  if (worst === null) return 1.0;
  if (worst === 'Low') return 0.9;
  if (worst === 'Medium') return 0.6;
  return 0.0; // High or Critical
}
const SEV_RANK = { Low: 1, Medium: 2, High: 3, Critical: 4 };
function worse(a, b) {
  if (!a) return b;
  if (!b) return a;
  return SEV_RANK[a] >= SEV_RANK[b] ? a : b;
}

/* -------------------------------------------------------------------------- */
/*  Filesystem walk                                                           */
/* -------------------------------------------------------------------------- */
async function walk(dir, allFiles, htmlFiles) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
    if (e.isDirectory()) {
      const top = rel.split('/')[0];
      if (IGNORE_DIRS.has(e.name) || IGNORE_DIRS.has(top)) continue;
      await walk(full, allFiles, htmlFiles);
    } else if (e.isFile()) {
      allFiles.add(rel);
      if (e.name.toLowerCase().endsWith('.html')) htmlFiles.push(rel);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  URL <-> file mapping                                                       */
/* -------------------------------------------------------------------------- */
// Convert a repo-relative file path to its public URL path.
function fileToUrl(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
  return '/' + rel;
}

// Given an href found on `fromRel`, decide whether it is an internal link and,
// if so, whether it resolves to a real file. Returns:
//   { kind: 'ignore' } | { kind: 'external' } | { kind:'internal', ok:bool, target, hash }
function classifyHref(href, fromRel, fileSet) {
  let h = (href || '').trim();
  if (!h) return { kind: 'ignore' };
  // Scheme-based / non-navigational links we do not resolve.
  if (/^(mailto:|tel:|javascript:|data:|sms:|#)/i.test(h)) return { kind: 'ignore' };
  if (/^https?:\/\//i.test(h)) {
    // Same-host absolute URLs are treated as internal; other hosts are external.
    try {
      const u = new URL(h);
      if (u.host.replace(/^www\./, '') === CANONICAL_HOST) {
        h = u.pathname + (u.hash || '');
      } else {
        return { kind: 'external', href: h };
      }
    } catch { return { kind: 'external', href: h }; }
  } else if (h.startsWith('//')) {
    return { kind: 'external', href: h };
  }

  // Split off hash and query.
  let hash = '';
  const hi = h.indexOf('#');
  if (hi >= 0) { hash = h.slice(hi + 1); h = h.slice(0, hi); }
  const qi = h.indexOf('?');
  if (qi >= 0) h = h.slice(0, qi);
  if (!h) return { kind: 'ignore' }; // was a pure #anchor / ?query on same page

  // Resolve to a root-absolute URL path.
  let urlPath;
  if (h.startsWith('/')) {
    urlPath = h;
  } else {
    const fromDir = fromRel.includes('/') ? '/' + fromRel.slice(0, fromRel.lastIndexOf('/') + 1) : '/';
    urlPath = path.posix.normalize(fromDir + h);
  }
  // Decode %20 etc. so filenames match.
  try { urlPath = decodeURIComponent(urlPath); } catch { /* keep as-is */ }

  // Build candidate file paths.
  const candidates = [];
  const noSlash = urlPath.replace(/^\//, '');
  if (urlPath.endsWith('/')) {
    candidates.push(noSlash + 'index.html');
  } else {
    const last = urlPath.split('/').pop();
    if (last.includes('.')) {
      candidates.push(noSlash);          // explicit file (e.g. .html, .xml, .css, .png)
    } else {
      candidates.push(noSlash);          // extensionless file
      candidates.push(noSlash + '.html');
      candidates.push(noSlash + '/index.html');
    }
  }
  if (urlPath === '/') candidates.push('index.html');

  const target = candidates.find((c) => fileSet.has(c)) || null;
  return { kind: 'internal', ok: !!target, target, hash, urlPath, raw: href };
}

/* -------------------------------------------------------------------------- */
/*  Lightweight HTML scanning helpers (regex-based, self-contained)           */
/* -------------------------------------------------------------------------- */
function getAttr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  if (!m) return null;
  return m[2] ?? m[3] ?? m[4] ?? '';
}
function firstTag(html, tagName) {
  const m = html.match(new RegExp('<' + tagName + '\\b[^>]*>', 'i'));
  return m ? m[0] : null;
}
function allTags(html, tagName) {
  return html.match(new RegExp('<' + tagName + '\\b[^>]*>', 'ig')) || [];
}
function stripScriptsAndStyles(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}
function visibleText(html) {
  return stripScriptsAndStyles(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/*  Placeholder detection (conservative, documented)                          */
/* -------------------------------------------------------------------------- */
// Scans ONLY visible text (scripts, styles and tag attributes already removed),
// so calculator JS tokens like [S.region] and CSS/attribute selectors like
// [type=text] or [data-x] cannot produce false positives.
// Bracket tokens are matched against a whitelist of known placeholder keywords.
const PLACEHOLDER_PATTERNS = [
  { name: 'bracket-token', re: /\[\s*(company|company name|business name|license[^\]]*|licence[^\]]*|email|e-mail|phone[^\]]*|address|effective date|insert[^\]]*|your [a-z]+|full name|first name|last name|city name|zip[^\]]*|placeholder[^\]]*|tbd|xxx+)\s*[^\]]*\]/i },
  { name: 'lorem-ipsum', re: /lorem\s+ipsum/i },
  { name: 'todo', re: /\bTODO\b/ },
  { name: 'fixme', re: /\bFIXME\b/ },
  // NOTE: the bare word "placeholder" is intentionally NOT matched — it appears
  // legitimately in editorial/policy prose (e.g. "we show a clearly marked
  // placeholder"). Only bracketed placeholder tokens (above) and template
  // markers (below) are flagged, to stay conservative and avoid false positives.
  { name: 'mustache', re: /\{\{[^}]{1,60}\}\}/ },
  { name: 'percent-token', re: /%%[A-Z0-9_]{2,40}%%/ },
];
function findPlaceholders(text) {
  const hits = [];
  for (const p of PLACEHOLDER_PATTERNS) {
    const m = text.match(p.re);
    if (m) hits.push({ pattern: p.name, sample: m[0].slice(0, 60) });
  }
  return hits;
}

/* -------------------------------------------------------------------------- */
/*  Per-page analysis                                                         */
/* -------------------------------------------------------------------------- */
function analyzePage(rel, html, fileSet) {
  const url = fileToUrl(rel);
  const isTool = /\/fl_[a-z0-9_]+\.html$/.test(url);
  const bytes = Buffer.byteLength(html, 'utf8');

  // --- metadata ---
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : null;
  const descTag = (html.match(/<meta\b[^>]*name\s*=\s*["']description["'][^>]*>/i) || [])[0] || null;
  const description = descTag ? (getAttr(descTag, 'content') || '').trim() : null;
  const canonical = /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.test(html);
  const ogCount = (html.match(/<meta\b[^>]*property\s*=\s*["']og:[^"']+["']/ig) || []).length;
  const twCount = (html.match(/<meta\b[^>]*name\s*=\s*["']twitter:[^"']+["']/ig) || []).length;

  // --- structured data ---
  const ldBlocks = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig) || [];
  const ldTypes = [];
  let ldParseError = null;
  for (const block of ldBlocks) {
    const inner = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try {
      const data = JSON.parse(inner);
      const collect = (o) => {
        if (Array.isArray(o)) return o.forEach(collect);
        if (o && typeof o === 'object') {
          if (o['@type']) [].concat(o['@type']).forEach((t) => ldTypes.push(t));
          Object.values(o).forEach(collect);
        }
      };
      collect(data);
    } catch (e) {
      ldParseError = e.message;
    }
  }

  // --- links ---
  // Extract anchors from script/style-stripped HTML so we only check real,
  // statically-present links. Links built dynamically inside <script> (e.g.
  // template literals like href="${r.url}") cannot be resolved statically and
  // are skipped, along with any href still containing a template marker.
  const htmlNoScript = stripScriptsAndStyles(html);
  const hrefs = (htmlNoScript.match(/<a\b[^>]*\shref\s*=\s*("([^"]*)"|'([^']*)')/ig) || [])
    .map((t) => getAttr(t, 'href'))
    .filter((h) => h && !/\$\{|\{\{|%%/.test(h));
  const brokenLinks = [];
  let externalLinks = 0;
  for (const href of hrefs) {
    const c = classifyHref(href, rel, fileSet);
    if (c.kind === 'external') externalLinks++;
    else if (c.kind === 'internal' && !c.ok) brokenLinks.push(href);
  }

  // --- accessibility ---
  const h1s = allTags(html, 'h1').length;
  const htmlTag = firstTag(html, 'html');
  const hasLang = htmlTag ? !!getAttr(htmlTag, 'lang') : false;
  // heading order
  // Headings/controls are evaluated on the script/style-stripped body so that
  // markup embedded in JS template strings (dynamically injected at runtime) is
  // not counted by static analysis — consistent with how links are handled.
  const headingSeq = (htmlNoScript.match(/<h([1-6])\b/ig) || []).map((t) => parseInt(t.match(/h([1-6])/i)[1], 10));
  let headingSkip = false;
  for (let i = 1; i < headingSeq.length; i++) {
    if (headingSeq[i] - headingSeq[i - 1] > 1) { headingSkip = true; break; }
  }
  // images missing alt
  const imgs = allTags(html, 'img');
  const imgsNoAlt = imgs.filter((t) => getAttr(t, 'alt') === null).length;
  // form controls missing accessible name.
  // Accessible name sources: <label for=id>, aria-label, aria-labelledby, title,
  // OR an implicit wrapping label (<label><input> text</label>) detected via
  // offset ranges. Controls that are type=hidden/submit/button/reset/image, or
  // removed from tab order (tabindex="-1", e.g. Mailchimp honeypot fields), are
  // excluded — a missing name there is not a meaningful interactive-a11y defect.
  const labelFor = new Set(
    (htmlNoScript.match(/<label\b[^>]*\sfor\s*=\s*("([^"]*)"|'([^']*)')/ig) || []).map((t) => getAttr(t, 'for'))
  );
  const labelRanges = [];
  { const lre = /<label\b[^>]*>[\s\S]*?<\/label>/gi; let lm; while ((lm = lre.exec(htmlNoScript))) labelRanges.push([lm.index, lm.index + lm[0].length]); }
  const insideLabel = (idx) => labelRanges.some(([a, b]) => idx >= a && idx < b);
  let controlCount = 0;
  let controlsNoName = 0;
  { const cre = /<(input|select|textarea)\b[^>]*>/ig; let cm;
    while ((cm = cre.exec(htmlNoScript))) {
      const t = cm[0];
      const type = (getAttr(t, 'type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
      if ((getAttr(t, 'tabindex') || '') === '-1') continue;
      controlCount++;
      const id = getAttr(t, 'id');
      const hasName =
        (id && labelFor.has(id)) ||
        getAttr(t, 'aria-label') !== null ||
        getAttr(t, 'aria-labelledby') !== null ||
        getAttr(t, 'title') !== null ||
        insideLabel(cm.index);
      if (!hasName) controlsNoName++;
    }
  }
  const hasFocusStyle = /:focus\b/.test(html);
  const hasSkipLink = /class\s*=\s*["'][^"']*skip[^"']*["']/i.test(html) || /href\s*=\s*["']#(main|content|main-content)["']/i.test(html);

  // --- performance (static) ---
  const externalScripts = (html.match(/<script\b[^>]*\ssrc\s*=\s*["'](https?:)?\/\//ig) || []).length;
  const externalStyles = (html.match(/<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*href\s*=\s*["'](https?:)?\/\//ig) || []).length
    + (html.match(/<link\b[^>]*href\s*=\s*["'](https?:)?\/\/[^"']*["'][^>]*rel\s*=\s*["']stylesheet["']/ig) || []).length;
  const renderBlockingExternal = externalScripts + externalStyles;
  const inlineStyleBytes = (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/ig) || []).reduce((n, b) => n + Buffer.byteLength(b, 'utf8'), 0);
  const inlineScriptBytes = (html.match(/<script\b(?![^>]*\ssrc)[^>]*>([\s\S]*?)<\/script>/ig) || []).reduce((n, b) => n + Buffer.byteLength(b, 'utf8'), 0);

  // --- placeholders ---
  const placeholders = findPlaceholders(visibleText(html));

  return {
    rel, url, isTool, bytes,
    title, description, canonical, ogCount, twCount,
    ldBlockCount: ldBlocks.length, ldTypes, ldParseError,
    brokenLinks, externalLinks,
    h1s, hasLang, headingSkip, imgCount: imgs.length, imgsNoAlt,
    controlCount, controlsNoName, hasFocusStyle, hasSkipLink,
    renderBlockingExternal, inlineStyleBytes, inlineScriptBytes,
    placeholders,
  };
}

/* -------------------------------------------------------------------------- */
/*  Aggregate + score                                                         */
/* -------------------------------------------------------------------------- */
function buildReport(pages) {
  const total = pages.length;

  // Duplicate title / description maps.
  const titleMap = new Map();
  const descMap = new Map();
  for (const p of pages) {
    if (p.title) { if (!titleMap.has(p.title)) titleMap.set(p.title, []); titleMap.get(p.title).push(p.url); }
    if (p.description) { if (!descMap.has(p.description)) descMap.set(p.description, []); descMap.get(p.description).push(p.url); }
  }
  const dupTitles = [...titleMap.entries()].filter(([, u]) => u.length > 1);
  const dupDescs = [...descMap.entries()].filter(([, u]) => u.length > 1);
  const dupTitleUrls = new Set(dupTitles.flatMap(([, u]) => u));
  const dupDescUrls = new Set(dupDescs.flatMap(([, u]) => u));

  // Per-page worst severity, per category.
  const catWorst = {}; // url -> {links, accessibility, ...}
  const issues = {
    links: [], metadata: [], structuredData: [], content: [], accessibility: [], performance: [],
  };
  const bump = (cat, url, sev) => {
    catWorst[url] = catWorst[url] || {};
    catWorst[url][cat] = worse(catWorst[url][cat], sev);
  };

  for (const p of pages) {
    // LINKS
    if (p.brokenLinks.length) {
      bump('links', p.url, 'Critical');
      issues.links.push({ url: p.url, severity: 'Critical', issue: 'Broken internal link(s)', detail: p.brokenLinks });
    }
    // METADATA
    if (!p.title) { bump('metadata', p.url, 'High'); issues.metadata.push({ url: p.url, severity: 'High', issue: 'Missing <title>' }); }
    if (!p.canonical) { bump('metadata', p.url, 'High'); issues.metadata.push({ url: p.url, severity: 'High', issue: 'Missing canonical link' }); }
    if (!p.description) { bump('metadata', p.url, 'Medium'); issues.metadata.push({ url: p.url, severity: 'Medium', issue: 'Missing meta description' }); }
    if (dupTitleUrls.has(p.url)) { bump('metadata', p.url, 'High'); }
    if (dupDescUrls.has(p.url)) { bump('metadata', p.url, 'Medium'); }
    if (p.ogCount === 0) { bump('metadata', p.url, 'Medium'); issues.metadata.push({ url: p.url, severity: 'Medium', issue: 'Missing Open Graph tags' }); }
    if (p.twCount === 0) { bump('metadata', p.url, 'Low'); issues.metadata.push({ url: p.url, severity: 'Low', issue: 'Missing Twitter Card tags' }); }
    // STRUCTURED DATA
    if (p.ldParseError) { bump('structuredData', p.url, 'Critical'); issues.structuredData.push({ url: p.url, severity: 'Critical', issue: 'JSON-LD parse error', detail: p.ldParseError }); }
    else if (p.ldBlockCount === 0) { bump('structuredData', p.url, 'Medium'); issues.structuredData.push({ url: p.url, severity: 'Medium', issue: 'No JSON-LD structured data' }); }
    else if (p.isTool && !p.ldTypes.includes('BreadcrumbList')) { bump('structuredData', p.url, 'Low'); issues.structuredData.push({ url: p.url, severity: 'Low', issue: 'Tool page missing BreadcrumbList schema' }); }
    // CONTENT / placeholders
    if (p.placeholders.length) { bump('content', p.url, 'High'); issues.content.push({ url: p.url, severity: 'High', issue: 'Placeholder / template text', detail: p.placeholders }); }
    // ACCESSIBILITY
    if (p.h1s === 0) { bump('accessibility', p.url, 'High'); issues.accessibility.push({ url: p.url, severity: 'High', issue: 'No <h1> on page' }); }
    else if (p.h1s > 1) { bump('accessibility', p.url, 'Medium'); issues.accessibility.push({ url: p.url, severity: 'Medium', issue: `Multiple <h1> (${p.h1s})` }); }
    if (!p.hasLang) { bump('accessibility', p.url, 'High'); issues.accessibility.push({ url: p.url, severity: 'High', issue: 'Missing lang attribute on <html>' }); }
    if (p.imgsNoAlt > 0) { bump('accessibility', p.url, 'High'); issues.accessibility.push({ url: p.url, severity: 'High', issue: `${p.imgsNoAlt} <img> without alt` }); }
    if (p.controlsNoName > 0) { bump('accessibility', p.url, 'Medium'); issues.accessibility.push({ url: p.url, severity: 'Medium', issue: `${p.controlsNoName} form control(s) without accessible name` }); }
    if (p.headingSkip) { bump('accessibility', p.url, 'Low'); issues.accessibility.push({ url: p.url, severity: 'Low', issue: 'Heading level skipped' }); }
    if (!p.hasSkipLink) { bump('accessibility', p.url, 'Low'); issues.accessibility.push({ url: p.url, severity: 'Low', issue: 'No skip link / #main target' }); }
    if (!p.hasFocusStyle) { bump('accessibility', p.url, 'Low'); issues.accessibility.push({ url: p.url, severity: 'Low', issue: 'No :focus styles detected' }); }
    // PERFORMANCE
    if (p.renderBlockingExternal > 0) { bump('performance', p.url, 'High'); issues.performance.push({ url: p.url, severity: 'High', issue: `${p.renderBlockingExternal} external render-blocking resource(s)` }); }
    if (p.bytes > 200 * 1024) { bump('performance', p.url, 'Low'); issues.performance.push({ url: p.url, severity: 'Low', issue: `Large page (${Math.round(p.bytes / 1024)} KB)` }); }
  }

  // Category scores.
  const categoryScores = {};
  for (const cat of Object.keys(CATEGORY_WEIGHTS)) {
    let sum = 0;
    for (const p of pages) {
      const worst = catWorst[p.url]?.[cat] ?? null;
      sum += creditForWorst(worst);
    }
    categoryScores[cat] = Math.round((100 * sum) / total);
  }
  let overall = 0;
  for (const [cat, w] of Object.entries(CATEGORY_WEIGHTS)) overall += (categoryScores[cat] * w) / 100;
  overall = Math.round(overall);

  // Severity totals.
  const severityTotals = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const list of Object.values(issues)) for (const it of list) severityTotals[it.severity]++;

  // Largest pages (perf note).
  const largest = [...pages].sort((a, b) => b.bytes - a.bytes).slice(0, 10)
    .map((p) => ({ url: p.url, kb: Math.round(p.bytes / 1024) }));

  return {
    generatedAt: new Date().toISOString(),
    tool: 'AuditScout',
    repo: 'fl-plumbing-tools',
    canonicalHost: CANONICAL_HOST,
    scanned: {
      totalPages: total,
      toolPages: pages.filter((p) => p.isTool).length,
      indexPages: pages.filter((p) => p.rel.endsWith('index.html')).length,
    },
    weighting: CATEGORY_WEIGHTS,
    scoringModel: 'Per page, per category: clean=1.0, Low=0.9, Medium=0.6, High/Critical=0.0. Category score = round(100 * mean(credit)). Overall = weighted mean by the weights shown.',
    overallScore: overall,
    categoryScores,
    severityTotals,
    summary: {
      brokenLinkPages: issues.links.length,
      duplicateTitleGroups: dupTitles.length,
      duplicateDescriptionGroups: dupDescs.length,
      pagesMissingCanonical: pages.filter((p) => !p.canonical).length,
      pagesMissingTitle: pages.filter((p) => !p.title).length,
      pagesMissingDescription: pages.filter((p) => !p.description).length,
      pagesMissingOG: pages.filter((p) => p.ogCount === 0).length,
      pagesMissingTwitter: pages.filter((p) => p.twCount === 0).length,
      jsonLdParseErrors: pages.filter((p) => p.ldParseError).length,
      pagesNoJsonLd: pages.filter((p) => p.ldBlockCount === 0).length,
      pagesWithPlaceholders: issues.content.length,
      pagesNoH1: pages.filter((p) => p.h1s === 0).length,
      pagesMultiH1: pages.filter((p) => p.h1s > 1).length,
      pagesMissingLang: pages.filter((p) => !p.hasLang).length,
      pagesImgNoAlt: pages.filter((p) => p.imgsNoAlt > 0).length,
      pagesControlsNoName: pages.filter((p) => p.controlsNoName > 0).length,
      pagesExternalRenderBlocking: pages.filter((p) => p.renderBlockingExternal > 0).length,
    },
    categories: {
      links: {
        label: 'Internal Links',
        score: categoryScores.links,
        checkedInBrowser: true,
        issues: issues.links,
      },
      metadata: {
        label: 'SEO Metadata',
        score: categoryScores.metadata,
        checkedInBrowser: true,
        duplicateTitles: dupTitles.map(([title, urls]) => ({ title, urls })),
        duplicateDescriptions: dupDescs.map(([description, urls]) => ({ description: description.slice(0, 80), urls })),
        issues: issues.metadata,
      },
      structuredData: {
        label: 'Structured Data (JSON-LD)',
        score: categoryScores.structuredData,
        checkedInBrowser: true,
        issues: issues.structuredData,
      },
      content: {
        label: 'Content / Placeholders',
        score: categoryScores.content,
        checkedInBrowser: true,
        issues: issues.content,
      },
      accessibility: {
        label: 'Accessibility',
        score: categoryScores.accessibility,
        checkedInBrowser: true,
        issues: issues.accessibility,
      },
      performance: {
        label: 'Performance (static signals)',
        score: categoryScores.performance,
        checkedInBrowser: false,
        note: 'Static signals only. Real Core Web Vitals require Lighthouse in CI/browser.',
        largestPages: largest,
        issues: issues.performance,
      },
    },
    limitations: [
      'Console errors and runtime JS failures are NOT detectable by static analysis — see the Playwright job in CI.',
      'Lighthouse / Core Web Vitals require a real browser — see the Lighthouse job in CI.',
      'HTTP headers, security headers, redirects and TLS are enforced at the host/Cloudflare layer and are not visible from repo files.',
      'Placeholder detection is intentionally conservative (visible text only) and may miss unusual placeholder styles.',
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */
async function main() {
  const allFiles = new Set();
  const htmlFiles = [];
  await walk(REPO_ROOT, allFiles, htmlFiles);
  htmlFiles.sort();

  const pages = [];
  for (const rel of htmlFiles) {
    const html = await fs.readFile(path.join(REPO_ROOT, rel), 'utf8');
    pages.push(analyzePage(rel, html, allFiles));
  }

  const report = buildReport(pages);

  const reportPath = path.join(QA_DIR, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  // Write a committed sample only if missing, so the dashboard renders pre-CI.
  const samplePath = path.join(QA_DIR, 'report.sample.json');
  try {
    await fs.access(samplePath);
  } catch {
    await fs.writeFile(samplePath, JSON.stringify(report, null, 2));
  }

  // Console summary.
  console.log('AuditScout — FL Plumbing Tools');
  console.log('==============================');
  console.log(`Scanned ${report.scanned.totalPages} HTML pages (${report.scanned.toolPages} tool pages)`);
  console.log(`Overall score: ${report.overallScore}/100`);
  console.log('Category scores:');
  for (const [cat, sc] of Object.entries(report.categoryScores)) {
    console.log(`  ${cat.padEnd(16)} ${sc}/100`);
  }
  console.log('Severity totals:', JSON.stringify(report.severityTotals));
  console.log(`Report written: ${path.relative(REPO_ROOT, reportPath)}`);

  // Exit code: non-zero if any Critical issue (used by CI gating).
  if (report.severityTotals.Critical > 0) {
    console.error(`\nFAIL: ${report.severityTotals.Critical} Critical issue(s) found.`);
    process.exitCode = 2;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
