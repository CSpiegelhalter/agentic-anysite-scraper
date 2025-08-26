export type OutputFormat = 'json' | 'jsonl' | 'csv';
export type OutputTarget = { directory: string; filename?: string; format?: OutputFormat };


export interface ScrapingConfig {
    browser: {
      headless: boolean;
      slowMo: number;
      timeout: number;
    };
    retry: {
      attempts: number;
      delay: number;
    };
    output: OutputTarget;
  }

export interface ScrapingSchema {
    name: string;
    description?: string;
    target: {
        baseUrl: string;
        startPath?: string;
        maxPages?: number;
        maxItems?: number;
    };
    navigation: NavigationConfig;
    selectors: DataSelectors;
    pagination?: PaginationConfig;
    output: OutputTarget;
    validation?: ValidationRules;
}

export interface NavigationConfig {
    type: 'single' | 'multi' | 'flow';
    followLinks?: boolean;
    maxDepth?: number;
    allowedDomains?: string[];
    excludedPaths?: string[];
    waitFor?: WaitConditions;
}

export interface DataSelectors {
    container: string;
    fields: Record<string, FieldSelector>;
    links?: LinkSelector[];
    pagination?: PaginationSelector;
}

export interface FieldSelector {
    selector: string;
    type: 'text' | 'number' | 'date' | 'url' | 'image' | 'html' | 'attribute';
    attribute?: string;
    transform?: string;
    required?: boolean;
    fallback?: string;
}

export interface LinkSelector {
    selector: string;
    attribute: string;
    filter?: string;
    follow?: boolean;
}

export interface PaginationSelector {
    nextButton: string;
    pageIndicator?: string;
    maxPages?: number;
}

export interface PaginationConfig {
    strategy: 'next-button' | 'url-pattern' | 'infinite-scroll' | 'load-more';
    waitForLoad?: number;
    scrollBehavior?: 'smooth' | 'instant' | 'none';
}

export interface WaitConditions {
    selector?: string;
    timeout?: number;
    delay?: number;
}

export interface ValidationRules {
    requiredFields: string[];
    dataTypes: Record<string, 'string' | 'number' | 'date' | 'boolean'>;
    constraints?: Record<string, any>;
}