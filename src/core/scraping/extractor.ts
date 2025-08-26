// Page Extractor (D2Snap‑lite) – Playwright/TypeScript
// Drop-in module that builds a compact, structure-agnostic snapshot of a page
// suitable for LLM planning (navigate | click | paginate | fill | extract | stop).
// It avoids raw HTML, relies on roles/visibility/geometry/repetition, and returns
// stable selectors you can replay with Playwright.
//
// Usage:
//   import { buildLLMSnapshot } from './pageExtractor';
//   const snap = await buildLLMSnapshot(page, { limits: { maxControls: 30 } });
//   // pass `snap.compact` to the LLM; keep `snap.refMap` to execute actions.

import type { Page, Frame } from 'playwright';

// ---------- Types ----------
export type BBox = { x: number; y: number; w: number; h: number };
export type NodeRef = {
  refId: string;              // stable per-snapshot id
  selector: string;           // CSS you can replay in the given frame
  frameId: string;            // 'main' or 'f#'
  role?: string;              // aria role or inferred role
  name?: string;              // short text / accessible name (clipped)
  href?: string;              // absolute URL if link-like
  visible?: boolean;
  bbox?: BBox;                // coarse geometry
};

export type ListBlock = {
  root: NodeRef;              // container of repeated items/cards
  itemCount: number;
  itemLinkSelector?: string;  // descendant link selector to reach details
  samples: string[];          // 2–3 representative texts (clipped)
};

export type FormField = { label?: string; input: NodeRef };
export type FormBlock = { form: NodeRef; fields: FormField[]; submit?: NodeRef };

export type D2SnapCompact = {
  url: string;
  title?: string;
  headings: string[];         // role=heading or large-font surrogates
  lists: ListBlock[];         // ≤ 2
  controls: NodeRef[];        // clickable candidates ≤ maxControls
  pagination: NodeRef[];      // ranked, ≤ 2
  forms: FormBlock[];         // summarized forms
  hints: { textDensity: number; linkDensity: number };
};

export type LLMSnapshot = {
  compact: D2SnapCompact;                             // input to LLM
  refMap: Record<string, { selector: string; frameId: string }>; // for executor
  stats: { sizeBytes: number; frameCount: number; buildMs: number };
};

export type ExtractorOptions = {
  limits?: {
    maxControls?: number;     // default 30
    maxLists?: number;        // default 2
    maxForms?: number;        // default 3
    maxFormFields?: number;   // default 12 total per form
  };
  includeSameOriginIframes?: boolean; // default true
};

const DEFAULT_LIMITS = { maxControls: 30, maxLists: 2, maxForms: 3, maxFormFields: 12 };

// ---------- Public API ----------
export async function buildLLMSnapshot(page: Page, opts: ExtractorOptions = {}): Promise<LLMSnapshot> {
  const t0 = Date.now();
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };

  // Collect frames (main + same-origin children if requested)
  const frames: { frame: Frame; frameId: string }[] = [{ frame: page.mainFrame(), frameId: 'main' }];
  if (opts.includeSameOriginIframes !== false) {
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try {
        // Same-origin check by attempting a trivial eval
        await f.evaluate(() => 1);
        frames.push({ frame: f, frameId: `f${frames.length}` });
      } catch { /* cross-origin; skip */ }
    }
  }

  // Accumulators
  const refMap: Record<string, { selector: string; frameId: string }> = {};
  const lists: ListBlock[] = [];
  const controls: NodeRef[] = [];
  const paginationCandidates: NodeRef[] = [];
  const forms: FormBlock[] = [];
  const headings: string[] = [];

  // Per-frame extraction
  for (const { frame, frameId } of frames) {
    const [frameHeadings, frameControls, frameLists, framePagination, frameForms] = await Promise.all([
      getHeadings(frame),
      getClickables(frame, limits.maxControls),
      getListBlocks(frame, limits.maxLists),
      getPaginationCandidates(frame),
      getForms(frame, limits.maxForms, limits.maxFormFields)
    ]);

    // Register NodeRefs in refMap and attach frameId
    const addRef = (r: NodeRef) => {
      const id = makeRefId(frameId, r.selector, r.href, r.name);
      const nr: NodeRef = { ...r, refId: id, frameId };
      refMap[id] = { selector: r.selector, frameId };
      return nr;
    };

    headings.push(...frameHeadings);
    controls.push(...frameControls.map(addRef));
    lists.push(...frameLists.map(lb => ({ ...lb, root: addRef(lb.root) })));
    paginationCandidates.push(...framePagination.map(addRef));
    forms.push(...frameForms.map(fb => ({
      form: addRef(fb.form),
      fields: fb.fields.map(ff => ({
        label: ff.label ?? '',
        input: addRef(ff.input)
      })),
      // Fix: always provide a NodeRef for submit, or omit the property entirely if not present
      ...(fb.submit ? { submit: addRef(fb.submit) } : {})
    })));
  }

  // Rank pagination; keep top 2
  const pagination = rankPagination(paginationCandidates).slice(0, 2);

  // Compute simple hints
  const hints = await getDensityHints(page);

  const compact: D2SnapCompact = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    headings: dedupe(headings).slice(0, 6),
    lists: lists.slice(0, limits.maxLists),
    controls: controls.slice(0, limits.maxControls),
    pagination,
    forms: forms.slice(0, limits.maxForms),
    hints
  };

  const out: LLMSnapshot = {
    compact,
    refMap,
    stats: {
      sizeBytes: byteSize(compact),
      frameCount: frames.length,
      buildMs: Date.now() - t0
    }
  };
  return out;
}

// ---------- Headings (role or large-font surrogates) ----------
async function getHeadings(frame: Frame): Promise<string[]> {
  return await frame.evaluate(() => {
    const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const out: string[] = [];

    // 1) explicit roles/aria-level
    const ax = Array.from(document.querySelectorAll('[role="heading"], [aria-level]')) as HTMLElement[];
    for (const el of ax) {
      const txt = el.innerText || el.textContent || '';
      if (txt.trim()) out.push(clip(txt));
    }

    // 2) large-font surrogates (div soup)
    const els = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
    for (const el of els) {
      const cs = getComputedStyle(el);
      const fs = parseFloat(cs.fontSize || '0');
      const fw = (cs.fontWeight || '400').toString();
      const strong = fs >= 20 || parseInt(fw, 10) >= 600;
      if (!strong) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height < 200) continue;
      const txt = (el.innerText || '').trim();
      if (txt.length >= 12) out.push(clip(txt));
      if (out.length > 12) break;
    }

    return Array.from(new Set(out)).slice(0, 8);
  });
}

// ---------- Clickable/interactive candidates ----------
async function getClickables(frame: Frame, limit: number): Promise<NodeRef[]> {
  return await frame.evaluate((limit) => {
    const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const visible = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      const cs = getComputedStyle(el as HTMLElement);
      return r.width * r.height > 10 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };
    const cssFor = (el: Element): string => {
      if (!(el instanceof Element)) return '';
      // Prefer unique id
      if ((el as HTMLElement).id) {
        const id = (el as HTMLElement).id;
        if (document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
      }
      // Prefer data-* hooks
      for (const a of el.getAttributeNames()) {
        if (a.startsWith('data-')) return `[${a}="${el.getAttribute(a)}"]`;
      }
      // Small stable class subset
      const cls = ((el as HTMLElement).className || '').toString().split(/\s+/).filter(Boolean)
        .filter(c => !/^(_|Mui|css-|sc-|chakra-|ant-|ember|ng-)/.test(c)).slice(0,2);
      const base = `${el.tagName.toLowerCase()}${cls.length?'.'+cls.map(c=>CSS.escape(c)).join('.') : ''}`;
      const parent = el.parentElement;
      if (!parent) return base;
      const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
      const idx = same.indexOf(el) + 1;
      return `${cssFor(parent)} > ${base}${same.length>1?`:nth-of-type(${idx})`:''}`;
    };

    // Collect candidates
    const out: any[] = [];
    const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
    for (const el of all) {
      if (!visible(el)) continue;
      const role = (el.getAttribute('role') || '').toLowerCase();
      const hasHref = (el as HTMLAnchorElement).href;
      const tabbable = (el as HTMLElement).tabIndex >= 0;
      const pointer = getComputedStyle(el).cursor === 'pointer';
      const onclick = (el as any).onclick || (el as any).onmousedown || (el as any).onmouseup;
      if (hasHref || role === 'button' || role === 'link' || tabbable || pointer || onclick) {
        const r = el.getBoundingClientRect();
        out.push({
          selector: cssFor(el),
          role: role || (hasHref ? 'link' : undefined),
          name: clip((el.innerText || el.getAttribute('aria-label') || ''), 80),
          href: hasHref || undefined,
          visible: true,
          bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        });
      }
      if (out.length >= limit*2) break; // collect a buffer, we will slice later
    }

    // Sort: links/buttons near viewport center & larger area first
    out.sort((a,b) => (b.bbox.w*b.bbox.h) - (a.bbox.w*a.bbox.h));
    return out.slice(0, limit);
  }, limit);
}

// ---------- Repetition-based list detection ----------
async function getListBlocks(frame: Frame, maxLists: number): Promise<ListBlock[]> {
  return await frame.evaluate((maxLists) => {
    const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const cssFor = (el: Element): string => {
      if (!(el instanceof Element)) return '';
      if ((el as HTMLElement).id && document.querySelectorAll(`#${CSS.escape((el as HTMLElement).id)}`).length === 1)
        return `#${CSS.escape((el as HTMLElement).id)}`;
      for (const a of el.getAttributeNames()) if (a.startsWith('data-')) return `[${a}="${el.getAttribute(a)}"]`;
      const cls = ((el as HTMLElement).className || '').toString().split(/\s+/).filter(Boolean)
        .filter(c => !/^(_|Mui|css-|sc-|chakra-|ant-|ember|ng-)/.test(c)).slice(0,2);
      const base = `${el.tagName.toLowerCase()}${cls.length?'.'+cls.map(c=>CSS.escape(c)).join('.') : ''}`;
      const parent = el.parentElement;
      if (!parent) return base;
      const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
      const idx = same.indexOf(el) + 1;
      return `${cssFor(parent)} > ${base}${same.length>1?`:nth-of-type(${idx})`:''}`;
    };

    const containers: Element[] = Array.from(document.querySelectorAll('main, .content, body'));
    const results: any[] = [];

    const signature = (el: Element) => {
      const kids = Array.from(el.children);
      return JSON.stringify({ k: kids.length, tags: kids.slice(0,6).map(k => k.tagName) });
    };

    for (const root of containers) {
      const kids = Array.from(root.children);
      const groups = new Map<string, Element[]>();
      for (const k of kids) {
        const s = signature(k);
        const arr = groups.get(s) || [];
        arr.push(k); groups.set(s, arr);
      }
      for (const [sig, arr] of groups) {
        if (arr.length >= 8) {
          const first = arr[0] as HTMLElement;
          const r = first.getBoundingClientRect();
          if (r.width * r.height < 200) continue; // ignore tiny repeats
          const items = Array.from(first.querySelectorAll('a, [role=link]')) as HTMLElement[];
          const samples = items.slice(0,3).map(el => clip(el.innerText || el.getAttribute('aria-label') || ''));
          results.push({
            root: { selector: cssFor(first) },
            itemCount: arr.length,
            itemLinkSelector: items.length ? 'a, [role=link]' : undefined,
            samples
          });
        }
      }
    }

    // prefer deeper/lower lists (likely content) and by count
    results.sort((a,b) => (b.itemCount - a.itemCount));
    return results.slice(0, maxLists);
  }, maxLists);
}

// ---------- Pagination candidates ----------
async function getPaginationCandidates(frame: Frame): Promise<NodeRef[]> {
  return await frame.evaluate(() => {
    const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const cssFor = (el: Element): string => {
      if ((el as HTMLElement).id && document.querySelectorAll(`#${CSS.escape((el as HTMLElement).id)}`).length === 1)
        return `#${CSS.escape((el as HTMLElement).id)}`;
      const parent = el.parentElement; if (!parent) return el.tagName.toLowerCase();
      const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
      const idx = same.indexOf(el) + 1;
      return `${cssFor(parent)} > ${el.tagName.toLowerCase()}${same.length>1?`:nth-of-type(${idx})`:''}`;
    };

    const candidates: any[] = [];
    const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
    for (const a of anchors) {
      const t = (a.innerText || '').toLowerCase();
      const href = a.getAttribute('href') || '';
      const rel = (a.getAttribute('rel') || '').toLowerCase();
      const isNextText = /(next|older|more|›|»)/i.test(a.innerText || '');
      const hasPageParam = /([?&](page|p|offset|start)=\d+)/i.test(href);
      if (rel === 'next' || isNextText || hasPageParam) {
        const r = a.getBoundingClientRect();
        const nearBottom = (r.y + r.height) > (window.innerHeight * 0.6);
        candidates.push({
          selector: cssFor(a), role: 'link', name: clip(a.innerText || a.getAttribute('aria-label') || ''),
          href: a.href, visible: true,
          bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          _score: (rel==='next'?3:0) + (isNextText?2:0) + (hasPageParam?2:0) + (nearBottom?1:0)
        });
      }
    }
    candidates.sort((a,b)=> b._score - a._score);
    return candidates.slice(0, 4).map(({_score, ...rest}) => rest);
  });
}

function rankPagination(cands: NodeRef[]): NodeRef[] {
  // Deduplicate by href/selector and prefer highest score already applied in frame evaluation
  const seen = new Set<string>();
  const out: NodeRef[] = [];
  for (const c of cands) {
    const key = (c.href || '') + '|' + c.selector + '|' + c.frameId;
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
  }
  return out;
}

// ---------- Forms: label→input mapping + submit ----------
async function getForms(frame: Frame, maxForms: number, maxFields: number): Promise<FormBlock[]> {
  return await frame.evaluate(({maxForms, maxFields}) => {
    const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const cssFor = (el: Element): string => {
      if ((el as HTMLElement).id && document.querySelectorAll(`#${CSS.escape((el as HTMLElement).id)}`).length === 1)
        return `#${CSS.escape((el as HTMLElement).id)}`;
      const parent = el.parentElement; if (!parent) return el.tagName.toLowerCase();
      const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
      const idx = same.indexOf(el) + 1;
      return `${cssFor(parent)} > ${el.tagName.toLowerCase()}${same.length>1?`:nth-of-type(${idx})`:''}`;
    };

    const forms: HTMLFormElement[] = Array.from(document.querySelectorAll('form'));
    const out: any[] = [];

    for (const f of forms) {
      const fields: any[] = [];
      const inputs = Array.from(f.querySelectorAll('input, textarea, select')) as HTMLElement[];
      for (const el of inputs) {
        const id = (el as HTMLElement).id;
        let label: string | undefined;
        if (id) {
          const lab = f.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lab) label = clip(lab.textContent || '');
        }
        if (!label) {
          // proximity label
          const prev = el.previousElementSibling as HTMLElement | null;
          if (prev && prev.tagName.toLowerCase() === 'label') label = clip(prev.textContent || '');
          else if (el.getAttribute('aria-label')) label = clip(el.getAttribute('aria-label') || '');
          else if ((el as HTMLInputElement).placeholder) label = clip((el as HTMLInputElement).placeholder || '');
        }
        fields.push({ label, input: { selector: cssFor(el), role: inferRole(el), name: clip(label || el.getAttribute('name') || '') } });
        if (fields.length >= maxFields) break;
      }
      const submitEl = f.querySelector('button[type=submit], input[type=submit]') as HTMLElement | null;
      const submit = submitEl ? { selector: cssFor(submitEl), role: 'button', name: clip(submitEl.innerText || submitEl.getAttribute('aria-label') || 'Submit') } : undefined;

      out.push({ form: { selector: cssFor(f), role: 'form', name: clip(f.getAttribute('name') || '') }, fields, submit });
      if (out.length >= maxForms) break;
    }
    return out;

    function inferRole(el: Element) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      return 'textbox';
    }
  }, {maxForms, maxFields});
}

// ---------- Density hints ----------
async function getDensityHints(page: Page): Promise<{ textDensity: number; linkDensity: number }> {
  return await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const chars = text.length;
    const links = document.querySelectorAll('a').length;
    const nodes = document.querySelectorAll('body *').length || 1;
    return { textDensity: +(chars / nodes).toFixed(2), linkDensity: +(links / nodes).toFixed(4) };
  });
}

// ---------- Helpers ----------
function dedupe<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }
function byteSize(obj: unknown): number { return Buffer.byteLength(JSON.stringify(obj)); }
function makeRefId(frameId: string, selector: string, href?: string, name?: string): string {
  const base = `${frameId}|${selector}|${href || ''}|${name || ''}`;
  let hash = 0; for (let i=0;i<base.length;i++){ hash = (hash*31 + base.charCodeAt(i))|0; }
  return `r${frameId}-${Math.abs(hash).toString(36)}`;
}

// ---------- Class ----------
export class PageSnapshot {
  private page: Page;
  private opts: ExtractorOptions;
  private limits = { ...DEFAULT_LIMITS };

  constructor(page: Page, opts: ExtractorOptions = {}) {
    this.page = page;
    this.opts = opts;
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
  }

  static async from(page: Page, opts: ExtractorOptions = {}): Promise<LLMSnapshot> {
    const builder = new PageSnapshot(page, opts);
    return builder.build();
  }

  async build(): Promise<LLMSnapshot> {
    const t0 = Date.now();

    // Collect frames (main + same-origin children if requested)
    const frames: { frame: Frame; frameId: string }[] = [{ frame: this.page.mainFrame(), frameId: 'main' }];
    if (this.opts.includeSameOriginIframes !== false) {
      for (const f of this.page.frames()) {
        if (f === this.page.mainFrame()) continue;
        try {
          await f.evaluate(() => 1); // will throw on cross-origin
          frames.push({ frame: f, frameId: `f${frames.length}` });
        } catch {/* skip cross-origin */}
      }
    }

    // Accumulators
    const refMap: Record<string, { selector: string; frameId: string }> = {};
    const lists: ListBlock[] = [];
    const controls: NodeRef[] = [];
    const paginationCandidates: NodeRef[] = [];
    const forms: FormBlock[] = [];
    const headings: string[] = [];

    for (const { frame, frameId } of frames) {
      const [frameHeadings, frameControls, frameLists, framePagination, frameForms] = await Promise.all([
        this.getHeadings(frame),
        this.getClickables(frame, this.limits.maxControls),
        this.getListBlocks(frame, this.limits.maxLists),
        this.getPaginationCandidates(frame),
        this.getForms(frame, this.limits.maxForms, this.limits.maxFormFields)
      ]);

      const addRef = (r: NodeRef) => {
        const id = this.makeRefId(frameId, r.selector, r.href, r.name);
        const nr: NodeRef = { ...r, refId: id, frameId };
        refMap[id] = { selector: r.selector, frameId };
        return nr;
      };

      headings.push(...frameHeadings);
      controls.push(...frameControls.map(addRef));
      lists.push(...frameLists.map(lb => ({ ...lb, root: addRef(lb.root) })));
      paginationCandidates.push(...framePagination.map(addRef));
      forms.push(
        ...frameForms.map((fb): FormBlock => ({
          form: addRef(fb.form),
          fields: fb.fields.map((ff): FormField => {
            const field: FormField = { input: addRef(ff.input) };
            if (ff.label != null) field.label = ff.label; // omit if undefined
            return field;
          }),
          ...(fb.submit ? { submit: addRef(fb.submit) } : {}) // omit property entirely if falsy
        }))
      );
      
    }

    const pagination = this.rankPagination(paginationCandidates).slice(0, 2);
    const hints = await this.getDensityHints(this.page);

    const compact: D2SnapCompact = {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      headings: this.dedupe(headings).slice(0, 6),
      lists: lists.slice(0, this.limits.maxLists),
      controls: controls.slice(0, this.limits.maxControls),
      pagination,
      forms: forms.slice(0, this.limits.maxForms),
      hints
    };

    return {
      compact,
      refMap,
      stats: {
        sizeBytes: this.byteSize(compact),
        frameCount: frames.length,
        buildMs: Date.now() - t0
      }
    };
  }

  // ---------- Headings (role or large-font surrogates) ----------
  private async getHeadings(frame: Frame): Promise<string[]> {
    return await frame.evaluate(() => {
      const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
      const out: string[] = [];

      // explicit roles/aria-level
      const ax = Array.from(document.querySelectorAll('[role="heading"], [aria-level]')) as HTMLElement[];
      for (const el of ax) {
        const txt = el.innerText || el.textContent || '';
        if (txt.trim()) out.push(clip(txt));
      }

      // large-font surrogates (div soup)
      const els = Array.from(document.querySelectorAll('body *')) as HTMLElement[];
      for (const el of els) {
        const cs = getComputedStyle(el);
        const fs = parseFloat(cs.fontSize || '0');
        const fw = (cs.fontWeight || '400').toString();
        const strong = fs >= 20 || parseInt(fw, 10) >= 600;
        if (!strong) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width * rect.height < 200) continue;
        const txt = (el.innerText || '').trim();
        if (txt.length >= 12) out.push(clip(txt));
        if (out.length > 12) break;
      }

      return Array.from(new Set(out)).slice(0, 8);
    });
  }

  // ---------- Clickable/interactive candidates ----------
  private async getClickables(frame: Frame, limit: number): Promise<NodeRef[]> {
    return await frame.evaluate((limit) => {
      const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const cs = getComputedStyle(el as HTMLElement);
        return r.width * r.height > 10 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      };
      const cssFor = (el: Element): string => {
        if (!(el instanceof Element)) return '';
        if ((el as HTMLElement).id) {
          const id = (el as HTMLElement).id;
          if (document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
        }
        for (const a of el.getAttributeNames()) {
          if (a.startsWith('data-')) return `[${a}="${el.getAttribute(a)}"]`;
        }
        const cls = ((el as HTMLElement).className || '').toString().split(/\s+/).filter(Boolean)
          .filter(c => !/^(_|Mui|css-|sc-|chakra-|ant-|ember|ng-)/.test(c)).slice(0,2);
        const base = `${el.tagName.toLowerCase()}${cls.length?'.'+cls.map(c=>CSS.escape(c)).join('.') : ''}`;
        const parent = el.parentElement;
        if (!parent) return base;
        const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
        const idx = same.indexOf(el) + 1;
        return `${cssFor(parent)} > ${base}${same.length>1?`:nth-of-type(${idx})`:''}`;
      };

      const out: any[] = [];
      const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
      for (const el of all) {
        if (!visible(el)) continue;
        const role = (el.getAttribute('role') || '').toLowerCase();
        const hasHref = (el as HTMLAnchorElement).href;
        const tabbable = (el as HTMLElement).tabIndex >= 0;
        const pointer = getComputedStyle(el).cursor === 'pointer';
        const onclick = (el as any).onclick || (el as any).onmousedown || (el as any).onmouseup;
        if (hasHref || role === 'button' || role === 'link' || tabbable || pointer || onclick) {
          const r = el.getBoundingClientRect();
          out.push({
            selector: cssFor(el),
            role: role || (hasHref ? 'link' : undefined),
            name: clip((el.innerText || el.getAttribute('aria-label') || ''), 80),
            href: hasHref || undefined,
            visible: true,
            bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          });
        }
        if (out.length >= limit*2) break; // collect a buffer
      }

      out.sort((a,b) => (b.bbox.w*b.bbox.h) - (a.bbox.w*a.bbox.h));
      return out.slice(0, limit);
    }, limit);
  }

  // ---------- Repetition-based list detection ----------
  private async getListBlocks(frame: Frame, maxLists: number): Promise<ListBlock[]> {
    return await frame.evaluate((maxLists) => {
      const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
      const cssFor = (el: Element): string => {
        if (!(el instanceof Element)) return '';
        if ((el as HTMLElement).id && document.querySelectorAll(`#${CSS.escape((el as HTMLElement).id)}`).length === 1)
          return `#${CSS.escape((el as HTMLElement).id)}`;
        for (const a of el.getAttributeNames()) if (a.startsWith('data-')) return `[${a}="${el.getAttribute(a)}"]`;
        const cls = ((el as HTMLElement).className || '').toString().split(/\s+/).filter(Boolean)
          .filter(c => !/^(_|Mui|css-|sc-|chakra-|ant-|ember|ng-)/.test(c)).slice(0,2);
        const base = `${el.tagName.toLowerCase()}${cls.length?'.'+cls.map(c=>CSS.escape(c)).join('.') : ''}`;
        const parent = el.parentElement;
        if (!parent) return base;
        const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
        const idx = same.indexOf(el) + 1;
        return `${cssFor(parent)} > ${base}${same.length>1?`:nth-of-type(${idx})`:''}`;
      };

      const containers: Element[] = Array.from(document.querySelectorAll('main, .content, body'));
      const results: any[] = [];

      const signature = (el: Element) => {
        const kids = Array.from(el.children);
        return JSON.stringify({ k: kids.length, tags: kids.slice(0,6).map(k => k.tagName) });
      };

      for (const root of containers) {
        const kids = Array.from(root.children);
        const groups = new Map<string, Element[]>();
        for (const k of kids) {
          const s = signature(k);
          const arr = groups.get(s) || [];
          arr.push(k); groups.set(s, arr);
        }
        for (const [sig, arr] of groups) {
          if (arr.length >= 8) {
            const first = arr[0] as HTMLElement;
            const r = first.getBoundingClientRect();
            if (r.width * r.height < 200) continue; // ignore tiny repeats
            const items = Array.from(first.querySelectorAll('a, [role=link]')) as HTMLElement[];
            const samples = items.slice(0,3).map(el => clip(el.innerText || el.getAttribute('aria-label') || ''));
            results.push({
              root: { selector: cssFor(first) },
              itemCount: arr.length,
              itemLinkSelector: items.length ? 'a, [role=link]' : undefined,
              samples
            });
          }
        }
      }
      results.sort((a,b) => (b.itemCount - a.itemCount));
      return results.slice(0, maxLists);
    }, maxLists);
  }

  // ---------- Pagination candidates ----------
  private async getPaginationCandidates(frame: Frame): Promise<NodeRef[]> {
    return await frame.evaluate(() => {
      const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
      const cssFor = (el: Element): string => {
        if ((el as HTMLElement).id && document.querySelectorAll(`#${CSS.escape((el as HTMLElement).id)}`).length === 1)
          return `#${CSS.escape((el as HTMLElement).id)}`;
        const parent = el.parentElement; if (!parent) return el.tagName.toLowerCase();
        const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
        const idx = same.indexOf(el) + 1;
        return `${cssFor(parent)} > ${el.tagName.toLowerCase()}${same.length>1?`:nth-of-type(${idx})`:''}`;
      };

      const candidates: any[] = [];
      const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const rel = (a.getAttribute('rel') || '').toLowerCase();
        const isNextText = /(next|older|more|›|»)/i.test(a.innerText || '');
        const hasPageParam = /([?&](page|p|offset|start)=\d+)/i.test(href);
        if (rel === 'next' || isNextText || hasPageParam) {
          const r = a.getBoundingClientRect();
          const nearBottom = (r.y + r.height) > (window.innerHeight * 0.6);
          candidates.push({
            selector: cssFor(a), role: 'link', name: clip(a.innerText || a.getAttribute('aria-label') || ''),
            href: a.href, visible: true,
            bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            _score: (rel==='next'?3:0) + (isNextText?2:0) + (hasPageParam?2:0) + (nearBottom?1:0)
          });
        }
      }
      candidates.sort((a,b)=> b._score - a._score);
      return candidates.slice(0, 4).map(({_score, ...rest}) => rest);
    });
  }

  private rankPagination(cands: NodeRef[]): NodeRef[] {
    const seen = new Set<string>();
    const out: NodeRef[] = [];
    for (const c of cands) {
      const key = (c.href || '') + '|' + c.selector + '|' + c.frameId;
      if (seen.has(key)) continue;
      seen.add(key); out.push(c);
    }
    return out;
  }

  // ---------- Forms: label→input mapping + submit ----------
  private async getForms(frame: Frame, maxForms: number, maxFields: number): Promise<FormBlock[]> {
    return await frame.evaluate(({maxForms, maxFields}) => {
      const clip = (s: string, n=80) => s.replace(/\s+/g, ' ').trim().slice(0, n);
      const cssFor = (el: Element): string => {
        if ((el as HTMLElement).id && document.querySelectorAll(`#${CSS.escape((el as HTMLElement).id)}`).length === 1)
          return `#${CSS.escape((el as HTMLElement).id)}`;
        const parent = el.parentElement; if (!parent) return el.tagName.toLowerCase();
        const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
        const idx = same.indexOf(el) + 1;
        return `${cssFor(parent)} > ${el.tagName.toLowerCase()}${same.length>1?`:nth-of-type(${idx})`:''}`;
      };

      const forms: HTMLFormElement[] = Array.from(document.querySelectorAll('form'));
      const out: any[] = [];

      for (const f of forms) {
        const fields: any[] = [];
        const inputs = Array.from(f.querySelectorAll('input, textarea, select')) as HTMLElement[];
        for (const el of inputs) {
          const id = (el as HTMLElement).id;
          let label: string | undefined;
          if (id) {
            const lab = f.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lab) label = clip(lab.textContent || '');
          }
          if (!label) {
            const prev = el.previousElementSibling as HTMLElement | null;
            if (prev && prev.tagName.toLowerCase() === 'label') label = clip(prev.textContent || '');
            else if (el.getAttribute('aria-label')) label = clip(el.getAttribute('aria-label') || '');
            else if ((el as HTMLInputElement).placeholder) label = clip((el as HTMLInputElement).placeholder || '');
          }
          fields.push({ label, input: { selector: cssFor(el), role: inferRole(el), name: clip(label || el.getAttribute('name') || '') } });
          if (fields.length >= maxFields) break;
        }
        const submitEl = f.querySelector('button[type=submit], input[type=submit]') as HTMLElement | null;
        const submit = submitEl ? { selector: cssFor(submitEl), role: 'button', name: clip(submitEl.innerText || submitEl.getAttribute('aria-label') || 'Submit') } : undefined;

        out.push({ form: { selector: cssFor(f), role: 'form', name: clip(f.getAttribute('name') || '') }, fields, submit });
        if (out.length >= maxForms) break;
      }
      return out;

      function inferRole(el: Element) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        return 'textbox';
      }
    }, {maxForms, maxFields});
  }

  // ---------- Density hints ----------
  private async getDensityHints(page: Page): Promise<{ textDensity: number; linkDensity: number }> {
    return await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const chars = text.length;
      const links = document.querySelectorAll('a').length;
      const nodes = document.querySelectorAll('body *').length || 1;
      return { textDensity: +(chars / nodes).toFixed(2), linkDensity: +(links / nodes).toFixed(4) };
    });
  }

  // ---------- Helpers ----------
  private dedupe<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }
  private byteSize(obj: unknown): number { return Buffer.byteLength(JSON.stringify(obj)); }
  private makeRefId(frameId: string, selector: string, href?: string, name?: string): string {
    const base = `${frameId}|${selector}|${href || ''}|${name || ''}`;
    let hash = 0; for (let i=0;i<base.length;i++){ hash = (hash*31 + base.charCodeAt(i))|0; }
    return `r${frameId}-${Math.abs(hash).toString(36)}`;
  }
}

// Example usage:
// const snap = await PageSnapshot.from(page);
// const llmInput = snap.compact; // feed to LLM
// // When LLM returns an action with refId, resolve to selector/frame:
// const { selector, frameId } = snap.refMap[action.refId];
