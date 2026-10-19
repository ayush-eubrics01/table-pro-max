// A small W3C WebDriver client for the end-to-end tests: enough to drive the app through
// tauri-driver without a test framework's dependencies. https://www.w3.org/TR/webdriver2/

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

/** Keys for `keys()`: WebDriver's code points for the keys that aren't characters. */
export const Key = { Enter: "", Escape: "", Control: "", Shift: "", Tab: "", Backspace: "", End: "" };

export class Session {
  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  /** Starts the app under tauri-driver (`base` is its address) and returns the session. */
  static async start(base, application) {
    const r = await call(base, "POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application } } },
    });
    return new Session(base, r.sessionId);
  }

  cmd(method, path, body) {
    return call(this.base, method, `/session/${this.id}${path}`, body);
  }

  quit() {
    return this.cmd("DELETE", "");
  }

  /** Runs a function in the page; DOM nodes come back as element ids. */
  run(fn, ...args) {
    return this.cmd("POST", "/execute/sync", { script: `return (${fn}).apply(null, arguments)`, args });
  }

  /** Waits until `fn` (run in the page) returns something truthy, and returns it. */
  async until(what, fn, ...args) {
    const deadline = Date.now() + 15_000;
    let last;
    for (;;) {
      try {
        last = await this.run(fn, ...args);
        if (last) return last;
      } catch (e) {
        last = e;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what} (${last instanceof Error ? last.message : JSON.stringify(last)})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /**
   * The first visible element matching `selector` whose accessible text (aria-label, else text)
   * equals `name` (or matches it, for a RegExp); waits for it.
   */
  find(selector, name) {
    const pattern = name instanceof RegExp ? { source: name.source, flags: name.flags } : null;
    return this.until(`${selector} "${name ?? ""}"`, (sel, text, re) => {
      const named = (el) => {
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ");
        if (re) return new RegExp(re.source, re.flags).test(label);
        return text === null || label === text;
      };
      return [...document.querySelectorAll(sel)].find((el) => el.getClientRects().length > 0 && named(el)) ?? null;
    }, selector, pattern ? null : (name ?? null), pattern);
  }

  async click(selector, name) {
    const el = await this.find(selector, name);
    try {
      await this.cmd("POST", `/element/${el[ELEMENT]}/click`, {});
    } catch (e) {
      if (!/intercepted/.test(e.message)) throw e;
      // WebKitWebDriver's own hit test misplaces points in the app's undecorated window. Click
      // through the page only when the page agrees nothing covers the element.
      const clicked = await this.run((node) => {
        const r = node.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        if (!top || !(top === node || node.contains(top))) return false;
        node.click();
        return true;
      }, el);
      if (!clicked) throw e;
    }
    return el;
  }

  /** Types into the element (focused by WebDriver first). */
  async type(selector, name, text) {
    const el = await this.find(selector, name);
    await this.cmd("POST", `/element/${el[ELEMENT]}/value`, { text });
    return el;
  }

  /** Presses keys as a chord on whatever has the focus, e.g. `keys(Key.Control, "k")`. */
  async keys(...chord) {
    const down = chord.map((value) => ({ type: "keyDown", value }));
    const up = [...chord].reverse().map((value) => ({ type: "keyUp", value }));
    await this.cmd("POST", "/actions", { actions: [{ type: "key", id: "keyboard", actions: [...down, ...up] }] });
    await this.cmd("DELETE", "/actions");
  }

  /** Text of the page's body, for waiting on what the user would read. */
  text() {
    return this.run(() => document.body.innerText);
  }

  /** Waits until the page shows `text` (a string or RegExp). */
  async see(text) {
    const pattern = text instanceof RegExp ? { source: text.source, flags: text.flags } : null;
    await this.until(`"${text}" on screen`, (t, re) => (re ? new RegExp(re.source, re.flags).test(document.body.innerText) : document.body.innerText.includes(t)), pattern ? null : text, pattern);
  }

  /** A PNG of the window, base64. */
  screenshot() {
    return this.cmd("GET", "/screenshot");
  }
}

async function call(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) {
    throw new Error(`${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ""}`.trim());
  }
  return json.value;
}
