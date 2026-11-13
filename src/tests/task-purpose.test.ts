import { describe, expect, it } from "vitest";
import { taskPurpose } from "../task-purpose.js";

/**
 * Zeo next proposal §6.2 (ask 30): a background shell task carries a tag saying quickly
 * what it is — CI, Test, Build or Watch — read from its command by a small rule table.
 * The command itself never leaves the adapter (task-feed.ts never copies a command line);
 * only the tag does.
 */
describe("taskPurpose", () => {
  it.each([
    ["gh run watch 1234 --exit-status", "ci"],
    ["act -j build", "ci"],
    ["cargo test -p agent_ui", "test"],
    ["cargo nextest run", "test"],
    ["npm test", "test"],
    ["npm run test -- --watch=false", "test"],
    ["npx vitest run src/tests", "test"],
    ["pytest -q tests/", "test"],
    ["go test ./...", "test"],
    ["bats scripts/tests", "test"],
    ["cargo build --release", "build"],
    ["npm run build", "build"],
    ["make -j8", "build"],
    ["tsc -p .", "build"],
    ["emerge -1 app-editors/zeo", "build"],
    ["cargo watch -x check", "watch"],
    ["watchexec -e rs cargo check", "watch"],
    ["npm run dev -- --watch", "watch"],
  ])("%s → %s", (command, purpose) => {
    expect(taskPurpose(command)).toBe(purpose);
  });

  /** Hostile: a watch that runs tests is a watch, and CI wins over everything it runs. */
  it("ranks watch over test and build, and CI over all", () => {
    expect(taskPurpose("cargo watch -x test")).toBe("watch");
    expect(taskPurpose("watchexec -- cargo build")).toBe("watch");
    expect(taskPurpose("act -j test --watch")).toBe("ci");
  });

  /** Hostile: a word inside another must not match, and an unknown command has no tag. */
  it("matches whole words only, and tags nothing it does not know", () => {
    expect(taskPurpose("echo latest-artifact")).toBeNull();
    expect(taskPurpose("cat contest.txt")).toBeNull();
    expect(taskPurpose("ls -la")).toBeNull();
    expect(taskPurpose("")).toBeNull();
  });

  it("reads the command after env assignments, cd and a sudo", () => {
    expect(taskPurpose("RUST_LOG=debug cargo test")).toBe("test");
    expect(taskPurpose("cd crates/agent_ui && cargo test")).toBe("test");
    expect(taskPurpose("sudo emerge -1 dev-util/claude-agent-acp-plus")).toBe("build");
  });
});
