import type { Page } from 'playwright';

export type NavigationSchema = {
  followLinks?: boolean;
  linkSelector?: string;         // optional hint for detail links
  pagination?: { nextSelector?: string };
};

export class NavigationFlow {
  constructor(private schema: NavigationSchema = {}) {}

  async hasNextPage(page: Page): Promise<boolean> {
    if (this.schema.pagination?.nextSelector) {
      return await page.locator(this.schema.pagination.nextSelector).first().count().then(c => c > 0);
    }
    // fallback heuristics
    const relNext = page.locator('a[rel="next"]');
    if (await relNext.count()) return true;
    const nextText = page.locator('a:has-text("Next"), a:has-text("More"), a:has-text("Older"), a:has-text("›"), a:has-text("»")');
    return (await nextText.count()) > 0;
  }

  async goToNextPage(page: Page): Promise<void> {
    if (this.schema.pagination?.nextSelector) {
      const el = page.locator(this.schema.pagination.nextSelector).first();
      const href = await el.getAttribute('href');
      if (href) { await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded' }); return; }
      await el.click();
      await page.waitForLoadState('domcontentloaded');
      return;
    }
    const relNext = page.locator('a[rel="next"]').first();
    if (await relNext.count()) {
      const href = await relNext.getAttribute('href');
      if (href) { await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded' }); return; }
      await relNext.click();
      await page.waitForLoadState('domcontentloaded');
      return;
    }
    const nextText = page.locator('a:has-text("Next"), a:has-text("More"), a:has-text("Older"), a:has-text("›"), a:has-text("»")').first();
    if (await nextText.count()) {
      await nextText.click();
      await page.waitForLoadState('domcontentloaded');
      return;
    }
    throw new Error('No next page control found');
  }

  async discoverLinks(page: Page): Promise<string[]> {
    const sel = this.schema.linkSelector || 'main a[href], article a[href], .content a[href]';
    const anchors = page.locator(sel);
    const n = Math.min(await anchors.count(), 200);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const href = await anchors.nth(i).getAttribute('href');
      if (!href) continue;
      try { out.push(new URL(href, page.url()).toString()); } catch { /* ignore */ }
    }
    return Array.from(new Set(out));
  }
}