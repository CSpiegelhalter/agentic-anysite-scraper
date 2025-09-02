export type BBox = { x: number; y: number; w: number; h: number };
export type NodeRef = {
refId: string; // stable per-snapshot id
selector: string; // CSS you can replay in the given frame
frameId: string; // 'main' or 'f#'
role?: string; // aria role or inferred role
name?: string; // short text / accessible name (clipped)
href?: string; // absolute URL if link-like
visible?: boolean;
bbox?: BBox; // coarse geometry
};


export type ListBlock = {
root: NodeRef; // container of repeated items/cards
itemCount: number;
itemLinkSelector?: string; // descendant link selector to reach details
samples: string[]; // 2–3 representative texts (clipped)
};


export type FormField = { label?: string; input: NodeRef };
export type FormBlock = { form: NodeRef; fields: FormField[]; submit?: NodeRef };


export type D2SnapCompact = {
url: string;
title?: string;
headings: string[]; // role=heading or large-font surrogates
lists: ListBlock[]; // ≤ 2
controls: NodeRef[]; // clickable candidates ≤ maxControls
pagination: NodeRef[]; // ranked, ≤ 2
forms: FormBlock[]; // summarized forms
hints: { textDensity: number; linkDensity: number };
};


export type LLMSnapshot = {
compact: D2SnapCompact; // input to LLM
refMap: Record<string, { selector: string; frameId: string }>; // for executor
stats: { sizeBytes: number; frameCount: number; buildMs: number };
};


export type ExtractorOptions = {
limits?: {
maxControls?: number; // default 30
maxLists?: number; // default 2
maxForms?: number; // default 3
maxFormFields?: number; // default 12 total per form
};
includeSameOriginIframes?: boolean; // default true
};


const DEFAULT_LIMITS = { maxControls: 30, maxLists: 2, maxForms: 3, maxFormFields: 12 };


import { Page, ElementHandle } from 'playwright';

// Configuration interface
export interface DOMExtractionConfig {
  maxTextLength?: number;
  includeHidden?: boolean;
  extractDepth?: 'minimal' | 'standard' | 'comprehensive';
  customSelectors?: Record<string, string>;
}

// Result interfaces
export interface DOMElement {
  tagName: string;
  id?: string;
  classes?: string[];
  text?: string;
  attributes?: Record<string, string>;
  selector?: string;
  role?: string;
  isVisible?: boolean;
  
  // Additional properties for specialized elements
  href?: string;        // For links
  method?: string;      // For forms
  submitText?: string;  // For forms
  inputs?: any[];       // For forms
  
  // Allow any additional properties
  [key: string]: any;
}

export interface DOMSnapshot {
  url: string;
  title: string;
  timestamp: number;
  metadata?: Record<string, any>;
  elements?: {
    [key: string]: DOMElement[];
  };
  content?: {
    [key: string]: any;
  };
  // Add diagnostic information for debugging purposes
  _diagnostic?: {
    extractorsRun: string[];
    extractorResults: {
      [extractorName: string]: {
        duration?: number;
        success?: boolean;
        resultType?: string;
        resultSize?: number | string;
        error?: string;
        stack?: string;
        selector?: string;
      };
    };
    extractionTime: number;
  };
}

// Core extractor interface
export interface DOMExtractorStrategy {
  name: string;
  selector: string;
  extract(page: Page, config: DOMExtractionConfig): Promise<any>;
  isApplicable(config: DOMExtractionConfig): boolean;
}

// Extractor registry system
export class DOMExtractorRegistry {
  private static extractors: Map<string, DOMExtractorStrategy> = new Map();
  
  static register(extractor: DOMExtractorStrategy): void {
    this.extractors.set(extractor.name, extractor);
  }
  
  static get(name: string): DOMExtractorStrategy | undefined {
    return this.extractors.get(name);
  }
  
  static getAll(): DOMExtractorStrategy[] {
    return Array.from(this.extractors.values());
  }
  
  static getApplicable(config: DOMExtractionConfig): DOMExtractorStrategy[] {
    return this.getAll().filter(extractor => extractor.isApplicable(config));
  }
}
