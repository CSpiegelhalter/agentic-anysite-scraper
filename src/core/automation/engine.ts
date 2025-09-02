// ScrapingEngine.ts
import { Browser, Page } from 'playwright';
import { ScrapingSchema, ScrapingResult, ScrapingState, ScrapingError } from '../../types';
import { BrowserManager } from '../browser/browserManager';
import { Logger } from '../../utils/logger';
import { OutputWriter } from '../../output/writer';
import { NavigationFlow } from '../navigation/flow';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

// ⬇️ Adjust the import path to wherever you placed PageSnapshot + types
import { PageSnapshot } from '../scraping/extractor';
type LLMSnapshot = any; // If you export this type, import it instead
type NodeRef = any;     // same
type ListBlock = any;   // same
type ExtractorOptions = any;

export class ScrapingEngine {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private state: ScrapingState;
  private logger: Logger;

  constructor(
    private schema: ScrapingSchema,
    private config: any
  ) {
    this.state = this.initializeState();
    this.logger = new Logger();
  }

  async run(): Promise<ScrapingResult> {
    try {
      this.logger.info('Starting scraping session', { schema: this.schema.name });

      // Initialize browser
      const browserManager = new BrowserManager(this.config.browser);
      this.browser = await browserManager.launch();
      if (!this.browser) throw new Error('Failed to launch browser');

      this.page = await this.browser.newPage();
      if (!this.page) throw new Error('Failed to create new page');

      await this.setupPage();

      // Navigate to start URL
      const startUrl = this.buildStartUrl();
      await this.gotoWithHeuristics(this.buildStartUrl(), {
        timeout: Math.max(this.config.browser.timeout ?? 30000, 90000),
        waitUntil: 'domcontentloaded'
      });

      this.state.currentUrl = startUrl;

      // Begin scraping loop (snapshot-driven)
      const result = await this.scrapingLoop();

      // Write output
      const writer = new OutputWriter(this.schema.output);
      await writer.write(result);

      return result;

    } catch (error: any) {
      this.logger.error('Scraping failed', { error: error?.message ?? error });
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  private async gotoWithHeuristics(
    url: string,
    opts?: {
      timeout?: number;
      waitUntil?: 'domcontentloaded' | 'commit' | 'networkidle';
      minChars?: number;       // content readiness threshold
      minLinks?: number;       // content readiness threshold
      minTextDensity?: number; // chars per DOM node
    }
  ) {
    const timeout = opts?.timeout ?? this.config?.browser?.timeout ?? 90000;
    const waitUntil = opts?.waitUntil ?? 'domcontentloaded';
    const minChars = opts?.minChars ?? 1500;
    const minLinks = opts?.minLinks ?? 20;
    const minTextDensity = opts?.minTextDensity ?? 35;

    await this.page!.goto(url, { waitUntil, timeout });

    // Try to reach a brief low-activity period (ads/analytics may still ping).
    await this.softIdle(1500, /*maxInflight*/ 2, Math.min(8000, Math.floor(timeout / 3))).catch(() => { });

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const ready = await this.page!.evaluate(
        ({ minChars, minLinks, minTextDensity }) => {
          const body = document.body;
          if (!body) return false;
          const text = (body.innerText || '').trim();
          const chars = text.length;
          const links = document.querySelectorAll('a').length;
          const nodes = document.querySelectorAll('body *').length || 1;
          const textDensity = chars / nodes; // quick-and-dirty signal of “real” content
          return (chars >= minChars && links >= minLinks) || textDensity >= minTextDensity;
        },
        { minChars, minLinks, minTextDensity }
      );

      if (ready) return;

      // Nudge lazy loaders
      await this.page!.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
      await this.page!.waitForTimeout(300);
    }

    this.logger.warn('Proceeding without meeting readiness heuristics', { url });
  }

  private async softIdle(quiesceMs: number, maxInflight: number, maxWaitMs: number) {
    const page = this.page!;
    let inflight = 0;

    const inc = (req: any) => { if (req.resourceType() !== 'document') inflight++; };
    const dec = (req: any) => { if (req.resourceType() !== 'document') inflight = Math.max(0, inflight - 1); };

    page.on('request', inc);
    page.on('requestfinished', dec);
    page.on('requestfailed', dec);

    const start = Date.now();
    let idleSince = Date.now();

    try {
      while (Date.now() - start < maxWaitMs) {
        if (inflight <= maxInflight) {
          if (Date.now() - idleSince >= quiesceMs) break;
        } else {
          idleSince = Date.now();
        }
        await page.waitForTimeout(100);
      }
    } finally {
      page.off('request', inc);
      page.off('requestfinished', dec);
      page.off('requestfailed', dec);
    }
  }


  // ----------------- Snapshot-driven loop -----------------
  private async scrapingLoop(): Promise<ScrapingResult> {
    const navigation = new NavigationFlow(this.schema.navigation);

    while (this.shouldContinue()) {
      try {
        const snap = await this.takeSnapshot();
        console.log('HOWWDDYYYY\n\n\n')
        await this.dumpSnapshot(snap, `p${this.state.currentPage}-root`);

        this.state.currentUrl = snap.compact.url ?? this.state.currentUrl;

        // 1) Extract items using the snapshot (lists → items)
        const items = await this.extractItemsFromSnapshot(snap);
        if (items.length) {
          const now = new Date();
          this.state.extractedItems.push(
            ...items.map(d => ({
              data: d,
              url: this.state.currentUrl,
              timestamp: now,
            }))
          );
          this.logger.info('Extracted items', { count: items.length, total: this.state.extractedItems.length });
        }

        // 2) Optionally follow discovered links (if configured)
        if (this.schema.navigation?.followLinks) {
          const links = this.discoverLinksFromSnapshot(snap);
          for (const href of links) {
            if (!this.shouldContinue()) break;
            if (this.isVisited(href)) continue;
            await this.safeGoto(href);
            this.markVisited(href);
            // Take a quick extraction pass on the child page
            const childSnap = await this.takeSnapshot();
            await this.dumpSnapshot(childSnap, `p${this.state.currentPage}-child-${this.hash(href).slice(0, 8)}`, { href });

            const childItems = await this.extractItemsFromSnapshot(childSnap);
            if (childItems.length) {
              const now = new Date();
              this.state.extractedItems.push(
                ...childItems.map(d => ({
                  data: d,
                  url: this.state.currentUrl,
                  timestamp: now,
                }))
              );
            }
            // Go back
            await this.page!.goBack().catch(() => { });
          }
        }

        // 3) Handle pagination (prefer snapshot pagination → NavigationFlow fallback)
        let advanced = false;
        const nextHref = this.chooseNextPageHref(snap);
        if (nextHref && !this.isVisited(nextHref)) {
          await this.safeGoto(nextHref);
          this.state.currentPage++;
          this.markVisited(nextHref);
          advanced = true;
        } else if (this.schema.pagination) {
          const hasNext = await navigation.hasNextPage(this.page!);
          if (hasNext) {
            await navigation.goToNextPage(this.page!);
            this.state.currentPage++;
            advanced = true;
          }
        }

        if (!advanced) break; // no more pages/links to follow

      } catch (error: any) {
        this.handleError(error);
        // Try to break out on repeated failures
        if (this.state.errors.length >= (this.config?.retry?.attempts ?? 3)) break;
        // Small backoff if configured
        const delay = this.config?.retry?.delay ?? 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }

    return this.buildResult();
  }

  // ----------------- Snapshot helpers -----------------
  private async takeSnapshot(opts: ExtractorOptions = {}): Promise<LLMSnapshot> {
    // You can pass limits via config, e.g., config.snapshot.limits
    const merged: ExtractorOptions = {
      includeSameOriginIframes: true,
      ...(this.config?.snapshot ?? {}),
      ...(opts ?? {})
    };
    return PageSnapshot.from(this.page!, merged);
  }

  private chooseNextPageHref(snap: LLMSnapshot): string | null {
    const cands: NodeRef[] = snap?.compact?.pagination ?? [];
    for (const c of cands || []) {
      if (c.href && !this.isVisited(c.href)) return c.href;
    }
    return null;
  }

  private sanitize(name: string): string {
    return name.replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 160);
  }

  private urlKey(u: string): string {
    try {
      const { hostname, pathname } = new URL(u);
      const base = `${hostname}${pathname}`.replace(/\/+/g, '_');
      return this.sanitize(base || 'page');
    } catch {
      return 'page';
    }
  }

  private hash(s: string): string {
    return createHash('sha1').update(s).digest('hex');
  }

  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  private safeStringify(value: any, space = 2): string {
    const seen = new WeakSet();
    return JSON.stringify(
      value,
      (k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (typeof v === 'function') return undefined;
        if (v && typeof v === 'object') {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
          if (v instanceof Map) return { __type: 'Map', entries: Array.from(v.entries()) };
          if (v instanceof Set) return { __type: 'Set', values: Array.from(v.values()) };
          if (v instanceof URL) return v.toString();
          if (v instanceof RegExp) return v.toString();
        }
        return v;
      },
      space
    );
  }

  /**
   * Writes the snapshot JSON, page HTML, and (optionally) a screenshot.
   * Controlled by this.config.debug:
   * { enabled: true, dir?: string, dumpHtml?: boolean, dumpScreenshot?: boolean, pretty?: boolean, maxDumps?: number }
   */
  private async dumpSnapshot(snap: any, tag = 'root', extra: Record<string, any> = {}): Promise<void> {
    if (!this.config?.debug?.enabled) return;

    // throttle if desired
    const max = this.config?.debug?.maxDumps ?? Infinity;
    (this as any).__dumpCount = (this as any).__dumpCount ?? 0;
    if ((this as any).__dumpCount >= max) return;

    const dir = this.config?.debug?.dir || path.join(process.cwd(), '.debug', 'snapshots');
    await this.ensureDir(dir);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const pageKey = this.urlKey(this.state.currentUrl);
    const base = path.join(dir, `${ts}__${pageKey}__${this.sanitize(tag)}`);

    // Build a compact payload that’s guaranteed serializable
    const payload = {
      meta: {
        url: this.state.currentUrl,
        page: this.state.currentPage,
        tag,
        timestamp: ts,
        userAgent: await this.page!.evaluate(() => navigator.userAgent),
      },
      // Keep it focused on the compact view, which should be what you step through
      snapshot: {
        compact: snap?.compact ?? null
        // add other pieces if needed, e.g. snap.tree, but compact is usually enough
      },
      extra
    };

    const json = this.safeStringify(payload, this.config?.debug?.pretty === false ? 0 : 2);
    await fs.writeFile(`${base}.json`, json, 'utf8');

    if (this.config?.debug?.dumpHtml) {
      const html = await this.page!.content();
      await fs.writeFile(`${base}.html`, html, 'utf8');
    }

    if (this.config?.debug?.dumpScreenshot) {
      try {
        await this.page!.screenshot({ path: `${base}.png`, fullPage: true, type: 'png' });
      } catch (err) {
        this.logger.warn('Screenshot failed', { err: (err as any)?.message });
      }
    }

    (this as any).__dumpCount++;
    this.logger.info('Snapshot dumped', { base });
  }


  private discoverLinksFromSnapshot(snap: LLMSnapshot): string[] {
    // Heuristic: grab top list block links and prominent controls with hrefs
    const out = new Set<string>();

    // List items — use itemLinkSelector if present
    const lists: ListBlock[] = snap?.compact?.lists ?? [];
    const topLists = lists.slice(0, 2);
    for (const lb of topLists) {
      // We will extract the first few item hrefs directly from the DOM for accuracy
      // NOTE: This runs in main frame; if list is in same-origin iframe, consider enhancing with frame-aware execution.
      out; // just to silence TS mental model here
    }

    // Prominent controls (e.g., big nav links)
    const controls: NodeRef[] = snap?.compact?.controls ?? [];
    for (const ctl of controls.slice(0, 10)) {
      if (ctl.href) out.add(ctl.href);
    }

    // We'll resolve list links during extraction (to avoid double DOM trips). Keep controls here.
    return Array.from(out).filter(h => this.isSameSite(h));
  }

  // ----------------- Extraction using snapshot -----------------
  private async extractItemsFromSnapshot(snap: LLMSnapshot): Promise<any[]> {
    const maxNeeded = Math.max(
      (this.schema.target?.maxItems ?? Number.MAX_SAFE_INTEGER) - this.state.extractedItems.length,
      0
    );
    if (maxNeeded <= 0) return [];

    // Try schema-based extraction first
    const schemaResults = await this.extractFromSchema(snap, maxNeeded);
    if (schemaResults.length > 0) return schemaResults;

    // Fall back to snapshot-based extraction
    const snapshotResults = await this.extractFromSnapshot(snap, maxNeeded);
    if (snapshotResults.length > 0) return snapshotResults;

    // Final fallback to page anchors
    return await this.extractFromPageAnchors(maxNeeded);
  }

  private async extractFromSchema(snap: any, maxNeeded: number): Promise<any[]> {
    const s: any = (this.schema as any).selectors;
    if (!s?.itemRoot || !Array.isArray(s?.fields) || s.fields.length === 0) return [];

    try {
      const rows = await this.page!.$$eval(
        s.itemRoot,
        (nodes, fields) => {
          const H = (window as any).__H;

          const resolveEl = (node: Element, sel: any): Element | null => {
            if (!sel || sel === ':scope' || sel === ':self' || sel === 'self') return node;
            try { return node.querySelector(sel); } catch { return null; }
          };

          return (nodes as Element[]).map((node) => {
            const obj: Record<string, any> = {};
            const fieldSelectors: Record<string, string | null> = {};

            for (const f of fields as any[]) {
              const el = resolveEl(node, f.selector);
              let v: any = null;

              if (f?.attr) {
                const attr = String(f.attr).toLowerCase();
                if (attr === 'href') {
                  const a = el as HTMLAnchorElement | null;
                  v = a?.href ?? el?.getAttribute?.('href') ?? null;
                } else if (attr === 'src') {
                  const anyEl: any = el as any;
                  v = anyEl?.src ?? el?.getAttribute?.('src') ?? el?.getAttribute?.('data-src') ?? null;
                } else if (attr === 'html') {
                  v = (el as HTMLElement)?.innerHTML ?? null;
                } else if (attr === 'text') {
                  v = H.clip((el as HTMLElement)?.innerText ?? el?.textContent ?? '');
                } else {
                  v = (el as HTMLElement)?.getAttribute?.(f.attr) ?? null;
                }
              } else {
                const txt = (el as HTMLElement)?.innerText ?? el?.textContent ?? '';
                v = H.clip(txt);
              }

              obj[f.name] = v;
              fieldSelectors[f.name] = el ? H.cssFor(el) : null;
            }

            // Best title + href on the item container
            const title = obj['title'] || H.bestTitle(node) || null;
            const { href, hrefSelector, actions } = H.getBestHrefAndActions(node, 'a, [role="link"]');

            // Image picking with good fallbacks (but no page-level og:image)
            const pickedImg = H.pickImage(node, { href, allowPageFallback: false });

            const rawText = H.clip((node as HTMLElement).innerText || node.textContent || '', 800);
            const lines = rawText.split(/[\n\.!\?]+/).map((x: string) => H.clip(x.trim(), 240)).filter(Boolean);
            const snippet = H.clip(lines.find((x: string) => x.length >= 40 && (!title || x !== title)) || lines[0] || '', 220) || null;

            const r = (node as HTMLElement).getBoundingClientRect();
            const bbox = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
            const linkCount = node.querySelectorAll('a').length;
            const nodeCount = node.querySelectorAll('*').length || 1;
            const linkDensity = +(linkCount / nodeCount).toFixed(4);
            const charCount = rawText.length;

            return {
              title, href: href || obj['href'] || obj['url'] || null, snippet,
              image: pickedImg?.url || obj['image'] || null,
              tags: null,
              actions: actions.length ? actions : null,
              selectors: {
                container: H.cssFor(node),
                title: title ? null : null, // you can set a title selector if you want to resolve it explicitly
                href: hrefSelector || null,
                image: pickedImg?.selector || null,
                fields: fieldSelectors
              },
              container: {
                selector: H.cssFor(node),
                attrs: (() => {
                  const m: Record<string, string> = {};
                  for (const a of node.getAttributeNames()) if (a.startsWith('data-')) m[a] = String(node.getAttribute(a) || '');
                  return m;
                })(),
                bbox
              },
              signals: { charCount, linkCount, linkDensity },
              fields: Object.keys(obj).length ? obj : null
            };
          });
        },
        s.fields
      );

      return this.cleanAndDedupeResults(rows, maxNeeded);
    } catch (e: any) {
      this.logger?.warn?.('Schema-based extraction failed; falling back to snapshot lists.', { error: e?.message });
      return [];
    }
  }


  private async extractFromSnapshot(snap: any, maxNeeded: number): Promise<any[]> {
    const lists: any[] = snap?.compact?.lists ?? [];
    if (!lists.length) return [];

    const lb = lists[0];
    const rootSel = lb?.root?.selector;
    const linkSel = lb?.itemLinkSelector ?? 'a, [role="link"]';
    if (!rootSel) return [];

    const pageHeadings: string[] = Array.isArray(snap?.compact?.headings) ? snap.compact.headings.slice(0, 6) : [];

    const pageResults = await this.page!.$$eval(
      rootSel,
      (initialMatches, { rootSel, linkSel, pageHeadings }) => {
        const H = (window as any).__H;

        const generalize = (sel: string) => sel.replace(/:nth-of-type\(\d+\)/g, '');
        let nodes = initialMatches as Element[];
        if (nodes.length <= 1) {
          try {
            const widened = document.querySelectorAll(generalize(rootSel));
            if (widened && widened.length > 1) nodes = Array.from(widened) as Element[];
          } catch { }
        }

        const seen = new Set<string>();
        const out: any[] = [];

        for (const node of nodes) {
          const title = H.bestTitle(node);
          const { href, hrefSelector, actions } = H.getBestHrefAndActions(node, linkSel);
          const rawText = H.clip((node as HTMLElement).innerText || node.textContent || '', 800);
          const lines = rawText.split(/[\n\.!\?]+/).map((x: string) => H.clip(x.trim(), 240)).filter(Boolean);
          const snippet = H.clip(lines.find((x: string) => x.length >= 40 && (!title || x !== title)) || lines[0] || '', 220) || null;

          const pickedImg = H.pickImage(node, { href, allowPageFallback: false });
          const tags = H.gatherTags(node);

          const r = (node as HTMLElement).getBoundingClientRect();
          const bbox = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          const linkCount = node.querySelectorAll('a').length;
          const nodeCount = node.querySelectorAll('*').length || 1;
          const linkDensity = +(linkCount / nodeCount).toFixed(4);
          const charCount = rawText.length;

          if (!title && !href && !snippet) continue;

          const key = href || `${title}|${snippet}` || `${bbox.x},${bbox.y},${bbox.w},${bbox.h}`;
          if (seen.has(key)) continue;
          seen.add(key);

          out.push({
            title: title ?? null,
            href: href ?? null,
            snippet: snippet || null,
            image: pickedImg?.url || null,
            tags: tags.length ? tags : null,
            actions: actions.length ? actions : null,
            selectors: {
              container: H.cssFor(node),
              href: hrefSelector || null,
              image: pickedImg?.selector || null
            },
            container: {
              selector: H.cssFor(node),
              attrs: (() => {
                const m: Record<string, string> = {};
                for (const a of node.getAttributeNames()) if (a.startsWith('data-')) m[a] = String(node.getAttribute(a) || '');
                return m;
              })(),
              bbox
            },
            signals: { charCount, linkCount, linkDensity },
            pageContext: { headings: Array.isArray(pageHeadings) ? pageHeadings : [] }
          });
        }

        return out;
      },
      { rootSel, linkSel, pageHeadings }
    );

    return this.cleanAndDedupeResults(pageResults, maxNeeded);
  }


  private async extractFromPageAnchors(maxNeeded: number): Promise<any[]> {
    const anchors = await this.page!.evaluate(() => {
      const clip = (s: string, n = 400) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
      const els = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const scored = els.map(a => {
        const r = a.getBoundingClientRect();
        const area = Math.max(1, r.width * r.height);
        const txt = clip(a.innerText || a.textContent || '', 180);
        const words = txt.split(/\s+/).filter(Boolean).length;
        let s = 0;
        if (a.href) s += 2;
        if (words >= 1 && words <= 12) s += 2.5;
        s += Math.min(area / 8000, 3);
        return { href: a.href, title: txt || null, score: s };
      }).sort((x, y) => y.score - x.score).slice(0, 100);

      return scored.map(x => ({
        title: x.title,
        href: (() => { try { return new URL(x.href, document.baseURI).toString(); } catch { return x.href; } })(),
        snippet: null,
        image: null,
        tags: null,
        actions: null,
        container: null,
        signals: null
      }));
    });

    return this.cleanAndDedupeResults(anchors, maxNeeded);
  }

  private cleanAndDedupeResults(results: any[], maxNeeded: number): any[] {
    const existingGlobal = new Set(
      this.state.extractedItems
        .map(x => this.canonicalForDedupe((x?.data && (x.data.href || x.data.url)) || ''))
        .filter(Boolean)
    );

    const localSeen = new Set<string>();
    const cleaned = results
      .map((r: any) => {
        const hrefAbs = r.href ? this.toAbsoluteUrl(String(r.href)) : null;
        const title = r.title ? String(r.title).trim() : null;
        const image = this.cleanImageUrl(r.image, this.state.currentUrl) || this.promoteFromTags(r.tags, this.state.currentUrl);
        return { ...r, href: hrefAbs, title, image };
      })
      .filter((r: any) => r.title || r.href || r.snippet)
      .filter((r: any) => {
        const key = (r.href ? this.canonicalForDedupe(r.href) : '') || `${r.title}|${r.snippet || ''}`;
        if (!key) return false;
        if (r.href && existingGlobal.has(this.canonicalForDedupe(r.href))) return false;
        if (localSeen.has(key)) return false;
        localSeen.add(key);
        return true;
      })
      .slice(0, maxNeeded);

    // Remove overly common images (likely page headers/footers)
    this.removeCommonImages(cleaned);

    return cleaned;
  }

  private removeCommonImages(results: any[]): void {
    const counts: Record<string, number> = {};
    for (const r of results) if (r.image) counts[r.image] = (counts[r.image] || 0) + 1;
    const common = Object.entries(counts).find(([_, c]) => c >= 5);
    if (common) {
      const [bad] = common;
      for (const r of results) if (r.image === bad) r.image = null;
    }
  }

  // URL utility methods
  private toAbsoluteUrl(u: string): string {
    try { return new URL(u, this.state.currentUrl).toString(); } catch { return u || ''; }
  }

  private canonicalForDedupe(u: string): string {
    try {
      const url = new URL(u, this.state.currentUrl);
      url.hash = '';
      const remove = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'msclkid', '_hsenc', '_hsmi',
        'ref', 'ref_src', 'ref_url', 'igshid'
      ];
      for (const k of remove) url.searchParams.delete(k);
      if (![...url.searchParams.keys()].length) url.search = '';
      url.protocol = url.protocol.toLowerCase();
      url.hostname = url.hostname.toLowerCase();
      return url.toString();
    } catch { return u || ''; }
  }

  private cleanImageUrl(raw: any, pageUrl: string): string | null {
    if (!raw) return null;
    let u = String(raw).trim();
    if (!u) return null;

    // Less aggressive filtering - only remove obvious data URLs and SVGs
    if (/^data:/i.test(u) || /\.svg(\?|#|$)/i.test(u)) return null;

    u = this.fixDoubledAbsolute(u);
    u = this.absolutize(u, pageUrl);
    if (!u || !/^https?:/i.test(u)) return null;

    return u;
  }

  private promoteFromTags(tags?: any, pageUrl?: string): string | null {
    if (!Array.isArray(tags)) return null;
    for (const t of tags) {
      const s = typeof t === 'string' ? t : '';
      const cleaned = this.cleanImageUrl(s, pageUrl || this.state.currentUrl);
      if (cleaned) return cleaned;
    }
    return null;
  }

  private fixDoubledAbsolute(u: string): string {
    const iHttps = u.indexOf('https://', 1);
    const iHttp = u.indexOf('http://', 1);
    const i = iHttps >= 0 ? iHttps : (iHttp >= 0 ? iHttp : -1);
    return i > 0 ? u.slice(i) : u;
  }

  private absolutize(u: string, base: string): string {
    const v = (u || '').trim();
    if (!v) return v;
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith('//')) {
      try { return new URL(base).protocol + v; } catch { return 'https:' + v; }
    }
    try { return new URL(v, base).toString(); } catch { return v; }
  }

  private getClientHelperBundle(): any {
    // This would be injected into the page context
    const bundle: any = {};

    bundle.clip = (s: string, n = 400) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

    bundle.bestTitle = (node: Element) => {
      // Simplified title extraction
      const text = (node as HTMLElement).innerText || node.textContent || '';
      return text.split('\n')[0]?.trim().slice(0, 200) || null;
    };

    bundle.pickImage = (node: Element, opts: any) => {
      // Simplified image extraction with less aggressive filtering
      const imgs = Array.from(node.querySelectorAll('img')) as HTMLImageElement[];
      for (const img of imgs) {
        const src = img.src || img.getAttribute('src') || img.getAttribute('data-src');
        if (src && !/^data:/i.test(src) && !/\.svg(\?|#|$)/i.test(src)) {
          return src;
        }
      }
      return null;
    };

    bundle.gatherActions = (node: Element, limit: number) => {
      const actions: Array<{ selector: string; role: string | null; name: string | null; href?: string | null }> = [];
      const anchors = Array.from(node.querySelectorAll('a, [role="link"]')) as HTMLAnchorElement[];
      const buttons = Array.from(node.querySelectorAll('button, [role="button"]')) as HTMLElement[];

      // Add anchor actions
      for (const anchor of anchors.slice(0, limit)) {
        actions.push({
          selector: bundle.cssFor(anchor),
          role: 'link',
          name: (anchor.innerText || anchor.textContent || '').trim().slice(0, 100) || null,
          href: anchor.href || null
        });
      }

      // Add button actions
      for (const button of buttons.slice(0, limit - actions.length)) {
        actions.push({
          selector: bundle.cssFor(button),
          role: 'button',
          name: (button.innerText || button.textContent || '').trim().slice(0, 100) || null
        });
      }

      return actions;
    };

    bundle.gatherTags = (node: Element) => {
      const tags: string[] = [];
      const tagNodes = Array.from(
        node.querySelectorAll<HTMLElement>('a[rel~="tag"], .tag, .badge, .chip, .label, .category, .pill')
      );
      for (const el of tagNodes) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text && text.length <= 60) tags.push(text);
      }
      return Array.from(new Set(tags)).slice(0, 8);
    };

    bundle.cssFor = (el: Element): string => {
      // Simplified CSS selector generation
      if (!(el instanceof Element)) return '';
      const id = (el as HTMLElement).id;
      if (id && document.querySelectorAll(`#${id}`).length === 1) return `#${id}`;

      const classes = ((el as HTMLElement).className || '')
        .toString().split(/\s+/).filter(Boolean)
        .filter((c: string) => !/^(_|Mui|css-|sc-|chakra-|ant-|ember|ng-)/.test(c))
        .slice(0, 2);

      const base = `${el.tagName.toLowerCase()}${classes.length ? '.' + classes.join('.') : ''}`;
      const parent = el.parentElement;
      if (!parent) return base;

      const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
      const idx = same.indexOf(el) + 1;
      return `${bundle.cssFor(parent)} > ${base}${same.length > 1 ? `:nth-of-type(${idx})` : ''}`;
    };

    return bundle;
  }

  private getBestHrefAndActions(node: Element, linkSel: string): { href: string | null; actions: any[] } {
    const actions: Array<{ selector: string; role: string | null; name: string | null; href?: string | null }> = [];
    const selSeen = new Set<string>();

    const pushAction = (el: Element, href?: string | null) => {
      const selector = this.cssFor(el);
      if (selSeen.has(selector)) return;
      selSeen.add(selector);
      const role = (el.getAttribute('role') || '').toLowerCase() || (el.tagName.toLowerCase() === 'a' ? 'link' : null);
      const name = (el as HTMLElement).innerText?.trim().slice(0, 100) || null;
      actions.push({ selector, role, name, href: href ?? null });
    };

    const anchors = Array.from(node.querySelectorAll(linkSel)) as HTMLAnchorElement[];
    let href: string | null = null;

    if (anchors.length) {
      const best = anchors
        .map(a => {
          const r = a.getBoundingClientRect();
          const area = Math.max(1, r.width * r.height);
          const txt = (a.innerText || a.textContent || '').trim();
          let s = 0;
          if (a.href) s += 2;
          if (txt && txt.split(/\s+/).length <= 12) s += 2.5;
          s += Math.min(area / 8000, 3);
          return { a, s };
        })
        .sort((x, y) => y.s - x.s)[0];

      if (best) {
        href = best.a.href || best.a.getAttribute('href') || null;
        pushAction(best.a, href);
      }
    }

    const clickables = Array.from(node.querySelectorAll<HTMLElement>('button, [role="button"], [tabindex]')).slice(0, 200);
    for (const el of clickables) pushAction(el, null);

    if (href) {
      try { href = new URL(href, document.baseURI).toString(); } catch { }
    }

    return { href, actions: actions.slice(0, 3) };
  }

  private cssFor(el: Element): string {
    // Simplified CSS selector generation for client-side use
    if (!(el instanceof Element)) return '';
    const id = (el as HTMLElement).id;
    if (id && document.querySelectorAll(`#${id}`).length === 1) return `#${id}`;

    const classes = ((el as HTMLElement).className || '')
      .toString().split(/\s+/).filter(Boolean)
      .filter((c: string) => !/^(_|Mui|css-|sc-|chakra-|ant-|ember|ng-)/.test(c))
      .slice(0, 2);

    const base = `${el.tagName.toLowerCase()}${classes.length ? '.' + classes.join('.') : ''}`;
    const parent = el.parentElement;
    if (!parent) return base;

    const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
    const idx = same.indexOf(el) + 1;
    return `${this.cssFor(parent)} > ${base}${same.length > 1 ? `:nth-of-type(${idx})` : ''}`;
  }

  // ----------------- Utilities -----------------
  private isVisited(url: string): boolean {
    return this.state.visitedUrls.has(url);
  }
  private markVisited(url: string): void {
    this.state.visitedUrls.add(url);
  }
  private isSameSite(href: string): boolean {
    try {
      const a = new URL(this.state.currentUrl);
      const b = new URL(href);
      return a.host === b.host || b.host === '';
    } catch { return true; }
  }

  private async safeGoto(href: string): Promise<void> {
    try {
      await this.page!.goto(href, { waitUntil: 'load', timeout: this.config?.browser?.timeout ?? 30000 });
      this.logger.info('Navigated', { href });
    } catch (e: any) {
      this.logger.warn('Navigation failed', { href, error: e?.message ?? e });
      throw e;
    }
  }

  private shouldContinue(): boolean {
    if (this.schema.target?.maxPages && this.state.currentPage >= this.schema.target.maxPages) return false;
    if (this.schema.target?.maxItems && this.state.extractedItems.length >= this.schema.target.maxItems) return false;
    return true;
  }

  private handleError(error: any): void {
    const scrapingError: ScrapingError = {
      type: 'extraction',
      message: error?.message ?? String(error),
      url: this.state.currentUrl,
      timestamp: new Date()
    };
    this.state.errors.push(scrapingError);
    this.logger.warn('Scraping error occurred', { error: scrapingError });
  }

  private buildResult(): ScrapingResult {
    return {
      url: this.schema.target.baseUrl,
      timestamp: new Date(),
      data: this.state.extractedItems.map(item => item.data),
      metadata: {
        pageCount: this.state.currentPage,
        itemCount: this.state.extractedItems.length,
        duration: Date.now() - this.state.startTime.getTime(),
        errors: this.state.errors
      }
    };
  }

  private async cleanup(): Promise<void> {
    try { if (this.page) await this.page.close(); } catch { }
    try { if (this.browser) await this.browser.close(); } catch { }
  }

  private initializeState(): ScrapingState {
    return {
      currentUrl: this.schema.target.baseUrl,
      visitedUrls: new Set<string>(),
      extractedItems: [],
      currentPage: 1,
      errors: [],
      startTime: new Date()
    };
  }

  private buildStartUrl(): string {
    const base = this.schema.target.baseUrl;
    const path = this.schema.target.startPath || '';
    return `${base}${path}`;
  }

  private async setupPage(): Promise<void> {
    if (!this.page) return;

    await this.page.addInitScript(() => {
      // Small helper bundle attached to window.__H for use inside $$eval/evaluate
      (window as any).__H = (() => {
        const clip = (s: string, n = 400) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

        const cssFor = (el: Element): string => {
          try {
            if (!(el instanceof Element)) return '';
            const id = (el as HTMLElement).id;
            if (id && document.querySelectorAll(`#${id}`).length === 1) return `#${id}`;

            const classes = ((el as HTMLElement).className || '')
              .toString().split(/\s+/).filter(Boolean)
              .filter((c: string) => !/^(_|Mui|css-|sc-|chakra-|ant-|ember|ng-)/.test(c))
              .slice(0, 2);
            const base = `${el.tagName.toLowerCase()}${classes.length ? '.' + classes.join('.') : ''}`;
            const parent = el.parentElement;
            if (!parent) return base;
            const same = Array.from(parent.children).filter(e => e.tagName === el.tagName);
            const idx = same.indexOf(el) + 1;
            return `${cssFor(parent)} > ${base}${same.length > 1 ? `:nth-of-type(${idx})` : ''}`;
          } catch {
            return '';
          }
        };

        const bestTitle = (node: Element) => {
          const prefer = node.querySelector('h1,h2,h3,.title,[itemprop="name"]') as HTMLElement | null;
          const t = (prefer?.innerText || (node as HTMLElement).innerText || node.textContent || '').trim();
          return clip(t, 200) || null;
        };

        const pickSrcFromSrcset = (srcset?: string | null): string | null => {
          if (!srcset) return null;
          // choose the last (usually largest) candidate
          const parts = srcset.split(',').map(s => s.trim()).filter(Boolean);
          if (!parts.length) return null;
          const last = parts[parts.length - 1];
          if (!last) return null;
          const url = last.split(/\s+/)[0];
          return url || null;
        };

        const badImg = (u: string) => /sprite|logo|icon|avatar|placeholder|blank|spacer/i.test(u);

        const pickBackgroundImage = (el: Element): string | null => {
          const style = (el as HTMLElement).getAttribute('style') || '';
          const m = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
          return m?.[2] || null;
        };

        const absolutize = (u: string | null): string | null => {
          if (!u) return null;
          try { return new URL(u, document.baseURI).toString(); } catch { return u; }
        };

        // Helpers this relies on in your codebase:
        // - absolutize(url: string): string | null
        // - badImg(url: string): boolean            // keep, but this also adds extra filters
        // - cssFor(el: Element): string
        // If you don't have pickSrcFromSrcset, this version includes its own.

        const pickImage = (
          node: Element,
          opts: { href?: string | null; allowPageFallback?: boolean } = {}
        ) => {
          type Cand = { url: string; sel: string; score: number; why: string };
          const byUrl = new Map<string, Cand>();

          const normalizeUrl = (u?: string | null) => {
            if (!u) return null;
            try {
              const x = new URL(u, document.baseURI);
              x.hash = '';
              return x.toString();
            } catch {
              return null;
            }
          };

          const equalHref = (a?: string | null, b?: string | null) =>
            !!normalizeUrl(a) && normalizeUrl(a) === normalizeUrl(b);

          const chooseFromSrcset = (srcset?: string | null) => {
            if (!srcset) return null;
            // pick the largest width (or highest density if only x-descriptors)
            let best: { url: string; w: number } | null = null;
            for (const part of srcset.split(',')) {
              const [uRaw, dRaw] = part.trim().split(/\s+/, 2);
              const u = uRaw?.trim();
              if (!u) continue;
              let w = 0;
              if (dRaw?.endsWith('w')) w = parseInt(dRaw, 10) || 0;
              else if (dRaw?.endsWith('x')) w = Math.round((parseFloat(dRaw) || 1) * 1000); // approximate
              else w = 0; // no descriptor
              if (!best || w >= best.w) best = { url: u, w };
            }
            return best ? best.url : null;
          };

          const parseBackgroundUrls = (bg?: string | null): string[] => {
            if (!bg) return [];
            // background-image: url("..."), url('...'), linear-gradient(...)
            const urls: string[] = [];
            const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
            let m: RegExpExecArray | null;
            while ((m = re.exec(bg))) {
              const u = m[2];
              if (u && !/^data:/i.test(u)) urls.push(u);
            }
            return urls;
          };

          const isLikelyDecorative = (el: Element, url: string) => {
            const s = [
              (el as HTMLElement).className || '',
              (el as HTMLElement).id || '',
              el.getAttribute('role') || '',
              el.getAttribute('aria-hidden') || '',
              (el as HTMLImageElement).alt || '',
              url || '',
            ]
              .join(' ')
              .toLowerCase();

            // common junk/decorative patterns (in classes/ids/alts/urls)
            const pat =
              /(avatar|logo|icon|emoji|sprite|chevron|arrow|caret|badge|flag|pin\b|marker|map-?pin|rating|stars?|share|social|placeholder|spacer|pixel|tracking|analytics|ga\.|doubleclick|ad[sx]?|promo|banner)/;
            return pat.test(s);
          };

          const isHiddenOrTiny = (el: Element) => {
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return true;
            const r = (el as HTMLElement).getBoundingClientRect();
            const area = Math.max(1, r.width * r.height);
            return area < 1500; // ~<= 38x38; treat as tiny
          };

          const aspectPenalty = (w: number, h: number) => {
            if (w <= 0 || h <= 0) return 0;
            const r = w / h;
            return r > 3.5 || r < 0.3 ? -1.2 : 0; // avoid ultra-wide banners or ultra-tall slivers
          };

          const push = (el: Element, rawUrl: string | null, base = 1.0, why = '') => {
            const abs = absolutize(rawUrl || '') || normalizeUrl(rawUrl);
            if (!abs) return;

            // quick disqualifiers/penalties
            if (/\.svg(\?|#|$)/i.test(abs)) return; // usually icons/logos
            let s = base;

            if (badImg(abs)) s -= 3;
            if (isLikelyDecorative(el, abs)) s -= 2.5;
            if (isHiddenOrTiny(el)) s -= 1.5;

            // prefer images associated with the item's link
            if (opts?.href) {
              const a = el.closest('a') as HTMLAnchorElement | null;
              if (a && equalHref(a.href, opts.href)) s += 1.6;
            }

            // size/ratio cues
            let w = 0,
              h = 0;
            if (el instanceof HTMLImageElement) {
              w = el.naturalWidth || Math.round((el.getBoundingClientRect().width || 0));
              h = el.naturalHeight || Math.round((el.getBoundingClientRect().height || 0));
            } else {
              const r = (el as HTMLElement).getBoundingClientRect();
              w = Math.round(r.width || 0);
              h = Math.round(r.height || 0);
            }
            const area = Math.max(1, w * h);
            if (area > 40000) s += 0.8; // prefer larger images
            else if (area < 4000) s -= 1.2; // avoid tiny
            s += aspectPenalty(w, h);

            // keep the best candidate per URL (dedupe)
            const prev = byUrl.get(abs);
            const cand: Cand = { url: abs, sel: cssFor(el), score: s, why };
            if (!prev || cand.score > prev.score) byUrl.set(abs, cand);
          };

          // ----- 1) <img> variants (lazy and normal) -----
          const srcAttrs = [
            'src',
            'data-src',
            'data-original',
            'data-lazy',
            'data-lazy-src',
            'data-llsrc',
            'data-img',
            'data-image',
            'data-thumbnail',
            'data-thumb',
            'data-large',
            'data-medium',
          ];

          const imgs = Array.from(node.querySelectorAll('img'));
          for (const img of imgs) {
            for (const a of srcAttrs) {
              const v = img.getAttribute(a);
              if (v && !/^data:/i.test(v)) push(img, v, 2.2, `img:${a}`);
            }
            const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset');
            const chosen = chooseFromSrcset(ss);
            if (chosen) push(img, chosen, 2.45, 'img:srcset');
          }

          // ----- 2) <picture><source srcset> -----
          for (const s of Array.from(node.querySelectorAll('picture source'))) {
            const chosen = chooseFromSrcset(s.getAttribute('srcset'));
            if (chosen) push(s, chosen, 2.3, 'picture:source');
          }

          // ----- 3) <noscript> fallbacks containing <img> -----
          for (const ns of Array.from(node.querySelectorAll('noscript'))) {
            // Many sites put a full <img> inside noscript
            try {
              const temp = document.createElement('div');
              temp.innerHTML = ns.textContent || '';
              const nimg = temp.querySelector('img');
              if (nimg) {
                const nss = nimg.getAttribute('srcset') || nimg.getAttribute('data-srcset');
                const nchosen = chooseFromSrcset(nss) || nimg.getAttribute('src');
                if (nchosen && !/^data:/i.test(nchosen)) push(ns, nchosen, 2.0, 'noscript:img');
              }
            } catch {/* ignore */ }
          }

          // ----- 4) background-image (inline + computed) -----
          const all = Array.from(node.querySelectorAll<HTMLElement>('*'));
          for (const el of all) {
            // inline
            const inline = el.getAttribute('style') || '';
            const inlineUrls = parseBackgroundUrls(inline);
            for (const u of inlineUrls) push(el, u, 1.9, 'bg:inline');

            // computed
            const bg = getComputedStyle(el)?.backgroundImage;
            if (bg && bg !== 'none') {
              for (const u of parseBackgroundUrls(bg)) push(el, u, 1.95, 'bg:computed');
            }

            // some sites put URLs in custom data-attributes for CSS application
            const dataBg =
              el.getAttribute('data-bg') ||
              el.getAttribute('data-background') ||
              el.getAttribute('data-background-image');
            if (dataBg) push(el, dataBg, 1.9, 'bg:data-attr');
          }

          // Collect and rank
          let candidates = Array.from(byUrl.values()).sort((a, b) => b.score - a.score);

          // Optional page-level fallback (og/twitter image) — use sparingly
          if (!candidates.length && opts?.allowPageFallback) {
            const og =
              document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
              document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
            const abs = absolutize(og || '') || normalizeUrl(og);
            if (abs) candidates = [{ url: abs, sel: 'meta[og:image]|meta[twitter:image]', score: 0.5, why: 'page:fallback' }];
          }

          const top = candidates[0];
          return top ? { url: top.url, selector: top.sel } : null;
        };


        const gatherTags = (node: Element) => {
          const tags: string[] = [];
          node.querySelectorAll<HTMLElement>('a[rel~="tag"], .tag, .badge, .chip, .label, .category, .pill')
            .forEach(el => {
              const t = (el.innerText || el.textContent || '').trim();
              if (t && t.length <= 60) tags.push(t);
            });
          return Array.from(new Set(tags)).slice(0, 8);
        };

        const getBestHrefAndActions = (node: Element, linkSel: string) => {
          const actions: Array<{ selector: string; role: string | null; name: string | null; href?: string | null }> = [];
          const selSeen = new Set<string>();

          const pushAction = (el: Element, href?: string | null) => {
            const selector = cssFor(el);
            if (selSeen.has(selector)) return;
            selSeen.add(selector);
            const role = (el.getAttribute('role') || '').toLowerCase() || (el.tagName.toLowerCase() === 'a' ? 'link' : null);
            const name = (el as HTMLElement).innerText?.trim().slice(0, 100) || null;
            actions.push({ selector, role, name, href: href ?? null });
          };

          const anchors = Array.from(node.querySelectorAll(linkSel)) as HTMLAnchorElement[];
          let href: string | null = null;
          let hrefSelector: string | null = null;

          if (anchors.length) {
            const best = anchors
              .map(a => {
                const r = a.getBoundingClientRect();
                const area = Math.max(1, r.width * r.height);
                const txt = (a.innerText || a.textContent || '').trim();
                let s = 0;
                if (a.href) s += 2;
                if (txt && txt.split(/\s+/).length <= 12) s += 2.5;
                s += Math.min(area / 8000, 3);
                return { a, s };
              })
              .sort((x, y) => y.s - x.s)[0];

            if (best) {
              href = best.a.href || best.a.getAttribute('href') || null;
              hrefSelector = cssFor(best.a);
              pushAction(best.a, href);
            }
          }

          const clickables = Array.from(node.querySelectorAll<HTMLElement>('button, [role="button"], [tabindex]')).slice(0, 200);
          for (const el of clickables) pushAction(el, null);

          if (href) {
            try { href = new URL(href, document.baseURI).toString(); } catch { }
          }

          return { href, hrefSelector, actions: actions.slice(0, 3) };
        };

        return { clip, cssFor, bestTitle, pickImage, gatherTags, getBestHrefAndActions, absolutize };
      })();

      // CSS.escape polyfill (no-op if native exists)
      if (!(window as any).CSS) (window as any).CSS = {} as any;
      if (typeof (window as any).CSS.escape !== 'function') {
        (window as any).CSS.escape = (v: any) => String(v).replace(/[^a-zA-Z0-9_\-]/g, (ch: string) => '\\' + ch);
      }
    });

    // Block heavy assets + common trackers (keep as-is, or set blockImages=false if you want naturalWidth/Height)
    const blockImages = true; // <-- flip to false if you actually want to download images
    await this.page.route('**/*', (route) => {
      const req = route.request();
      const type = req.resourceType();
      const url = req.url();

      if (blockImages && ['image', 'media', 'font'].includes(type)) return route.abort();

      const blockHosts = [
        'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'google-analytics.com',
        'facebook.net', 'facebook.com', 'twitter.com', 'hotjar.com', 'segment.io',
        'mixpanel.com', 'newrelic.com', 'nr-data.net'
      ];
      if (blockHosts.some(h => url.includes(h))) return route.abort();

      return route.continue();
    });

    this.page.on('pageerror', (error: Error) => this.logger.error('Page error', { error }));
  }

}
