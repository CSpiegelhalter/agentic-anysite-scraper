export interface ScrapingResult {
    url: string;
    timestamp: Date;
    data: Record<string, any>[];
    metadata: {
      pageCount: number;
      itemCount: number;
      duration: number;
      errors: ScrapingError[];
    };
  }
  
  export interface ScrapingError {
    type: 'extraction' | 'navigation' | 'validation' | 'timeout';
    message: string;
    url?: string;
    selector?: string;
    timestamp: Date;
  }
  
  export interface ExtractedItem {
    url: string;
    data: Record<string, any>;
    rawHtml?: string;
    timestamp: Date;
  }
  
  export interface ScrapingState {
    currentUrl: string;
    visitedUrls: Set<string>;
    extractedItems: ExtractedItem[];
    currentPage: number;
    totalPages?: number;
    errors: ScrapingError[];
    startTime: Date;
  }