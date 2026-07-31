import { writeFile } from "node:fs/promises";
import type { Browser, ElementHandle, Page } from "puppeteer";

export interface ObservedElement {
  ref: string;
  role: string;
  name: string;
  selector: string;
  tag: string;
  type?: string;
  placeholder?: string;
  value?: string;
  handle?: ElementHandle | null;
}

interface SnapNode {
  ref: string;
  role: string;
  name: string;
  children: SnapNode[];
}

interface SnapResult {
  root: SnapNode;
  flat: Array<Omit<ObservedElement, "handle">>;
}

const MAX_DEPTH = 16;

/**
 * In-browser walker. Assigns a `data-bref="N"` attribute to every element so
 * Node-land can resolve an ElementHandle later, and returns the accessibility
 * tree plus a flat list of interactive elements with refs.
 */
function domWalker(): SnapResult {
  const MAX_DEPTH = 16;
  const INTERACTIVE = new Set([
    "a", "button", "input", "select", "textarea", "label", "img", "summary", "option",
  ]);

  function roleOf(el: Element): string {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    switch (tag) {
      case "A": return el.getAttribute("href") ? "link" : "generic";
      case "BUTTON": return "button";
      case "INPUT": {
        const t = (el as HTMLInputElement).type;
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "submit" || t === "button") return "button";
        return "textbox";
      }
      case "TEXTAREA": return "textbox";
      case "SELECT": return "combobox";
      case "IMG": return el.getAttribute("alt") ? "img" : "generic";
      case "SUMMARY": return "button";
      default: return "generic";
    }
  }

  function nameOf(el: Element): string {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      (el.textContent ? el.textContent.trim().replace(/\s+/g, " ").slice(0, 80) : "")
    );
  }

  function isInteractive(el: Element): boolean {
    if (INTERACTIVE.has(el.tagName.toLowerCase())) return true;
    if (el.getAttribute("role")) return true;
    if (el.getAttribute("contenteditable") === "true") return true;
    if (el.tagName === "LABEL" && (el as HTMLLabelElement).control) return true;
    return false;
  }

  let counter = 0;
  const flat: Array<Omit<ObservedElement, "handle">> = [];

  function walk(el: Element, depth: number): SnapNode {
    const n = ++counter;
    (el as HTMLElement).setAttribute("data-bref", String(n));
    const role = roleOf(el);
    const name = nameOf(el);
    const node: SnapNode = { ref: `e${n}`, role, name, children: [] };

    if (depth <= MAX_DEPTH) {
      if (isInteractive(el)) {
        const inp = el as HTMLInputElement;
        flat.push({
          ref: `e${n}`,
          role,
          name,
          selector: `[data-bref="${n}"]`,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || undefined,
          placeholder: el.getAttribute("placeholder") || undefined,
          value: inp.value !== undefined ? inp.value : undefined,
        });
      }
      for (const child of Array.from(el.children)) {
        node.children.push(walk(child, depth + 1));
      }
    }
    return node;
  }

  const root = walk(document.body, 0);
  return { root, flat };
}

async function snapshot(page: Page): Promise<{ flat: ObservedElement[]; root: SnapNode }> {
  const data = await page.evaluate(domWalker);
  const flat: ObservedElement[] = [];
  for (const f of data.flat) {
    flat.push({ ...f, handle: await page.$(f.selector) });
  }
  return { flat, root: data.root };
}

function toYaml(node: SnapNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  let out = `${pad}- ${node.role}${node.name ? ` "${node.name}"` : ""} [ref=${node.ref}]\n`;
  for (const c of node.children) out += toYaml(c, depth + 1);
  return out;
}

async function extractContent(page: Page, format: "markdown" | "text"): Promise<string> {
  return page.evaluate((fmt: string) => {
    if (fmt === "text") return document.body.innerText;
    const lines: string[] = [];
    const push = (s: string) => { if (s.trim()) lines.push(s.trim()); };
    document.querySelectorAll("h1,h2,h3,h4").forEach((el) => {
      const level = Number(el.tagName[1]);
      push(`${"#".repeat(level)} ${el.textContent?.trim()}`);
    });
    document.querySelectorAll("p,li").forEach((el) => push(el.textContent?.trim() ?? ""));
    document.querySelectorAll("a[href]").forEach((el) => {
      const href = el.getAttribute("href");
      const text = el.textContent?.trim();
      if (href && text) push(`[${text}](${href})`);
    });
    document.querySelectorAll("pre,code").forEach((el) => push("```\n" + (el.textContent?.trim() ?? "") + "\n```"));
    return lines.join("\n");
  }, format);
}

export interface Tab {
  page: Page;
  _images: string[];
  refresh(): Promise<ObservedElement[]>;
  goto(url: string, opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2" }): Promise<void>;
  observe(opts?: { includeAll?: boolean; viewportOnly?: boolean }): Promise<string>;
  ariaSnapshot(opts?: { depth?: number; selector?: string }): Promise<string>;
  id(n: number): ElementHandle | null;
  ref(r: string): ElementHandle | null;
  click(selector: unknown): Promise<void>;
  type(selector: unknown, text: string): Promise<void>;
  fill(selector: unknown, value: string): Promise<void>;
  press(key: string, opts?: { selector?: unknown }): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  drag(from: unknown, to: unknown): Promise<void>;
  select(selector: unknown, ...values: string[]): Promise<string[]>;
  uploadFile(selector: unknown, ...paths: string[]): Promise<void>;
  scrollIntoView(selector: unknown): Promise<void>;
  waitFor(selector: string, opts?: { timeout?: number; visible?: boolean; hidden?: boolean }): Promise<ElementHandle | null>;
  waitForSelector(selector: string, opts?: { timeout?: number; visible?: boolean; hidden?: boolean }): Promise<ElementHandle | null>;
  waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
  waitForResponse(pattern: string | RegExp | ((r: unknown) => boolean), opts?: { timeout?: number }): Promise<string>;
  waitForNavigation(opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeout?: number }): Promise<void>;
  evaluate(fn: (...args: unknown[]) => unknown, ...args: unknown[]): Promise<unknown>;
  screenshot(opts?: { selector?: string; fullPage?: boolean; save?: string; silent?: boolean }): Promise<string>;
  extract(format?: "markdown" | "text"): Promise<string>;
}

export function buildTab(
  page: Page,
  _getBrowser: () => Promise<Browser>,
  signal?: AbortSignal,
): Tab {
  let currentFlat: ObservedElement[] = [];

  async function refresh(): Promise<ObservedElement[]> {
    const snap = await snapshot(page);
    currentFlat = snap.flat;
    return currentFlat;
  }

  function matchPattern(pattern: string | RegExp, s: string): boolean {
    if (pattern instanceof RegExp) return pattern.test(s);
    return s.includes(pattern);
  }

  function handler(sel: unknown): Promise<ElementHandle | null> {
    if (sel && typeof sel === "object" && "click" in (sel as object)) {
      return Promise.resolve(sel as ElementHandle);
    }
    if (typeof sel === "string") {
      const s = sel.trim();
      if (s.startsWith("aria-ref=")) return ref(s.slice("aria-ref=".length));
      return page.$(s);
    }
    return Promise.resolve(null);
  }

  function ref(r: string): Promise<ElementHandle | null> {
    const target = currentFlat.find((f) => f.ref === r);
    return Promise.resolve(target?.handle ?? null);
  }

  const tab: Tab = {
    page,
    _images: [],
    refresh,
    async goto(url, opts) {
      await page.goto(url, { waitUntil: opts?.waitUntil ?? "networkidle2", timeout: 30000, signal });
      await refresh();
    },
    async observe() {
      const flat = await refresh();
      const lines = flat.map(
        (e) =>
          `#${e.ref.replace("e", "")} ${e.role}${e.name ? ` "${e.name}"` : ""}` +
          `${e.placeholder ? ` placeholder=${e.placeholder}` : ""}` +
          `${e.value ? ` value=${JSON.stringify(e.value).slice(0, 60)}` : ""}` +
          ` <${e.tag}${e.type ? ` type=${e.type}` : ""}>`,
      );
      return lines.join("\n");
    },
    async ariaSnapshot() {
      const snap = await snapshot(page);
      currentFlat = snap.flat;
      return toYaml(snap.root);
    },
    id(n) {
      return currentFlat[n - 1]?.handle ?? null;
    },
    ref,
    async click(sel) {
      const h = await handler(sel);
      if (!h) throw new Error(`click: no element for ${JSON.stringify(sel)}`);
      await h.click();
    },
    async type(sel, text) {
      const h = await handler(sel);
      if (!h) throw new Error(`type: no element for ${JSON.stringify(sel)}`);
      await h.focus();
      await h.type(text);
    },
    async fill(sel, value) {
      const h = await handler(sel);
      if (!h) throw new Error(`fill: no element for ${JSON.stringify(sel)}`);
      await h.evaluate((el: HTMLInputElement, v: string) => {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, v);
        else el.value = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
    },
    async press(key, opts) {
      if (opts?.selector) {
        const h = await handler(opts.selector);
        await h?.focus();
      }
      await page.keyboard.press(key as any);
    },
    async scroll(dx, dy) {
      await page.mouse.wheel({ deltaX: dx, deltaY: dy });
    },
    async drag(from, to) {
      const resolvePoint = async (p: unknown): Promise<{ x: number; y: number }> => {
        if (typeof p === "object" && p && "x" in (p as object) && "y" in (p as object)) {
          return p as { x: number; y: number };
        }
        const h = await handler(p);
        if (!h) throw new Error(`drag: no element for ${JSON.stringify(p)}`);
        const box = await h.boundingBox();
        if (!box) throw new Error("drag: element has no box");
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      };
      const a = await resolvePoint(from);
      const b = await resolvePoint(to);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move(b.x, b.y, { steps: 10 });
      await page.mouse.up();
    },
    async select(sel, ...values) {
      const h = await handler(sel);
      if (!h) throw new Error(`select: no element for ${JSON.stringify(sel)}`);
      return page.select(h as any, ...values);
    },
    async uploadFile(sel, ...paths) {
      const h = await handler(sel);
      if (!h) throw new Error(`uploadFile: no element for ${JSON.stringify(sel)}`);
      await h.uploadFile(...paths);
    },
    async scrollIntoView(sel) {
      const h = await handler(sel);
      if (!h) throw new Error(`scrollIntoView: no element for ${JSON.stringify(sel)}`);
      await h.evaluate((el: Element) => el.scrollIntoView({ block: "center" }));
    },
    async waitFor(selector, opts) {
      return page.waitForSelector(selector, { timeout: opts?.timeout ?? 30000, visible: opts?.visible, hidden: opts?.hidden, signal });
    },
    async waitForSelector(selector, opts) {
      return page.waitForSelector(selector, { timeout: opts?.timeout ?? 30000, visible: opts?.visible, hidden: opts?.hidden, signal });
    },
    async waitForUrl(pattern, opts) {
      const deadline = Date.now() + (opts?.timeout ?? 30000);
      while (Date.now() < deadline) {
        if (matchPattern(pattern, page.url())) return page.url();
        await new Promise((r) => setTimeout(r, 200));
        if (signal?.aborted) throw new Error("aborted");
      }
      throw new Error(`waitForUrl timed out waiting for ${pattern}`);
    },
    async waitForResponse(pattern, opts) {
      const resp = await page.waitForResponse(
        (r: any) => {
          if (typeof pattern === "function") return (pattern as (x: unknown) => boolean)(r);
          return matchPattern(pattern as string | RegExp, r.url());
        },
        { timeout: opts?.timeout ?? 30000, signal },
      );
      return resp.url();
    },
    async waitForNavigation(opts) {
      await page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "networkidle2", timeout: opts?.timeout ?? 30000, signal });
    },
    async evaluate(fn, ...args) {
      return page.evaluate(fn as any, ...(args as any));
    },
    async screenshot(opts) {
      const target = opts?.selector ? await page.$(opts.selector) : page;
      const buf = await (target as any).screenshot({
        fullPage: opts?.fullPage,
        encoding: "base64",
      });
      if (opts?.save) {
        await writeFile(opts.save, Buffer.from(buf, "base64"));
      }
      if (!opts?.silent) tab._images.push(buf);
      return opts?.save ? opts.save : "[screenshot attached]";
    },
    async extract(format) {
      return extractContent(page, format ?? "markdown");
    },
  };

  return tab;
}
