// ScrapingEngine.ts
import { Browser, Page } from 'playwright';
import { ScrapingSchema, ScrapingResult, ScrapingState, ScrapingError } from '../../types';
import { BrowserManager } from '../browser/browserManager';
import { Logger } from '../../utils/logger';
import { OutputWriter } from '../../output/writer';
import { NavigationFlow } from '../navigation/flow';

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
      await this.page.goto(startUrl, { waitUntil: 'load', timeout: this.config?.browser?.timeout ?? 30000 });
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

  // ----------------- Snapshot-driven loop -----------------
  private async scrapingLoop(): Promise<ScrapingResult> {
    const navigation = new NavigationFlow(this.schema.navigation);

    while (this.shouldContinue()) {
      try {
        const snap = await this.takeSnapshot();
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
            await this.page!.goBack().catch(() => {});
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
    // If your schema provides explicit selectors, try that first
    // (shape is project-specific; we handle a common pattern: { itemRoot, fields: [{name, selector, attr?}] })
    const s: any = (this.schema as any).selectors;
    if (s?.itemRoot && Array.isArray(s?.fields)) {
      try {
        const maxNeeded = Math.max(
          (this.schema.target?.maxItems ?? Number.MAX_SAFE_INTEGER) - this.state.extractedItems.length,
          0
        );
        if (maxNeeded <= 0) return [];

        const results = await this.page!.$$eval(s.itemRoot, (nodes, fields) => {
          const clip = (t: string) => (t || '').replace(/\s+/g, ' ').trim();
          return (nodes as Element[]).map(node => {
            const obj: Record<string, any> = {};
            for (const f of fields as any[]) {
              const el = f.selector ? (node as Element).querySelector(f.selector) : null;
              if (!el) { obj[f.name] = null; continue; }
              if (f.attr === 'href') obj[f.name] = (el as HTMLAnchorElement).href || null;
              else if (f.attr === 'html') obj[f.name] = el.innerHTML ?? null;
              else obj[f.name] = clip(el.textContent || '');
            }
            return obj;
          });
        }, s.fields);

        return results.slice(0, maxNeeded);
      } catch (e) {
        this.logger.warn('Schema-based extraction failed; falling back to snapshot lists.', { error: (e as any)?.message });
      }
    }

    // Fallback: derive items from snapshot ListBlocks
    const lists: ListBlock[] = snap?.compact?.lists ?? [];
    if (!lists.length) return [];

    const maxNeeded = Math.max(
      (this.schema.target?.maxItems ?? Number.MAX_SAFE_INTEGER) - this.state.extractedItems.length,
      0
    );
    if (maxNeeded <= 0) return [];

    const firstList = lists[0];
    const rootSel = firstList?.root?.selector;
    const linkSel = firstList?.itemLinkSelector ?? 'a, [role=link]';

    if (!rootSel) return [];

    // Pull a reasonably structured generic item: {text, href}
    const genericItems = await this.page!.$$eval(rootSel, (roots, linkSel) => {
      const clip = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
      const items: { text: string; href: string | null }[] = [];
      for (const r of roots as Element[]) {
        // Each "repeat" sibling acts like an item; extract first meaningful link/text
        const link = r.querySelector(linkSel as string) as HTMLAnchorElement | null;
        const href = link?.href ?? null;
        const text = clip((r.textContent || '').slice(0, 500));
        if (text || href) items.push({ text, href });
      }
      return items;
    }, linkSel);

    return genericItems.slice(0, maxNeeded);
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
    try { if (this.page) await this.page.close(); } catch {}
    try { if (this.browser) await this.browser.close(); } catch {}
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
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    this.page.on('pageerror', (error: Error) => this.logger.error('Page error', { error }));
  }
}
