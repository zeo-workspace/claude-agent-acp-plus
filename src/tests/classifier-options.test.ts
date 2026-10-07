import { beforeEach, describe, expect, it } from "vitest";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  PERMISSION_OPTION_ID,
  buildClassifierEscalationOptions,
} from "../permissions/options/shared.js";
import { decodeClassifierEscalationResponse } from "../permissions/response.js";

/**
 * Story 016, Task 3.1 (R1.1, R5.1). The three answers to a classifier denial,
 * and the decoder that maps the client's choice to "once" | "session" |
 * "reject" | "cancelled". No answer may write a rule: no `allow_always` kind,
 * and no option id shared with a path that produces `PermissionUpdate`s.
 */
const selected = (optionId: string): RequestPermissionResponse => ({
  outcome: { outcome: "selected", optionId },
});

function byName(name: string) {
  const option = buildClassifierEscalationOptions().find((o) => o.name === name);
  if (!option) throw new Error(`no option named ${name}`);
  return option;
}

describe("buildClassifierEscalationOptions", () => {
  it("offers exactly Yes, Yes for this session and No (R1.1)", () => {
    expect(buildClassifierEscalationOptions().map((o) => o.name)).toEqual([
      "Yes",
      "Yes for this session",
      "No",
    ]);
  });

  it("offers no persistent choice (R5.1)", () => {
    const options = buildClassifierEscalationOptions();
    expect(options.map((o) => o.kind)).not.toContain("allow_always");
    expect(byName("Yes").kind).toBe("allow_once");
    expect(byName("Yes for this session").kind).toBe("allow_once");
    expect(byName("No").kind).toBe("reject_once");
  });

  // Hostile half: if either "Yes" reused an existing id, the canUseTool decoder
  // (and any client that remembers ids) would treat it as that other choice.
  it("gives each Yes its own id, distinct from each other and from every existing id", () => {
    const once = byName("Yes").optionId;
    const session = byName("Yes for this session").optionId;
    expect(once).not.toBe(session);
    const preexisting = [
      "allow-once",
      "allow-with-updates",
      "allow-skill-exact",
      "allow-skill-prefix",
      "exit-plan-bypass",
      "exit-plan-auto",
      "exit-plan-accept-edits",
      "exit-plan-default",
      "exit-plan-clear-auto",
      "exit-plan-clear-bypass",
      "exit-plan-clear-accept-edits",
      "reject",
    ];
    expect(preexisting).not.toContain(once);
    expect(preexisting).not.toContain(session);
  });

  it("registers both new ids in PERMISSION_OPTION_ID and reuses `reject` for No", () => {
    const ids = Object.values(PERMISSION_OPTION_ID) as string[];
    expect(ids).toContain(byName("Yes").optionId);
    expect(ids).toContain(byName("Yes for this session").optionId);
    expect(byName("No").optionId).toBe(PERMISSION_OPTION_ID.reject);
  });

  it("returns fresh objects, so a caller cannot mutate the next request's options", () => {
    const first = buildClassifierEscalationOptions();
    first[0]!.name = "mutated";
    expect(buildClassifierEscalationOptions()[0]!.name).toBe("Yes");
  });
});

describe("decodeClassifierEscalationResponse", () => {
  // Guard: without it the toThrow cases below pass on "is not a function".
  beforeEach(() => {
    expect(decodeClassifierEscalationResponse).toBeTypeOf("function");
  });

  // Hostile half first: an id this request never offered must not be read as an approval.
  it("throws on the plain allow-once id, which this request never offers", () => {
    expect(() =>
      decodeClassifierEscalationResponse(selected(PERMISSION_OPTION_ID.allowOnce)),
    ).toThrow();
  });

  it("throws on the persistent allow-with-updates id (R5.1)", () => {
    expect(() =>
      decodeClassifierEscalationResponse(selected(PERMISSION_OPTION_ID.allowWithUpdates)),
    ).toThrow();
  });

  it("throws on an unknown id", () => {
    expect(() => decodeClassifierEscalationResponse(selected("not-an-option"))).toThrow();
  });

  it("does not confuse the two Yes answers", () => {
    expect(decodeClassifierEscalationResponse(selected(byName("Yes").optionId))).toBe("once");
    expect(
      decodeClassifierEscalationResponse(selected(byName("Yes for this session").optionId)),
    ).toBe("session");
  });

  it("maps No to reject", () => {
    expect(decodeClassifierEscalationResponse(selected(byName("No").optionId))).toBe("reject");
  });

  it("maps an ACP cancelled outcome to cancelled", () => {
    expect(decodeClassifierEscalationResponse({ outcome: { outcome: "cancelled" } })).toBe(
      "cancelled",
    );
  });
});
