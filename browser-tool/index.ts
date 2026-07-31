import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { applyStealth, buildUserAgent } from "./stealth";
import { buildTab } from "./tab";

// One browser per session; named tabs persist across run calls.
const tabs = new Map<string, Page>();
let browser: Browser | null = null;
let autoCloseTimer: NodeJS.Timeout | null = null;

function scheduleAutoClose(): void {
  if (autoCloseTimer) clearTimeout(autoCloseTimer);
  autoCloseTimer = setTimeout(async () => {
    for (const p of tabs.values()) await p.close().catch(() => {});
    tabs.clear();
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    autoCloseTimer = null;
  }, 5 * 60 * 1000); // 5 minutos
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    protocolTimeout: 60_000,
  });
  return browser;
}

async function openTab(
  name: string,
  url: string | undefined,
  viewport: { width: number; height: number } | undefined,
  dialogs: "accept" | "dismiss" | undefined,
): Promise<Page> {
  const b = await getBrowser();
  let page = tabs.get(name);
  if (!page) {
    page = await b.newPage();
    tabs.set(name, page);
    await applyStealth(page);
    await page.setUserAgent(await buildUserAgent(b));
    if (dialogs) {
      page.on("dialog", (d) =>
        dialogs === "accept" ? d.accept() : d.dismiss().catch(() => {}),
      );
    }
  }
  if (viewport) await page.setViewport(viewport);
  scheduleAutoClose();
  if (url) {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    // refresh element index for ref()/id()
    const tab = buildTab(page, getBrowser);
    await tab.refresh();
  }
  return page;
}

async function closeTab(name: string, all: boolean | undefined, kill: boolean | undefined) {
  if (all) {
    for (const p of tabs.values()) await p.close().catch(() => {});
    tabs.clear();
    if (kill && browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
    return;
  }
  const p = tabs.get(name);
  if (p) {
    await p.close().catch(() => {});
    tabs.delete(name);
  }
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function (pi: ExtensionAPI) {
  // Clean up the browser process when the session ends.
  pi.on("session_shutdown", async () => {
    for (const p of tabs.values()) await p.close().catch(() => {});
    tabs.clear();
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
  });

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description:
      "Drive a headless Chromium tab. Three actions: open (acquire/reuse a named tab and optionally navigate), " +
      "close (release a tab or all tabs), run (execute JS in an open tab with `tab.*` helpers). " +
      "Prefer `read`/fetch_content for static pages; use this for JS execution, auth, and interactive actions. " +
      "NEVER create temporary .js files to test or drive the browser. Always run code inline via the `run` action " +
      "with `code` containing the full script. The `code` field accepts the entire async function body.",

    promptSnippet: "Open a headless browser tab and drive it (click, type, extract) via JS",
    promptGuidelines: [
      "Use browser only for pages that need JS execution, login, or interaction; for static articles/docs use read/fetch_content instead.",
      "Always call browser action=open before action=run; run never creates a tab.",
      "Inside run, default to tab.observe() or tab.ariaSnapshot() to discover element refs, then act with tab.click/type/fill using the ref or a CSS selector.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "close", "run"] as const, {
        description: "open | close | run",
      }),
      name: Type.Optional(
        Type.String({ description: 'Tab name, defaults to "main". Reused if already open.' }),
      ),
      url: Type.Optional(
        Type.String({ description: "URL to navigate to. open only. Omit to reuse an existing tab." }),
      ),
      viewport: Type.Optional(
        Type.Object(
          { width: Type.Number(), height: Type.Number() },
          { description: "Viewport size for open." },
        ),
      ),
      dialogs: Type.Optional(
        StringEnum(["accept", "dismiss"] as const, {
          description: "Auto-handle alert/confirm/beforeunload dialogs. open only.",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({ description: "close all tabs. close only." }),
      ),
      kill: Type.Optional(
        Type.Boolean({ description: "Also terminate the browser process. Requires all:true." }),
      ),
      code: Type.Optional(
        Type.String({
          description:
            "JS body executed in the tab (run only). Async function body; in scope: page, browser, tab, display, signal, wait, assert. " +
            "tab helpers: goto, observe, ariaSnapshot, click, type, fill, press, scroll, drag, select, uploadFile, scrollIntoView, " +
            "waitFor, waitForSelector, waitForUrl, waitForResponse, waitForNavigation, evaluate, screenshot, extract.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate) {
      const name = params.name ?? "main";

      if (params.action === "open") {
        const page = await openTab(name, params.url, params.viewport, params.dialogs);
        return {
          content: [{ type: "text", text: `Tab "${name}" ready at ${page.url()}` }],
          details: { url: page.url() },
        };
      }

      if (params.action === "close") {
        await closeTab(name, params.all, params.kill);
        return {
          content: [{ type: "text", text: params.all ? "All tabs closed" : `Tab "${name}" closed` }],
          details: {},
        };
      }

      if (params.action === "run") {
        if (!params.code) throw new Error("run requires `code`");
        const page = tabs.get(name);
        if (!page) throw new Error(`Tab "${name}" is not open. Call open first.`);

        const tab = buildTab(page, getBrowser, signal);
        const outputs: string[] = [];
        const display = (v: unknown) =>
          outputs.push(typeof v === "string" ? v : safeStringify(v));

        const wait = (ms: number) =>
          new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(t);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });

        const assert = (cond: unknown, msg?: string) => {
          if (!cond) throw new Error(msg ?? "assertion failed");
        };

        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function(
          "page",
          "browser",
          "tab",
          "display",
          "signal",
          "wait",
          "assert",
          `"use strict";\nreturn (async () => {\n${params.code}\n})();`,
        );

        const result = await fn(page, await getBrowser(), tab, display, signal, wait, assert);

        const content: Array<{ type: "text"; text: string } | { type: "image"; source: { type: "base64"; mediaType: string; data: string } }> = [];
        const text = outputs.join("\n");
        if (text) content.push({ type: "text", text });
        if (result !== undefined) {
          content.push({ type: "text", text: "Return: " + safeStringify(result) });
        }
        for (const img of tab._images) {
          content.push({
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: img },
          });
        }
        if (content.length === 0) content.push({ type: "text", text: "(no output)" });

        return { content, details: {} };
      }

      throw new Error(`Unknown action: ${params.action}`);
    },
  });
}
