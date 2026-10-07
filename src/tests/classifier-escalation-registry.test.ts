import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EscalationRegistry } from "../classifier-escalation.js";

/**
 * Story 016, Task 4.1 (R1.5, R2.5, R4.1, R4.2, Q4). The registry orders the two
 * signals the CLI sends for one denial and guarantees exactly one final
 * `tool_call_update` per tool_use_id — never zero (a call left pending) and
 * never two (a failed update over an approval, or a double failure).
 *
 * ASSUMPTION (the design names the methods, not the constructor): the registry
 * is built with `{ sessionId, emit, logger }`, where `emit` sends one ACP
 * `tool_call_update`. `makeRegistry` is the only place that assumption lives.
 */
type Emitted = { toolCallId?: string; status?: string; text: string; raw: unknown };

function makeRegistry() {
  const emitted: Emitted[] = [];
  const emit = vi.fn(async (...args: any[]) => {
    const carrier = args.find((a) => a && typeof a === "object") ?? {};
    const update = (carrier as any).update ?? carrier;
    emitted.push({
      toolCallId: update.toolCallId ?? (typeof args[0] === "string" ? args[0] : undefined),
      status: update.status,
      text: JSON.stringify(update.content ?? ""),
      raw: update,
    });
  });
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const registry = new EscalationRegistry({ sessionId: "sess-1", emit, logger } as any);
  return { registry, emitted, emit };
}

const forId = (emitted: Emitted[], id: string) => emitted.filter((e) => e.toolCallId === id);
const CLASSIFIER_REASON = "Classifier: command downloads and executes remote code";

describe("EscalationRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe("awaitReasonType", () => {
    it("resolves with the reason type of a frame noted before the wait", async () => {
      const { registry } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      await expect(registry.awaitReasonType("t1")).resolves.toBe("classifier");
    });

    it("resolves when the frame arrives after the wait started", async () => {
      const { registry } = makeRegistry();
      const waiting = registry.awaitReasonType("t1");
      await vi.advanceTimersByTimeAsync(1000);
      registry.noteFrame({ toolUseId: "t1", reasonType: "rule", reason: "deny rule Bash(rm:*)" });
      await expect(waiting).resolves.toBe("rule");
    });

    // Hostile: a frame for one call must not answer the wait of another.
    it("is not satisfied by a frame for a different tool_use_id", async () => {
      const { registry } = makeRegistry();
      let settled: string | undefined | null = null;
      void registry.awaitReasonType("t1").then((v) => (settled = v));
      registry.noteFrame({ toolUseId: "t2", reasonType: "classifier", reason: CLASSIFIER_REASON });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).toBeUndefined();
    });

    it("resolves undefined after 5 s without a frame, and never rejects", async () => {
      const { registry } = makeRegistry();
      let settled: string | undefined | null = null;
      const waiting = registry.awaitReasonType("t1").then((v) => (settled = v));
      await vi.advanceTimersByTimeAsync(4900);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      await waiting;
      expect(settled).toBeUndefined();
    });
  });

  describe("isEscalated", () => {
    it("is true only between claim and resolve", async () => {
      const { registry } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      expect(registry.isEscalated("t1")).toBe(false);
      registry.claim("t1");
      expect(registry.isEscalated("t1")).toBe(true);
      expect(registry.isEscalated("t2")).toBe(false);
      registry.resolve("t1", "approved");
      expect(registry.isEscalated("t1")).toBe(false);
    });
  });

  describe("resolve", () => {
    it("approved emits a finished update saying the call was approved (R2.5)", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t1");
      registry.resolve("t1", "approved");
      await vi.advanceTimersByTimeAsync(0);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe("completed");
      expect(sent[0]!.text).toMatch(/approved/i);
    });

    it("rejected emits today's failed update with the classifier reason (R4.1)", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t1");
      registry.resolve("t1", "rejected");
      await vi.advanceTimersByTimeAsync(0);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe("failed");
      expect((sent[0]!.raw as any).content).toEqual([
        {
          type: "content",
          content: { type: "text", text: `Permission denied: ${CLASSIFIER_REASON}` },
        },
      ]);
    });

    it("cancelled emits a terminal update that does not claim approval (R4.2)", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t1");
      registry.resolve("t1", "cancelled");
      await vi.advanceTimersByTimeAsync(0);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(["failed", "cancelled"]).toContain(sent[0]!.status);
      expect(sent[0]!.text).not.toMatch(/approved/i);
    });

    // Hostile: a second outcome must not overwrite the first (e.g. a late
    // timeout flipping an approval to failed).
    it("is idempotent: the first outcome wins and is emitted once", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t1");
      registry.resolve("t1", "approved");
      registry.resolve("t1", "rejected");
      registry.resolve("t1", "approved");
      await vi.advanceTimersByTimeAsync(60_000);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe("completed");
    });

    it("settles one tool_use_id without touching another", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.noteFrame({ toolUseId: "t2", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t1");
      registry.claim("t2");
      registry.resolve("t1", "approved");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(forId(emitted, "t1")).toHaveLength(1);
      expect(forId(emitted, "t2")).toHaveLength(0);
      expect(registry.isEscalated("t2")).toBe(true);
    });
  });

  describe("frame-side fallback — no call is ever left pending (R1.5, Q4)", () => {
    it("emits today's failed update 5 s after a classifier frame no hook claimed", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      await vi.advanceTimersByTimeAsync(4900);
      expect(forId(emitted, "t1")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(200);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe("failed");
      expect(sent[0]!.text).toContain(`Permission denied: ${CLASSIFIER_REASON}`);
    });

    it("emits the failed update when the hook abandons a classifier frame", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.abandon("t1");
      await vi.advanceTimersByTimeAsync(5100);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe("failed");
    });

    it("emits the failed update for a classifier frame that arrives after the hook gave up", async () => {
      const { registry, emitted } = makeRegistry();
      // No frame yet: the hook's 5 s wait runs out, so it abandons.
      const waiting = registry.awaitReasonType("t1");
      await vi.advanceTimersByTimeAsync(5100);
      await waiting;
      registry.abandon("t1");
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      await vi.advanceTimersByTimeAsync(5100);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe("failed");
    });

    // Hostile: a claimed id belongs to the hook; the deadline must not fail a
    // call the operator is still looking at (or has approved).
    it("never fires for a claimed id, however long the operator takes", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t1");
      await vi.advanceTimersByTimeAsync(590_000);
      expect(forId(emitted, "t1")).toHaveLength(0);
      registry.resolve("t1", "approved");
      await vi.advanceTimersByTimeAsync(10_000);
      const sent = forId(emitted, "t1");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.status).toBe("completed");
    });

    it("does not emit a second failed update after the hook already resolved rejected", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t1");
      registry.resolve("t1", "rejected");
      registry.abandon("t1");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(forId(emitted, "t1")).toHaveLength(1);
    });

    // Hostile: the frame handler already sends today's update for every other
    // reason type; the registry emitting too would double it.
    it("never emits for a non-classifier frame", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "rule", reason: "deny rule" });
      registry.noteFrame({ toolUseId: "t2", reasonType: "mode", reason: "dontAsk" });
      registry.abandon("t1");
      registry.abandon("t2");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(emitted).toHaveLength(0);
    });

    it("falls back only for the id whose deadline passed", async () => {
      const { registry, emitted } = makeRegistry();
      registry.noteFrame({ toolUseId: "t1", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.noteFrame({ toolUseId: "t2", reasonType: "classifier", reason: CLASSIFIER_REASON });
      registry.claim("t2");
      await vi.advanceTimersByTimeAsync(5100);
      expect(forId(emitted, "t1")).toHaveLength(1);
      expect(forId(emitted, "t2")).toHaveLength(0);
    });
  });
});
