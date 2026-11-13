/**
 * Zeo next proposal §6.2 (ask 30): what a shell task is for, read from its command by a small
 * rule table — CI, Test, Build or Watch — so a client can tag a background task at a glance.
 *
 * The command is read here and dropped: the feed publishes only the tag. task-feed.ts never
 * copies a command line onto the wire or into a log, because a command can carry a secret,
 * and this keeps that rule.
 *
 * Matching is on whole words of the command after the usual wrappers (env assignments, `cd …
 * &&`, `sudo`), so `latest-artifact` is not `test`. Order matters: a CI run beats what it
 * runs, and a watcher beats the test or build it repeats. Unknown commands get no tag.
 */

export type TaskPurpose = "ci" | "test" | "build" | "watch";

/** Words that make a command a CI run, wherever they appear as a command. */
const CI_RULES: RegExp[] = [/\bgh\s+run\s+watch\b/, /(^|[;&|]\s*)act(\s|$)/];

const WATCH_RULES: RegExp[] = [
  /\bcargo\s+watch\b/,
  /\bwatchexec\b/,
  /(^|\s)--watch(=true)?(\s|$)/,
  /\bnodemon\b/,
];

const TEST_RULES: RegExp[] = [
  /\bcargo\s+(test|nextest)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bbats\b/,
  /\bctest\b/,
];

const BUILD_RULES: RegExp[] = [
  /\bcargo\s+(build|b)\b/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/,
  /(^|[;&|]\s*)(make|ninja|meson|cmake)(\s|$)/,
  /(^|[;&|]\s*)tsc(\s|$)/,
  /(^|[;&|]\s*)(emerge|ebuild)(\s|$)/,
  /\bgo\s+build\b/,
  /\bdocker\s+build\b/,
];

/**
 * The command as a client would read it: everything after the last `cd …&&`, without leading
 * `VAR=value` assignments or a `sudo`. A `--watch=false` is not a watch.
 */
function commandOf(command: string): string {
  let text = command.trim();
  const afterCd = text.split(/&&/).map((part) => part.trim());
  const meaningful = afterCd.filter((part) => !/^cd(\s|$)/.test(part));
  text = meaningful.join(" && ");
  text = text.replace(/^(\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  text = text.replace(/^sudo\s+(-\S+\s+)*/, "");
  return text.replace(/--watch=false\b/g, "");
}

export function taskPurpose(command: string): TaskPurpose | null {
  const text = commandOf(command);
  if (text === "") return null;
  const any = (rules: RegExp[]) => rules.some((rule) => rule.test(text));
  if (any(CI_RULES)) return "ci";
  if (any(WATCH_RULES)) return "watch";
  if (any(TEST_RULES)) return "test";
  if (any(BUILD_RULES)) return "build";
  return null;
}
