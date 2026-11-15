#!/usr/bin/env node
// Mirror new upstream commits onto this fork's `main`, dropping tool-generated
// attribution trailers (see DROP below) from their messages.
//
// This fork's history was rewritten to remove those trailers, so its commit ids
// no longer match upstream's. NEVER `git merge upstream/main`: that would bring
// every original commit back. Run this script instead.
//
// Usage (from any branch except main, with a clean working tree):
//   node scripts/sync-upstream.mjs            fetch and update local main
//   node scripts/sync-upstream.mjs --rebase   also rebase the current branch onto main
//   node scripts/sync-upstream.mjs --push     also push main (and the rebased branch)
//
// How it works: every commit keeps its tree, author, committer and dates, so a
// fork commit and its upstream original share the key below. Upstream commits
// whose key is not on main yet are recreated in topological order, with their
// parents mapped to the fork's ids, so merges and branch structure are kept.
import { execFileSync } from "node:child_process";

const flags = new Set(process.argv.slice(2));
const REBASE = flags.has("--rebase");
const PUSH = flags.has("--push");
const REMOTE = process.env.SYNC_UPSTREAM_REMOTE || "upstream";
const UPSTREAM = `${REMOTE}/main`;
const MAIN = "main";

const DROP = [
  /^co-authored-by:.*(@anthropic\.com|\bclaude\b)/i,
  /generated with \[?claude/i,
  /^claude-session:/i,
];
const LEFTOVER = /@anthropic\.com|claude-session:|generated with \[?claude/i;

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}
const line = (args) => git(args).trim();

function fail(message) {
  console.error(`sync-upstream: ${message}`);
  process.exit(1);
}

function stripAttribution(message) {
  const kept = message.split("\n").filter((l) => !DROP.some((re) => re.test(l.trim())));
  const cleaned = git(["stripspace"], { input: kept.join("\n") });
  if (LEFTOVER.test(cleaned)) fail(`attribution left in a message after filtering:\n${cleaned}`);
  return cleaned;
}

// One record per commit: id, parents, tree, author/committer identity and dates, subject.
const SEP = "\x1f";
function readCommits(rev) {
  const format = ["%H", "%P", "%T", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%s"].join(SEP);
  return git(["log", "--topo-order", "--reverse", `--format=${format}`, rev])
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [id, parents, tree, an, ae, ad, cn, ce, cd, subject] = row.split(SEP);
      return { id, parents: parents ? parents.split(" ") : [], tree, an, ae, ad, cn, ce, cd, subject };
    });
}
const keyOf = (c) => [c.tree, c.ae, c.ad, c.ce, c.cd, c.subject].join(SEP);

// --- preconditions --------------------------------------------------------
const current = line(["rev-parse", "--abbrev-ref", "HEAD"]);
if (current === MAIN) fail(`run this from your work branch, not ${MAIN} (it updates ${MAIN} without checking it out).`);
if (line(["status", "--porcelain"]) !== "") fail("working tree has uncommitted changes; commit or stash them first.");

console.log(`Fetching ${REMOTE}...`);
git(["fetch", "--quiet", REMOTE]);

const forkCommits = readCommits(MAIN);
const upstreamCommits = readCommits(UPSTREAM);

const forkByKey = new Map();
for (const c of forkCommits) {
  if (forkByKey.has(keyOf(c))) fail(`two commits on ${MAIN} share a key (${c.id}); refusing to guess.`);
  forkByKey.set(keyOf(c), c.id);
}
const upstreamKeys = new Set(upstreamCommits.map(keyOf));
const forkOnly = forkCommits.filter((c) => !upstreamKeys.has(keyOf(c)));
if (forkOnly.length) {
  fail(`${MAIN} has ${forkOnly.length} commit(s) that are not upstream's (first: ${forkOnly[0].id.slice(0, 7)} "${forkOnly[0].subject}").\n` +
    `Keep your own work on another branch so ${MAIN} stays a mirror.`);
}

// --- recreate new upstream commits -----------------------------------------
const mapped = new Map(); // upstream id -> fork id
const pending = [];
for (const c of upstreamCommits) {
  const existing = forkByKey.get(keyOf(c));
  if (existing) mapped.set(c.id, existing);
  else pending.push(c);
}

const upstreamTip = line(["rev-parse", UPSTREAM]);
const oldMain = line(["rev-parse", MAIN]);
if (pending.length === 0) {
  if (mapped.get(upstreamTip) !== oldMain) fail(`${MAIN} is not at the mirror of ${UPSTREAM}; inspect manually.`);
  console.log(`${MAIN} is already in sync with ${UPSTREAM} (${upstreamTip.slice(0, 7)}).`);
} else {
  console.log(`Mirroring ${pending.length} new upstream commit(s)...`);
  for (const c of pending) {
    const parents = c.parents.map((p) => mapped.get(p) || fail(`parent ${p.slice(0, 7)} of ${c.id.slice(0, 7)} is not mirrored.`));
    const message = stripAttribution(git(["log", "-1", "--format=%B", c.id]));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: c.an, GIT_AUTHOR_EMAIL: c.ae, GIT_AUTHOR_DATE: c.ad,
      GIT_COMMITTER_NAME: c.cn, GIT_COMMITTER_EMAIL: c.ce, GIT_COMMITTER_DATE: c.cd,
    };
    const parentArgs = parents.flatMap((p) => ["-p", p]);
    const id = git(["commit-tree", `${c.tree}`, ...parentArgs], { input: message, env }).trim();
    mapped.set(c.id, id);
    console.log(`  ${c.id.slice(0, 7)} -> ${id.slice(0, 7)}  ${c.subject}`);
  }

  const newMain = mapped.get(upstreamTip);
  if (line(["rev-parse", `${newMain}^{tree}`]) !== line(["rev-parse", `${UPSTREAM}^{tree}`])) fail("mirrored tip tree differs from upstream; aborting before touching main.");
  try {
    git(["merge-base", "--is-ancestor", oldMain, newMain]);
  } catch {
    fail(`new ${MAIN} would not contain the current one; aborting.`);
  }
  git(["update-ref", `refs/heads/${MAIN}`, newMain, oldMain]);
  console.log(`${MAIN}: ${oldMain.slice(0, 7)} -> ${newMain.slice(0, 7)}`);
}

// --- optional follow-ups ---------------------------------------------------
if (REBASE) {
  console.log(`Rebasing ${current} onto ${MAIN}...`);
  try {
    git(["rebase", MAIN], { stdio: "inherit" });
  } catch {
    fail(`rebase stopped on a conflict. Resolve it and run "git rebase --continue" (or "git rebase --abort").`);
  }
}
if (PUSH) {
  git(["push", "origin", MAIN], { stdio: "inherit" });
  if (REBASE) git(["push", "--force-with-lease", "origin", current], { stdio: "inherit" });
}
