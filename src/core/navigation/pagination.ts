import { Page } from 'playwright';
import { PaginationConfig, PaginationSelector, PaginationState } from '../../types';

export class PaginationHandler {
  constructor(
    private config: PaginationConfig,
    private selector: PaginationSelector
  ) {}

  async hasNextPage(page: Page): Promise<boolean> {
    try {
      switch (this.config.strategy) {
        case 'next-button':
          return await this.checkNextButton(page);
        case 'url-pattern':
          return await this.checkUrlPattern(page);
        case 'infinite-scroll':
          return await this.checkInfiniteScroll(page);
        case 'load-more':
          return await this.checkLoadMore(page);
        default:
          return false;
      }
    } catch (error) {
      console.warn('Pagination check failed:', error);
      return false;
    }
  }

  async goToNextPage(page: Page): Promise<void> {
    try {
      switch (this.config.strategy) {
        case 'next-button':
          await this.clickNextButton(page);
          break;
        case 'url-pattern':
          await this.navigateToNextUrl(page);
          break;
        case 'infinite-scroll':
          await this.scrollToLoadMore(page);
          break;
        case 'load-more':
          await this.clickLoadMore(page);
          break;
      }
      
      // Wait for content to load
      if (this.config.waitForLoad) {
        await page.waitForTimeout(this.config.waitForLoad);
      }
      
    } catch (error) {
      throw new Error(`Failed to go to next page: ${error}`);
    }
  }

  private async checkNextButton(page: Page): Promise<boolean> {
    const nextButton = await page.$(this.selector.nextButton);
    if (!nextButton) return false;
    
    // Check if button is disabled or hidden
    const isVisible = await nextButton.isVisible();
    const isDisabled = await nextButton.getAttribute('disabled') !== null;
    
    return isVisible && !isDisabled;
  }

  private async clickNextButton(page: Page): Promise<void> {
    const nextButton = await page.$(this.selector.nextButton);
    if (!nextButton) {
      throw new Error('Next button not found');
    }
    
    await nextButton.click();
  }

  private async checkUrlPattern(page: Page): Promise<boolean> {
    const currentUrl = page.url();
    const pageIndicator = await page.$(this.selector.pageIndicator);
    
    if (pageIndicator) {
      const currentPage = await pageIndicator.textContent();
      const pageNum = parseInt(currentPage || '1');
      
      if (this.selector.maxPages && pageNum >= this.selector.maxPages) {
        return false;
      }
      
      return true;
    }
    
    return false;
  }

  private async navigateToNextUrl(page: Page): Promise<void> {
    // Extract current page number from URL and increment
    const currentUrl = page.url();
    const urlPattern = /page=(\d+)/;
    const match = currentUrl.match(urlPattern);
    
    if (match) {
      const currentPage = parseInt(match[1]);
      const nextPage = currentPage + 1;
      const nextUrl = currentUrl.replace(urlPattern, `page=${nextPage}`);
      await page.goto(nextUrl);
    }
  }

  private async checkInfiniteScroll(page: Page): Promise<boolean> {
    // Check if we've reached the bottom or if there's more content
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const clientHeight = await page.evaluate(() => document.documentElement.clientHeight);
    const scrollTop = await page.evaluate(() => window.pageYOffset);
    
    return scrollTop + clientHeight < scrollHeight;
  }

  private async scrollToLoadMore(page: Page): Promise<void> {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    
    // Wait for new content to load
    await page.waitForTimeout(1000);
  }

  private async checkLoadMore(page: Page): Promise<boolean> {
    const loadMoreButton = await page.$('[data-load-more], .load-more, button:contains("Load More")');
    return loadMoreButton !== null;
  }

  private async clickLoadMore(page: Page): Promise<void> {
    const loadMoreButton = await page.$('[data-load-more], .load-more, button:contains("Load More")');
    if (loadMoreButton) {
      await loadMoreButton.click();
    }
  }
}