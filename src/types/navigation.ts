export interface NavigationState {
    currentUrl: string;
    history: string[];
    depth: number;
    pageCount: number;
  }
  
  export interface PaginationState {
    currentPage: number;
    hasNextPage: boolean;
    nextUrl?: string;
    pageUrls: string[];
  }
  
  export interface LinkDiscovery {
    url: string;
    text?: string;
    follow: boolean;
    priority: number;
  }