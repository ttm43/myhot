import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let instance = 0;
async function reader() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } },
  });
  // Reopening the page starts with an empty snapshot cache.
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return { state, values };
}

test("a cached tab merges newer saved read marks before writing", async () => {
  const { state, values } = await reader();
  state.getReadIds();
  values.set(state.KEYS.read, JSON.stringify(["other-tab"]));
  state.markRead("new");
  assert.deepEqual(state.getReadIds(), ["new", "other-tab"]);
});
