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