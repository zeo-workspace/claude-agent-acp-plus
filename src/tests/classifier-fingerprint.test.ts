import { describe, expect, it } from "vitest";
import { fingerprint } from "../classifier-escalation.js";

/**
 * Story 016, Task 2.1 (R2.3, R3.1). A grant releases exactly the call the
 * operator saw. The fingerprint is the only thing that decides "same call", so
 * the hostile halves come first: inputs that look alike but denote different
 * calls must stay apart, and inputs shaped differently that denote the same call
 * must come together. Only then the benign identity case.
 */
describe("fingerprint — must NOT collapse different calls (hostile half 1)", () => {
  it("separates two different commands", () => {
    expect(fingerprint("Bash", { command: "rm -rf build" })).not.toBe(
      fingerprint("Bash", { command: "rm -rf build/" }),
    );
    expect(fingerprint("Bash", { command: "ls" })).not.toBe(
      fingerprint("Bash", { command: "ls " }),
    );
  });

  it("separates the same command under two tool names", () => {
    expect(fingerprint("Bash", { command: "Get-ChildItem" })).not.toBe(
      fingerprint("PowerShell", { command: "Get-ChildItem" }),
    );
  });

  it("separates calls that differ in any non-cosmetic Bash field", () => {
    const base = { command: "npm test", description: "run tests" };
    const fp = fingerprint("Bash", base);
    expect(fingerprint("Bash", { ...base, run_in_background: true })).not.toBe(fp);
    expect(fingerprint("Bash", { ...base, timeout: 600000 })).not.toBe(fp);
    expect(fingerprint("Bash", { ...base, dangerouslyDisableSandbox: true })).not.toBe(fp);
  });

  it("keeps `description` significant for every tool other than Bash", () => {
    // The exemption is Bash-only: for another tool `description` may be the payload.
    expect(fingerprint("Agent", { prompt: "x", description: "audit the repo" })).not.toBe(
      fingerprint("Agent", { prompt: "x", description: "delete the repo" }),
    );
    expect(fingerprint("PowerShell", { command: "ls", description: "a" })).not.toBe(
      fingerprint("PowerShell", { command: "ls", description: "b" }),
    );
  });

  it("drops only the top-level Bash `description`, never a nested one", () => {
    expect(fingerprint("Bash", { command: "x", env: { description: "a" } })).not.toBe(
      fingerprint("Bash", { command: "x", env: { description: "b" } }),
    );
  });

  it("treats a differently-cased `Description` key as a real field", () => {
    expect(fingerprint("Bash", { command: "x", Description: "a" })).not.toBe(
      fingerprint("Bash", { command: "x", Description: "b" }),
    );
  });

  it("keeps array order significant", () => {
    expect(fingerprint("Tool", { args: ["a", "b"] })).not.toBe(
      fingerprint("Tool", { args: ["b", "a"] }),
    );
  });

  it("keeps value types significant", () => {
    expect(fingerprint("Bash", { command: "x", timeout: 1 })).not.toBe(
      fingerprint("Bash", { command: "x", timeout: "1" }),
    );
    expect(fingerprint("Tool", { a: null })).not.toBe(fingerprint("Tool", {}));
  });

  // Derived-value hostile case: the fingerprint is a string the fix invents, so
  // ask whether a THIRD input can render to the same string by another route.
  it("cannot be forged by a field value that spells another field", () => {
    const twoFields = fingerprint("Bash", { command: "ls", cwd: "/tmp" });
    expect(fingerprint("Bash", { command: 'ls","cwd":"/tmp' })).not.toBe(twoFields);
    expect(fingerprint("Bash", { command: "ls,cwd=/tmp" })).not.toBe(twoFields);
    expect(fingerprint("Bash", { command: "ls cwd /tmp" })).not.toBe(twoFields);
  });

  it("cannot be forged by moving text between the tool name and the input", () => {
    expect(fingerprint("Bash", { command: "x" })).not.toBe(
      fingerprint('Bash","input', { command: "x" }),
    );
    expect(fingerprint("A", "B:C")).not.toBe(fingerprint("A:B", "C"));
  });

  it("separates non-object inputs by value", () => {
    expect(fingerprint("Tool", "abc")).not.toBe(fingerprint("Tool", "abd"));
    expect(fingerprint("Tool", "1")).not.toBe(fingerprint("Tool", 1));
  });
});

describe("fingerprint — must NOT split one call (hostile half 2)", () => {
  it("matches one Bash command carrying two different descriptions", () => {
    expect(fingerprint("Bash", { command: "npm test", description: "Run the tests" })).toBe(
      fingerprint("Bash", { command: "npm test", description: "Re-run tests after approval" }),
    );
  });

  it("matches a Bash command with and without a description", () => {
    expect(fingerprint("Bash", { command: "npm test", description: "Run" })).toBe(
      fingerprint("Bash", { command: "npm test" }),
    );
  });

  it("ignores top-level key order", () => {
    expect(fingerprint("Bash", { command: "x", timeout: 5, run_in_background: false })).toBe(
      fingerprint("Bash", { run_in_background: false, timeout: 5, command: "x" }),
    );
  });

  it("ignores nested key order", () => {
    expect(fingerprint("Tool", { outer: { b: 1, a: { d: 2, c: 3 } } })).toBe(
      fingerprint("Tool", { outer: { a: { c: 3, d: 2 }, b: 1 } }),
    );
  });
});

describe("fingerprint — benign identity", () => {
  it("returns the same string for the same call", () => {
    const fp = fingerprint("Bash", { command: "git status" });
    expect(typeof fp).toBe("string");
    expect(fingerprint("Bash", { command: "git status" })).toBe(fp);
  });

  it("does not mutate the input it fingerprints", () => {
    const input = { description: "label", command: "x" };
    fingerprint("Bash", input);
    expect(input).toEqual({ description: "label", command: "x" });
  });

  it("returns undefined, without throwing, for a cyclic input", () => {
    const cyclic: Record<string, unknown> = { command: "x" };
    cyclic.self = cyclic;
    expect(() => fingerprint("Bash", cyclic)).not.toThrow();
    expect(fingerprint("Bash", cyclic)).toBeUndefined();
  });
});
