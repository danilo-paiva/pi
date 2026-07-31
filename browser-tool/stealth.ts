import type { Browser, Page } from "puppeteer";

/**
 * Basic stealth: patch the most common bot fingerprints so the page does not
 * see a headless automation client. This is intentionally lighter than
 * oh-my-pi's 14-script suite — enough to dodge naive checks, not a full
 * fingerprinting lab.
 */
export async function applyStealth(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    } catch { /* ignore */ }

    try {
      // @ts-ignore - fake the chrome object
      (window as any).chrome = {
        runtime: {},
        loadTimes: () => ({}),
        csi: () => ({}),
        app: {},
      };
    } catch { /* ignore */ }

    try {
      const orig = (window as any).Function.prototype.toString;
      (window as any).Function.prototype.toString = function (...args: unknown[]) {
        if (this === orig) return "function Function() { [native code] }";
        return orig.apply(this, args);
      };
    } catch { /* ignore */ }

    // Spoof languages / platform a touch
    try {
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    } catch { /* ignore */ }
  });
}

/**
 * Build a normal-looking User-Agent from the real Chromium version, replacing
 * "HeadlessChrome" and faking a Windows platform.
 */
export async function buildUserAgent(browser: Browser): Promise<string> {
  const raw = await browser.userAgent();
  return raw
    .replace("HeadlessChrome", "Chrome")
    .replace(/\(([^)]+)\)/, "(Windows NT 10.0; Win64; x64)");
}
