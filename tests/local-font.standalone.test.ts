// Failure modes: startup overwrites the saved choice, malformed/unavailable storage breaks the
// document, or denied writes prevent even an in-tab choice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { APPEARANCE_BOOT_SCRIPT, getFontPreference, KEYS, setFontPreference } from "../apps/web/app/lib/local-state.ts";

class MemoryStorage {
  values = new Map<string, string>();
  denied = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.denied) throw new Error("full"); this.values.set(key, value); }
  removeItem(key: string) { if (this.denied) throw new Error("full"); this.values.delete(key); }
}
const store = new MemoryStorage();
Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: store, sessionStorage: new MemoryStorage() } });

test("appearance startup applies a saved browser font before rendering and safely handles invalid storage", () => {
  for (const font of ["browser", "bad", null, "denied"]) {
    const attributes: Record<string, string> = {};
    runInNewContext(APPEARANCE_BOOT_SCRIPT, {
      localStorage: { getItem: (key: string) => { if (font === "denied") throw new Error("blocked"); return key === KEYS.font ? font : "dark"; } },
      window: { matchMedia: () => ({ matches: false }) },
      document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } }, querySelectorAll: () => [] },
    });
    assert.equal(attributes["data-font"], font === "browser" ? "browser" : "system");
    assert.equal(attributes["data-theme"], font === "denied" ? "light" : "dark");
  }
});

test("font choices survive denied writes", () => {
  setFontPreference("browser");
  assert.equal(getFontPreference(), "browser");
  setFontPreference(null);
  store.denied = true;
  setFontPreference("browser");
  assert.equal(getFontPreference(), "browser", "a choice still works in this tab when persistence is blocked");
  setFontPreference(null);
  assert.equal(getFontPreference(), null);
  store.denied = false;
});
