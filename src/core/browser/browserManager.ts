import { chromium, firefox, webkit, type Browser, type LaunchOptions, type BrowserType } from 'playwright';


export type BrowserKind = 'chromium' | 'firefox' | 'webkit';
export type BrowserConfig = {
kind?: BrowserKind; // default: chromium
headless?: boolean; // default: true
slowMo?: number; // default: 0
timeout?: number; // default: 30000
executablePath?: string; // optional custom binary
userAgent?: string; // optional UA override
proxy?: { server: string; username?: string; password?: string };
};


export class BrowserManager {
constructor(private cfg: BrowserConfig = {}) {}


async launch(): Promise<Browser> {
const kind = this.cfg.kind ?? 'chromium';
const type: BrowserType<Browser> = kind === 'firefox' ? firefox : kind === 'webkit' ? webkit : chromium;
const opts: LaunchOptions = {
    headless: this.cfg.headless ?? true,
    slowMo: this.cfg.slowMo ?? 0,
    timeout: this.cfg.timeout ?? 30000,
    ...(this.cfg.executablePath !== undefined ? { executablePath: this.cfg.executablePath } : {}),
    ...(this.cfg.proxy !== undefined ? { proxy: this.cfg.proxy } : {}),
  };
const browser = await type.launch(opts);
return browser;
}
}