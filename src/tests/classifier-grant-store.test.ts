import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Story 016, Task 2.2 (R2.1, R2.2, R2.4, R3.1, R3.3, R3.4). Grants are memory
 * only: every write primitive of `node:fs` and `node:fs/promises` is spied so a
 * store that persists anything fails here.
 */
const writes = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const spy =
    <T extends (...args: any[]) => any>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      writes.calls.push(name);
      return fn(...args);
    };
  return {
    ...actual,
    default: actual,
    writeFileSync: spy("writeFileSync", actual.writeFileSync),
    appendFileSync: spy("appendFileSync", actual.appendFileSync),
    writeFile: spy("writeFile", actual.writeFile),
    appendFile: spy("appendFile", actual.appendFile),
    renameSync: spy("renameSync", actual.renameSync),
  };
});
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const spy =
    <T extends (...args: any[]) => any>(name: string, fn: T) =>
    (...args: Parameters<T>) => {
      writes.calls.push(name);
      return fn(...args);
    };
  return {
    ...actual,
    default: actual,
    writeFile: spy("writeFile", actual.writeFile),
    appendFile: spy("appendFile", actual.appendFile),
    rename: spy("rename", actual.rename),
  };
});

const { GrantStore, fingerprint } = await import("../classifier-escalation.js");

const fp = (command: string, description?: string) =>
  fingerprint("Bash", description === undefined ? { command } : { command, description })!;

describe("GrantStore", () => {
  beforeEach(() => {
    writes.calls = [];
  });

  // Hostile half first: a grant must never answer for a different call.
  it("does not let a grant for one call match another call", () => {
    const store = new GrantStore();
    store.grantSession(fp("npm test"));
    store.grantOnce(fp("npm run build"));
    expect(store.consume(fp("npm test -- --watch"))).toBeUndefined();
    expect(store.consume(fingerprint("PowerShell", { command: "npm test" })!)).toBeUndefined();
    // The misses consumed nothing.
    expect(store.consume(fp("npm test"))).toBe("session");
    expect(store.consume(fp("npm run build"))).toBe("once");
  });

  it("scopes grants to one store: a grant in one session has no effect on another (R3.3)", () => {
    const sessionA = new GrantStore();
    const sessionB = new GrantStore();
    sessionA.grantSession(fp("make deploy"));
    sessionA.grantOnce(fp("make clean"));
    expect(sessionB.consume(fp("make deploy"))).toBeUndefined();
    expect(sessionB.consume(fp("make clean"))).toBeUndefined();
    expect(sessionA.consume(fp("make deploy"))).toBe("session");
  });

  it("matches the retry of a once grant even when the model rewrote its description", () => {
    const store = new GrantStore();
    store.grantOnce(fp("npm test", "Run tests"));
    expect(store.consume(fp("npm test", "Retry the tests"))).toBe("once");
  });

  it("lets a once grant through exactly one time (R2.1, R2.2)", () => {
    const store = new GrantStore();
    store.grantOnce(fp("npm test"));
    expect(store.consume(fp("npm test"))).toBe("once");
    expect(store.consume(fp("npm test"))).toBeUndefined();
  });

  it("keeps a session grant across every later match (R3.1)", () => {
    const store = new GrantStore();
    store.grantSession(fp("npm test"));
    expect(store.consume(fp("npm test"))).toBe("session");
    expect(store.consume(fp("npm test"))).toBe("session");
    expect(store.consume(fp("npm test"))).toBe("session");
  });

  it("returns undefined for an empty store", () => {
    expect(new GrantStore().consume(fp("anything"))).toBeUndefined();
  });

  it("clearOnce drops unused once grants and keeps session grants (R2.4)", () => {
    const store = new GrantStore();
    store.grantOnce(fp("a"));
    store.grantSession(fp("b"));
    store.clearOnce();
    expect(store.consume(fp("a"))).toBeUndefined();
    expect(store.consume(fp("b"))).toBe("session");
  });

  it("clear drops every grant (R3.2)", () => {
    const store = new GrantStore();
    store.grantOnce(fp("a"));
    store.grantSession(fp("b"));
    store.clear();
    expect(store.consume(fp("a"))).toBeUndefined();
    expect(store.consume(fp("b"))).toBeUndefined();
  });

  it("writes nothing to disk while granting, consuming and clearing (R3.4)", () => {
    const store = new GrantStore();
    store.grantOnce(fp("a"));
    store.grantSession(fp("b"));
    store.consume(fp("a"));
    store.consume(fp("b"));
    store.clearOnce();
    store.clear();
    expect(writes.calls).toEqual([]);
  });
});
