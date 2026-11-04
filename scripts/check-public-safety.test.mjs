/**
 * Self-test for scripts/check-public-safety.mjs: proves each rule fires on a
 * planted (synthetic) violation and stays quiet on allowed forms, so the CI
 * gate cannot silently pass because a rule regressed.
 * Run: node --test scripts/check-public-safety.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE = resolve(import.meta.dirname, "check-public-safety.mjs");

function repoWith(files) {
  // Values may be strings or Buffers.
  const dir = mkdtempSync(join(tmpdir(), "public-safety-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function runGate(dir, ...args) {
  return runGateEnv(dir, {}, ...args);
}

/** Runs the gate with CI markers removed from the environment, plus `env`. */
function runGateEnv(dir, env, ...args) {
  const { CI: _ci, GITHUB_ACTIONS: _gha, ...rest } = process.env;
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, encoding: "utf8", env: { ...rest, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// Violations are assembled at runtime so this file itself passes the gate.
const host = ["svc-prod", "up", "railway", "app"].join(".");
const uuid = ["0f0e0d0c", "0b0a", "4999", "8888", "777766665555"].join("-");
const publicIp = [9, 9, 9, 9].join(".");
const email = ["someone", "realcompany.co.uk"].join("@");
const keyBlock = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");

test("clean tree with allowed forms passes", () => {
  const dir = repoWith({
    "a.md": [
      "Deploy to <service>.up.railway.app and connect to postgres.railway.internal.",
      "Use 192.0.2.10, 198.51.100.7, 203.0.113.5, 10.0.0.1 and 127.0.0.1 in tests.",
      "Contact security@example.com or user@db.invalid.",
    ].join("\n"),
    ".env.example": "TOKEN=replace-me\n",
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, content, ruleId] of [
  ["railway public host", `url = https://${host}/v1`, "railway-public-host"],
  ["uuid", `project = ${uuid}`, "uuid-literal"],
  ["public ipv4", `ip = ${publicIp}`, "public-ipv4"],
  ["e-mail", `owner = ${email}`, "email"],
  ["private key", keyBlock, "private-key-block"],
]) {
  test(`detects ${name}`, () => {
    const dir = repoWith({ "x.ts": `${content}\n` });
    try {
      const r = runGate(dir);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(ruleId));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("detects committed env and key files", () => {
  const dir = repoWith({ ".env": "X=1\n", "apps/a/.env.production": "X=1\n", "certs/server.pem": "x\n" });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\.env: env file/);
    assert.match(r.out, /\.env\.production: env file/);
    assert.match(r.out, /server\.pem: key material file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthetic marker opts out only uuid/ipv4 and is reported", () => {
  const dir = repoWith({
    "y.ts": `const ip = "${publicIp}"; // public-safety: allow-synthetic — parser test\nconst h = "https://${host}"; // public-safety: allow-synthetic\n`,
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 1, r.out); // the host rule cannot be opted out
    assert.match(r.out, /opt-out/);
    assert.match(r.out, /railway-public-host/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Rules added after the independent review (CHR-66, F8) -----------------

const publicV6 = ["2606", "4700", "4700", "0", "0", "0", "0", "1111"].join(":");
const utf16le = (text, withBom = true) => Buffer.concat([withBom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, "utf16le")]);
const utf16be = (text, withBom = true) => {
  const le = Buffer.from(text, "utf16le");
  le.swap16();
  return Buffer.concat([withBom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), le]);
};

function expectFinding(files, ruleId, ...args) {
  const dir = repoWith(files);
  try {
    const r = runGate(dir, ...args);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(ruleId));
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("detects a public IPv6 literal", () => {
  expectFinding({ "v6.ts": `addr = "${publicV6}"\n` }, "public-ipv6");
  expectFinding({ "v6.md": `see [${publicV6}]:443.\n` }, "public-ipv6");
});

test("IPv6 rule stays quiet on allowed forms, times and code", () => {
  const dir = repoWith({
    "ok.md": [
      "loopback ::1 unspecified :: link-local fe80::1 ula fc00::1 and fd12:3456::1",
      "documentation 2001:db8::1 and 2001:db8:abcd:12::7, protocol block 2001:2::1",
      "mapped private ::ffff:10.0.0.1 and ::ffff:192.168.1.1",
      "time 12:30:45 and 2026-11-03T12:30:45Z and ratio 3:4 and mac 00:1a:2b:3c:4d:5e",
      "code std::string, Foo::bar, a::b, crate::module::item, KEY:value",
      "short hex run: deadbeef:cafe and 1:2:3",
    ].join("\n") + "\n",
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detects a mapped public IPv4 in IPv6 form and honours the synthetic marker", () => {
  expectFinding({ "m.ts": `x = ::ffff:${publicIp}\n` }, "public-ipv6");
  const dir = repoWith({ "n.ts": `x = "${publicV6}" // public-safety: allow-synthetic parser input\n` });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /opt-out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [name, content] of [
  ["UTF-16 LE with BOM", utf16le(`ip = ${publicIp}\n`)],
  ["UTF-16 BE with BOM", utf16be(`ip = ${publicIp}\n`)],
  ["UTF-16 LE without BOM", utf16le(`ip = ${publicIp}\n`, false)],
  ["UTF-16 BE without BOM", utf16be(`ip = ${publicIp}\n`, false)],
  ["UTF-8 with BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`ip = ${publicIp}\n`)])],
  ["UTF-8 text containing NUL bytes", Buffer.from(`a\0b\nip = ${publicIp}\0\n`)],
]) {
  test(`decodes and scans ${name}`, () => {
    expectFinding({ "enc.txt": content }, "public-ipv4");
  });
}

test("a real binary file is skipped but reported, never silently", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0xff, 0xfe, 0x80, 0x81]);
  const dir = repoWith({ "img/logo.png": png, "a.md": "clean\n" });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /binary file\(s\) NOT scanned/);
    assert.match(r.out, /img\/logo\.png/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a text file over the size limit fails instead of being skipped", () => {
  const big = `ip = ${publicIp}\n` + "x".repeat(2 * 1024 * 1024 + 10) + "\n";
  const r = expectFinding({ "docs/huge.txt": big }, "large-text-file");
  assert.match(r.out, /docs\/huge\.txt/);
});

test("only the root package-lock.json and the probe lockfile are skipped, not nested lockfiles", () => {
  const dir = repoWith({
    "package-lock.json": `{"x":"${publicIp}"}\n` + "y".repeat(2 * 1024 * 1024 + 10),
    "packages/tanstack/verification/cf-lifecycle/package-lock.json": `{"x":"${publicIp}"}\n`,
  });
  try {
    assert.equal(runGate(dir).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const r = expectFinding({ "some/other/package-lock.json": `{"x":"${publicIp}"}\n` }, "public-ipv4");
  assert.match(r.out, /some\/other\/package-lock\.json/);
  expectFinding({ "evil/packages/tanstack/verification/cf-lifecycle/package-lock.json": `{"x":"${publicIp}"}\n` }, "public-ipv4");
});

// ---- --history mode ----------------------------------------------------------

function git(dir, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
}

/** A repo whose first commit adds `content` at `path` and whose second commit removes it. */
function historyRepo(path, content) {
  const dir = mkdtempSync(join(tmpdir(), "public-safety-hist-"));
  git(dir, "init", "-q");
  mkdirSync(resolve(join(dir, path), ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "add");
  const sha = git(dir, "rev-parse", "HEAD").trim();
  rmSync(join(dir, path));
  writeFileSync(join(dir, "other.md"), "clean\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "remove");
  return { dir, sha };
}

test("--history finds a value that was added and later removed; the working tree is clean", () => {
  const { dir } = historyRepo("old.ts", `ip = "${publicIp}"\nv6 = "${publicV6}"\n`);
  try {
    assert.equal(runGate(dir).code, 0);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /old\.ts/);
    assert.match(r.out, /public-ipv4/);
    assert.match(r.out, /public-ipv6/);
    assert.doesNotMatch(r.out, /allow-list fingerprint/);
    assert.match(r.out, /run `node scripts\/check-public-safety\.mjs --history --fingerprints` locally/);
    assert.match(runGate(dir, "--history", "--fingerprints").out, /allow-list fingerprint: [0-9a-f]{40}:old\.ts:public-ipv4:[0-9a-f]{64}\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--history sees an added UTF-16 file, a deleted .env, and ignores removed lines", () => {
  const { dir } = historyRepo("wide.txt", utf16le(`ip = ${publicIp}\n`));
  try {
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /wide\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const env = historyRepo(".env", "X=1\n");
  try {
    const r = runGate(env.dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /forbidden-file/);
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
  // A removed line is not an added line: only the commit that adds a value is reported.
  const dir2 = mkdtempSync(join(tmpdir(), "public-safety-hist-"));
  try {
    git(dir2, "init", "-q");
    writeFileSync(join(dir2, "a.ts"), "x = 1\n");
    git(dir2, "add", "-A");
    git(dir2, "commit", "-q", "-m", "one");
    writeFileSync(join(dir2, "a.ts"), "x = 2\n");
    git(dir2, "commit", "-q", "-am", "two");
    assert.equal(runGate(dir2, "--history").code, 0);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

// ---- history allow-list: hashed entries, scanned, refusals (CHR-66 N4) ------

const sha256 = (v) => createHash("sha256").update(v, "utf8").digest("hex");
/** The redacted form the gate prints for a value by default. */
const red = (v) => `[redacted: ${v.length} chars]`;
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALLOW = ".public-safety-history-allow";
const otherIp = [9, 9, 9, 8].join(".");

test("--history honours exact commit:path:rule:sha256 fingerprints and nothing broader", () => {
  const { dir, sha } = historyRepo("old.ts", `ip = "${publicIp}"\n`);
  try {
    const allow = join(dir, ALLOW);
    // Wrong path, wrong hash, wrong rule: valid entries that match nothing, so the hit stays a finding.
    writeFileSync(allow, ["# reviewed: synthetic", `${sha}:other.ts:public-ipv4:${sha256(publicIp)}`, `${sha}:old.ts:public-ipv4:${sha256(otherIp)}`, `${sha}:old.ts:uuid-literal:${sha256(publicIp)}`].join("\n") + "\n");
    let r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /old\.ts: public-ipv4/);
    assert.match(r.out, /3 unused entr/);
    // A short sha is malformed (full commit ids only).
    writeFileSync(allow, `# reviewed: synthetic\n${sha.slice(0, 12)}:old.ts:public-ipv4:${sha256(publicIp)}\n`);
    r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /malformed entry/);
    writeFileSync(allow, `# reviewed: synthetic\n${sha}:old.ts:public-ipv4:${sha256(publicIp)}\n`);
    r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /unused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fingerprint (local --fingerprints only) holds the hash, not the value, after the remediation", () => {
  const { dir, sha } = historyRepo("old.ts", `ip = "${publicIp}"\n`);
  try {
    const r = runGate(dir, "--history", "--fingerprints");
    assert.equal(r.code, 1, r.out);
    const fpLine = r.out.split("\n").find((l) => l.includes("allow-list fingerprint:"));
    assert.equal(fpLine.trim(), `allow-list fingerprint: ${sha}:old.ts:public-ipv4:${sha256(publicIp)}`);
    assert.ok(!fpLine.includes(publicIp));
    assert.ok(!r.out.includes(publicIp));
    assert.match(r.out, /if the value is real, rewrite history to remove it and rotate or revoke it; only a SYNTHETIC value may be allow-listed/);
    assert.doesNotMatch(r.out, /allow-list entries are not printed here/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hashed entry waives exactly one hit", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-safety-hist-"));
  try {
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.ts"), `x = "${publicIp}"\ny = "${otherIp}"\n`);
    writeFileSync(join(dir, "b.ts"), `x = "${publicIp}"\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add");
    const sha = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "rm", "-q", "a.ts", "b.ts");
    git(dir, "commit", "-q", "-m", "remove");
    writeFileSync(join(dir, ALLOW), `# reviewed: synthetic parser input\n${sha}:a.ts:public-ipv4:${sha256(publicIp)}\n`);
    // --show-values (local) tells the two 7-character values apart.
    const r = runGate(dir, "--history", "--show-values");
    assert.equal(r.code, 1, r.out);
    const findings = r.out.split("\n").filter((l) => / public-ipv4: public IPv4 literal/.test(l));
    assert.deepEqual(findings.map((l) => l.trim().replace(/^[0-9a-f]{12}:/, "")).sort(), [
      `a.ts: public-ipv4: public IPv4 literal (use RFC 5737 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24): ${otherIp}`,
      `b.ts: public-ipv4: public IPv4 literal (use RFC 5737 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24): ${publicIp}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [rule, path, content, value] of [
  ["forbidden-file", ".env", "X=1\n", ".env"],
  ["private-key-block", "k.txt", `${keyBlock}\n`, keyBlock],
  ["email", "e.txt", `owner ${email}\n`, email],
  ["railway-public-host", "h.txt", `url ${host}\n`, host],
  ["railway-private-host", "p.txt", `db ${["api-prod", "railway", "internal"].join(".")}\n`, ["api-prod", "railway", "internal"].join(".")],
  ["supabase-project-host", "s.txt", `url https://${[["qwertyuiop", "asdfghjklz"].join(""), "supabase", "co"].join(".")}\n`, [["qwertyuiop", "asdfghjklz"].join(""), "supabase", "co"].join(".")],
  ["supabase-pooler-host", "q.txt", `db ${["aws-0-eu-west-2", "pooler", "supabase", "com"].join(".")}\n`, ["aws-0-eu-west-2", "pooler", "supabase", "com"].join(".")],
  ["supabase-api-key", "t.txt", `key ${["sb", "secret", "k".repeat(30)].join("_")}\n`, ["sb", "secret", "k".repeat(30)].join("_")],
]) {
  test(`refuses an allow entry for ${rule} (hard error, no fingerprint offered)`, () => {
    const { dir, sha } = historyRepo(path, content);
    try {
      let r = runGate(dir, "--history");
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`${rule}: .*\\n\\s+cannot be allow-listed: rewrite history to remove it, and rotate or revoke what it exposed`));
      assert.doesNotMatch(r.out, /allow-list fingerprint/);
      writeFileSync(join(dir, ALLOW), `# reviewed: it is fine, trust me\n${sha}:${path}:${rule}:${sha256(value)}\n`);
      for (const mode of [["--history"], []]) {
        r = runGate(dir, ...mode);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, new RegExp(`${ALLOW.replace(".", "\\.")}:2: rule ${rule} cannot be allow-listed`));
        assert.match(r.out, /hard error/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the reviewer's case: a committed-then-removed .env with a key block cannot be waived", () => {
  const { dir, sha } = historyRepo(".env", `${keyBlock}\nX=1\n`);
  try {
    writeFileSync(join(dir, ALLOW), [`# reviewed`, `${sha}:.env:forbidden-file:${sha256(".env")}`, `${sha}:.env:private-key-block:${sha256(keyBlock)}`].join("\n") + "\n");
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\.env: forbidden-file/);
    assert.match(r.out, /\.env: private-key-block/);
    assert.match(r.out, /2 refused entr/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the allow-list file is scanned: a raw value in it, even in a comment, is a finding in both modes", () => {
  // The reviewer's case: a comment quoting a public IPv4, a non-example e-mail and a concrete Railway host.
  const comment = `# reviewed: prod db at ${publicIp}, owner ${email}, host ${host}\n`;
  const dir = repoWith({ [ALLOW]: comment, "a.md": "clean\n" });
  try {
    let r = runGate(dir);
    assert.equal(r.code, 1, r.out);
    for (const rule of ["public-ipv4", "email", "railway-public-host"]) assert.match(r.out, new RegExp(`${ALLOW.replace(".", "\\.")}:1: ${rule}`));
    git(dir, "commit", "-q", "-m", "allow file");
    r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    for (const rule of ["public-ipv4", "email", "railway-public-host"]) assert.match(r.out, new RegExp(`${ALLOW.replace(".", "\\.")}: ${rule}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // An entry in the old raw-value format is refused as malformed (and its value is a finding).
  const { dir: d2, sha } = historyRepo("old.ts", `ip = "${publicIp}"\n`);
  try {
    writeFileSync(join(d2, ALLOW), `# reviewed: synthetic\n${sha}:old.ts:public-ipv4:${publicIp}\n`);
    const r = runGate(d2, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /:2: malformed entry/);
    assert.match(runGate(d2).out, /\.public-safety-history-allow:2: public-ipv4/);
  } finally {
    rmSync(d2, { recursive: true, force: true });
  }
});

test("an entry without a justification directly above it (or its block) is refused", () => {
  const { dir, sha } = historyRepo("old.ts", `ip = "${publicIp}"\n`);
  const entry = `${sha}:old.ts:public-ipv4:${sha256(publicIp)}`;
  try {
    for (const text of [
      `${entry}\n`, // no comment
      `# reviewed: synthetic\n\n${entry}\n`, // a blank line in between
      `#\n${entry}\n`, // empty comment
      `#   \n${entry}\n`, // whitespace only
      `# ----\n${entry}\n`, // no words
    ]) {
      writeFileSync(join(dir, ALLOW), text);
      const r = runGate(dir, "--history");
      assert.equal(r.code, 1, `${JSON.stringify(text)}\n${r.out}`);
      assert.match(r.out, /no justification/);
    }
    // Accepted: a comment block (even if its last line is empty) directly above a block of entries.
    writeFileSync(join(dir, ALLOW), `# reviewed: synthetic parser inputs\n#\n${entry}\n${sha}:old.ts:public-ipv4:${sha256(otherIp)}\n`);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 unused entr/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry for an unknown rule is refused", () => {
  const { dir, sha } = historyRepo("old.ts", "x = 1\n");
  try {
    writeFileSync(join(dir, ALLOW), `# reviewed\n${sha}:old.ts:public-ip:${sha256(publicIp)}\n`);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /unknown rule "public-ip"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--history refuses a shallow clone", () => {
  const { dir } = historyRepo("old.ts", "x = 1\n");
  const clone = mkdtempSync(join(tmpdir(), "public-safety-shallow-"));
  try {
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${dir}`, join(clone, "c")]);
    const r = runGate(join(clone, "c"), "--history");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /shallow/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

// ---- history blind spots: merges, "++ " lines, messages, identities, tags (CHR-66 N5)

/** Runs git in `dir` with a fixed, example.com identity unless `env` overrides it. */
function gitEnv(dir, env, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", ...env },
  });
}

function emptyRepo() {
  const dir = mkdtempSync(join(tmpdir(), "public-safety-n5-"));
  gitEnv(dir, {}, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "clean\n");
  gitEnv(dir, {}, "add", "-A");
  gitEnv(dir, {}, "commit", "-q", "-m", "init");
  return dir;
}

function withRepo(fn) {
  const dir = emptyRepo();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--history scans commit messages: a public IPv4 (and a host, a UUID) in a message is caught", () => {
  withRepo((dir) => {
    gitEnv(dir, {}, "commit", "-q", "--allow-empty", "-m", `deploy to ${publicIp}`, "-m", `via ${host}, project ${uuid}`);
    const sha = gitEnv(dir, {}, "rev-parse", "HEAD").trim();
    assert.equal(runGate(dir).code, 0);
    const r = runGate(dir, "--history", "--fingerprints");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`${sha.slice(0, 12)}:<commit message>: public-ipv4: .*${esc(red(publicIp))}`));
    assert.match(r.out, /<commit message>: railway-public-host/);
    assert.match(r.out, /<commit message>: uuid-literal/);
    assert.match(r.out, new RegExp(`allow-list fingerprint: ${sha}:<commit message>:public-ipv4:${sha256(publicIp)}`));
  });
  // A synthetic value in a message can be allow-listed with its pseudo-path fingerprint.
  withRepo((dir) => {
    gitEnv(dir, {}, "commit", "-q", "--allow-empty", "-m", `parser test input ${publicIp}`);
    const sha = gitEnv(dir, {}, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, ALLOW), `# reviewed: synthetic parser input quoted in a commit message\n${sha}:<commit message>:public-ipv4:${sha256(publicIp)}\n`);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
  });
});

test("--history: a value introduced only in a merge resolution, then removed, is caught", () => {
  withRepo((dir) => {
    gitEnv(dir, {}, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "side.txt"), "side\n");
    gitEnv(dir, {}, "add", "-A");
    gitEnv(dir, {}, "commit", "-q", "-m", "side");
    gitEnv(dir, {}, "checkout", "-q", "main");
    writeFileSync(join(dir, "main.txt"), "main\n");
    gitEnv(dir, {}, "add", "-A");
    gitEnv(dir, {}, "commit", "-q", "-m", "main");
    gitEnv(dir, {}, "merge", "-q", "--no-ff", "--no-commit", "side");
    writeFileSync(join(dir, "evil.txt"), `ip ${publicIp}\n`);
    writeFileSync(join(dir, "README.md"), `clean\nresolved with ${otherIp}\n`);
    gitEnv(dir, {}, "add", "-A");
    gitEnv(dir, {}, "commit", "-q", "-m", "merge side");
    const merge = gitEnv(dir, {}, "rev-parse", "HEAD").trim();
    gitEnv(dir, {}, "rm", "-q", "evil.txt");
    writeFileSync(join(dir, "README.md"), "clean\n");
    gitEnv(dir, {}, "commit", "-q", "-am", "remove");
    assert.equal(runGate(dir).code, 0);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`${merge.slice(0, 12)}:evil\\.txt: public-ipv4: .*${esc(red(publicIp))}`));
    assert.match(r.out, new RegExp(`${merge.slice(0, 12)}:README\\.md: public-ipv4: .*${esc(red(otherIp))}`));
  });
});

test("--history: a value from a merged branch is reported once, for the commit that added it", () => {
  withRepo((dir) => {
    gitEnv(dir, {}, "checkout", "-q", "-b", "side");
    writeFileSync(join(dir, "side.txt"), `ip ${publicIp}\n`);
    gitEnv(dir, {}, "add", "-A");
    gitEnv(dir, {}, "commit", "-q", "-m", "side");
    const side = gitEnv(dir, {}, "rev-parse", "HEAD").trim();
    gitEnv(dir, {}, "checkout", "-q", "main");
    writeFileSync(join(dir, "main.txt"), "main\n");
    gitEnv(dir, {}, "add", "-A");
    gitEnv(dir, {}, "commit", "-q", "-m", "main");
    gitEnv(dir, {}, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    const hits = r.out.split("\n").filter((l) => / public-ipv4: public IPv4 literal/.test(l));
    assert.equal(hits.length, 1, r.out);
    assert.match(hits[0], new RegExp(`^\\s*${side.slice(0, 12)}:side\\.txt:`));
  });
});

test("--history: an added line whose content starts with \"++ \" is content, not a file header", () => {
  const { dir } = historyRepo("plus.txt", `a\n++ ${publicIp} diff-header lookalike\n+++ b/${otherIp}\n`);
  try {
    const r = runGate(dir, "--history", "--show-values");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`plus\\.txt: public-ipv4: .*${esc(publicIp)}`));
    assert.match(r.out, new RegExp(`plus\\.txt: public-ipv4: .*${esc(otherIp)}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--history: noreply co-author trailers and example addresses in messages are quiet", () => {
  withRepo((dir) => {
    gitEnv(dir, {}, "commit", "-q", "--allow-empty", "-m", "Fix a thing", "-m", [
      "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
      "Co-authored-by: Someone <12345+someone@users.noreply.github.com>",
      "Committed-via: GitHub <noreply@github.com>",
      "Signed-off-by: dependabot[bot] <support@github.com>",
      "Reported-by: Ops <ops@mail.example.com>, QA <qa@ci.example.org>, Dev <dev@build.test>",
    ].join("\n"));
    const r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
  });
  // ...but a real-looking address in a message is still caught, and cannot be allow-listed.
  withRepo((dir) => {
    gitEnv(dir, {}, "commit", "-q", "--allow-empty", "-m", "Fix", "-m", `Co-Authored-By: Someone <${email}>`);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`<commit message>: email: .*${esc(red(email))}\\n\\s+cannot be allow-listed`));
  });
});

test("the e-mail rule allows example subdomains and git noreply addresses in files too", () => {
  const dir = repoWith({ "a.md": "ops@mail.example.com, noreply@anthropic.com, 1+x@users.noreply.github.com\n" });
  try {
    assert.equal(runGate(dir).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const bad of [["xnoreply", "anthropic.com"].join("@"), ["noreply", "anthropic.com.evil.net"].join("@"), ["ops", "example.com.evil.net"].join("@"), ["xsupport", "github.com"].join("@"), ["support", "github.com.evil.net"].join("@")]) {
    expectFinding({ "a.md": `${bad}\n` }, "email");
  }
});

test("--history scans author and committer identities with every rule except e-mail (documented limit)", () => {
  withRepo((dir) => {
    gitEnv(dir, { GIT_AUTHOR_NAME: `build ${publicIp}` }, "commit", "-q", "--allow-empty", "-m", "a");
    let r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /<author>: public-ipv4/);
    gitEnv(dir, {}, "reset", "-q", "--hard", "HEAD~1");
    gitEnv(dir, { GIT_COMMITTER_EMAIL: `deploy@${host}` }, "commit", "-q", "--allow-empty", "-m", "b");
    r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /<committer>: railway-public-host/);
  });
  // The e-mail rule is not applied to identities: an author e-mail is inherent to git.
  withRepo((dir) => {
    gitEnv(dir, { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email }, "commit", "-q", "--allow-empty", "-m", "c");
    const r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
  });
});

test("--history scans annotated tag messages and tagger identities", () => {
  withRepo((dir) => {
    gitEnv(dir, {}, "tag", "-a", "v1", "-m", `release, deployed to ${publicIp}`);
    let r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /<tag message>: public-ipv4/);
    assert.match(r.out, /in 1 commit\(s\) and 1 annotated tag\(s\):/);
    gitEnv(dir, {}, "tag", "-d", "v1");
    gitEnv(dir, { GIT_COMMITTER_NAME: `rel ${uuid}` }, "tag", "-a", "v2", "-m", "clean");
    r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /<tagger>: uuid-literal/);
    gitEnv(dir, {}, "tag", "-d", "v2");
    gitEnv(dir, {}, "tag", "-a", "v3", "-m", "Co-Authored-By: Claude <noreply@anthropic.com>");
    r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /1 annotated tag\(s\) scanned/);
  });
});

test("--history finds an empty or binary forbidden file (no \"+++\" line in the diff)", () => {
  for (const [path, content] of [[".env", ""], ["certs/client.p12", Buffer.from([0x30, 0x82, 0, 0x10, 0xff, 0xfe, 0, 0x81])]]) {
    const { dir } = historyRepo(path, content);
    try {
      const r = runGate(dir, "--history");
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`${path.replaceAll(".", "\\.")}: forbidden-file`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---- output never republishes a matched value (public CI logs) -------------

/** A repo whose HEAD has `x.txt` with a public IPv4, a real-looking e-mail and a Railway host, also in the commit message. */
function plantedRepo() {
  const dir = emptyRepo();
  const text = `ip ${publicIp}\nowner ${email}\nurl https://${host}/v1\nsynthetic ${otherIp} // public-safety: allow-synthetic test input\n`;
  writeFileSync(join(dir, "x.txt"), text);
  gitEnv(dir, {}, "add", "-A");
  gitEnv(dir, {}, "commit", "-q", "-m", `add x: ${publicIp} ${email} ${host}`);
  return { dir, sha: gitEnv(dir, {}, "rev-parse", "HEAD").trim() };
}

test("by default neither a matched value nor any part of its hash is printed, in tree and history mode", () => {
  const { dir } = plantedRepo();
  try {
    for (const mode of [[], ["--history"]]) {
      const r = runGate(dir, ...mode);
      const label = mode.join(" ") || "tree";
      assert.equal(r.code, 1, r.out);
      for (const v of [publicIp, email, host, otherIp]) {
        assert.ok(!r.out.includes(v), `${label} output contains ${v}:\n${r.out}`);
        assert.ok(r.out.includes(red(v)), `${label} output lacks the redacted form of ${v}:\n${r.out}`);
        const h = sha256(v);
        for (let i = 0; i + 12 <= h.length; i++) assert.ok(!r.out.includes(h.slice(i, i + 12)), `${label} output contains part of sha256(${v}):\n${r.out}`);
      }
      assert.doesNotMatch(r.out, /allow-list fingerprint|sha256 [0-9a-f]/);
      for (const rule of ["public-ipv4", "email", "railway-public-host"]) assert.match(r.out, new RegExp(`x\\.txt(:1|:2|:3)?: ${rule}`));
      assert.match(r.out, /opt-out/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--show-values prints the raw values, and is refused in CI", () => {
  const { dir } = plantedRepo();
  try {
    for (const mode of [[], ["--history"]]) {
      const r = runGate(dir, ...mode, "--show-values");
      assert.equal(r.code, 1, r.out);
      for (const v of [publicIp, email, host, otherIp]) assert.ok(r.out.includes(v), `${mode.join(" ") || "tree"} --show-values lacks ${v}:\n${r.out}`);
    }
    for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
      const r = runGateEnv(dir, env, "--history", "--show-values");
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /--show-values prints raw values or their hashes and is for local use only; refusing in CI/);
      for (const v of [publicIp, email, host]) assert.ok(!r.out.includes(v));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fingerprints (local only) prints the exact entry, which waives exactly one hit; refused in CI", () => {
  const { dir, sha } = plantedRepo();
  try {
    const fps = (out) => out.split("\n").filter((l) => l.includes("allow-list fingerprint:")).map((l) => l.trim().slice("allow-list fingerprint: ".length));
    const r = runGate(dir, "--history", "--fingerprints");
    assert.equal(r.code, 1, r.out);
    assert.ok(!r.out.includes(publicIp));
    const entries = fps(r.out);
    const fileEntry = `${sha}:x.txt:public-ipv4:${sha256(publicIp)}`;
    assert.ok(entries.includes(fileEntry), entries.join("\n"));
    assert.ok(entries.includes(`${sha}:<commit message>:public-ipv4:${sha256(publicIp)}`), entries.join("\n"));
    // No fingerprint for the never-waivable e-mail and host hits.
    assert.equal(entries.filter((e) => /:(email|railway-public-host):/.test(e)).length, 0);
    // The printed entry, pasted with a justification, waives exactly that one hit:
    // the same value in the commit message is still reported.
    writeFileSync(join(dir, ALLOW), `# reviewed: synthetic test input\n${fileEntry}\n`);
    const after = runGate(dir, "--history", "--fingerprints");
    assert.equal(after.code, 1, after.out);
    assert.ok(!fps(after.out).includes(fileEntry), after.out);
    assert.ok(fps(after.out).includes(`${sha}:<commit message>:public-ipv4:${sha256(publicIp)}`), after.out);
    assert.doesNotMatch(after.out, /x\.txt: public-ipv4: public IPv4 literal/);
    assert.match(after.out, /<commit message>: public-ipv4: public IPv4 literal/);
    for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }, { CI: "1", GITHUB_ACTIONS: "true" }]) {
      const c = runGateEnv(dir, env, "--history", "--fingerprints");
      assert.equal(c.code, 2, c.out);
      assert.match(c.out, /--fingerprints prints raw values or their hashes and is for local use only; refusing in CI/);
      assert.doesNotMatch(c.out, /allow-list fingerprint/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an internal error does not echo git's message unless --show-values", () => {
  const dir = mkdtempSync(join(tmpdir(), "public-safety-nogit-"));
  try {
    let r = runGate(dir);
    assert.equal(r.code, 2, r.out);
    assert.doesNotMatch(r.out, /not a git repository|ls-files/);
    assert.match(r.out, /internal error: Error \(exit status \d+\); rerun locally with --show-values/);
    r = runGate(dir, "--show-values");
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CI never passes the local-only flags --show-values or --fingerprints", () => {
  const ci = readFileSync(resolve(import.meta.dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /check-public-safety\.mjs --history/);
  for (const flag of ["--show-values", "--fingerprints"]) assert.ok(!ci.includes(flag), `ci.yml passes ${flag}`);
});

// ---- C-quoted paths in history (CHR-66 R2-1) ---------------------------------

test("--history finds forbidden files under paths git C-quotes (a quote, a tab), committed then removed", () => {
  for (const path of ['we"ird/.env', "tab\tdir/server.key"]) {
    const { dir } = historyRepo(path, "X=1\n");
    try {
      assert.equal(runGate(dir).code, 0);
      const r = runGate(dir, "--history");
      assert.equal(r.code, 1, `${JSON.stringify(path)}\n${r.out}`);
      assert.match(r.out, /forbidden-file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("--history attributes content under a C-quoted path to the real path (text, UTF-16 and a modified binary)", () => {
  // Text content: the fingerprint names the un-quoted path.
  const { dir, sha } = historyRepo('q"uote/a.txt', `ip ${publicIp}\n`);
  try {
    const r = runGate(dir, "--history", "--fingerprints");
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`allow-list fingerprint: ${sha}:q"uote/a.txt:public-ipv4:${sha256(publicIp)}`), r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A UTF-16 (git: binary) file under a quoted path is decoded from its blob.
  const wide = historyRepo("tab\tdir/wide.txt", utf16le(`ip = ${publicIp}\n`));
  try {
    const r = runGate(wide.dir, "--history", "--fingerprints");
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`${wide.sha}:tab\tdir/wide.txt:public-ipv4:${sha256(publicIp)}`), r.out);
  } finally {
    rmSync(wide.dir, { recursive: true, force: true });
  }
  // A modified binary file whose path contains " and " (the "Binary files a/P and b/P differ" split).
  const d = mkdtempSync(join(tmpdir(), "public-safety-hist-"));
  try {
    git(d, "init", "-q");
    mkdirSync(join(d, 'x and "y'));
    writeFileSync(join(d, 'x and "y', "w.txt"), utf16le("clean\n"));
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "one");
    writeFileSync(join(d, 'x and "y', "w.txt"), utf16le(`ip = ${publicIp}\n`));
    git(d, "commit", "-q", "-am", "two");
    const sha = git(d, "rev-parse", "HEAD").trim();
    const r = runGate(d, "--history", "--fingerprints");
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.includes(`${sha}:x and "y/w.txt:public-ipv4:${sha256(publicIp)}`), r.out);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---- file and ref names (CHR-66 R2-2) ----------------------------------------

/** Asserts that `out` holds none of `values`, none of their SHA-256 hashes and no 12-hex window of one. */
function assertNoValues(out, values, label) {
  for (const v of values) {
    assert.ok(!out.includes(v), `${label}: output contains ${v}:\n${out}`);
    const h = sha256(v);
    for (let i = 0; i + 12 <= h.length; i++) assert.ok(!out.includes(h.slice(i, i + 12)), `${label}: output contains part of sha256(${v})`);
  }
}

test("file names are scanned in tree and history mode, and printed redacted", () => {
  withRepo((dir) => {
    mkdirSync(join(dir, "logs"));
    for (const name of [`${publicIp}.txt`, `${host}.json`, `${uuid}.json`]) writeFileSync(join(dir, "logs", name), "clean\n");
    gitEnv(dir, {}, "add", "-A");
    gitEnv(dir, {}, "commit", "-q", "-m", "add logs");
    let r = runGate(dir);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`<path> logs/${esc(red(publicIp))}\\.txt: public-ipv4: .*: ${esc(red(publicIp))}`));
    assert.match(r.out, new RegExp(`<path> logs/${esc(red(host))}\\.json: railway-public-host`));
    assert.match(r.out, new RegExp(`<path> logs/${esc(red(uuid))}\\.json: uuid-literal`));
    assertNoValues(r.out, [publicIp, host, uuid], "tree");
    gitEnv(dir, {}, "rm", "-q", "-r", "logs");
    gitEnv(dir, {}, "commit", "-q", "-m", "remove logs");
    assert.equal(runGate(dir).code, 0);
    r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    for (const rule of ["public-ipv4", "railway-public-host", "uuid-literal"]) assert.match(r.out, new RegExp(`:<path> logs/\\[redacted: \\d+ chars\\]\\.(txt|json): ${rule}`));
    assertNoValues(r.out, [publicIp, host, uuid], "history");
    // --show-values (local) shows the names.
    assert.ok(runGate(dir, "--history", "--show-values").out.includes(`logs/${publicIp}.txt`));
  });
});

test("ref names (a branch, a lightweight and an annotated tag) are scanned in tree and history mode, and printed redacted", () => {
  withRepo((dir) => {
    gitEnv(dir, {}, "branch", `rel-${publicIp}`);
    gitEnv(dir, {}, "tag", `hotfix-${host}`);
    gitEnv(dir, {}, "tag", "-a", `build-${uuid}`, "-m", "clean");
    for (const mode of [[], ["--history"]]) {
      const r = runGate(dir, ...mode);
      const label = mode.join(" ") || "tree";
      assert.equal(r.code, 1, `${label}\n${r.out}`);
      assert.match(r.out, new RegExp(`<ref> refs/heads/rel-${esc(red(publicIp))}: public-ipv4`));
      // The host rule takes the whole label, so the hit is "hotfix-<host>".
      assert.match(r.out, new RegExp(`<ref> refs/tags/${esc(red(`hotfix-${host}`))}: railway-public-host`));
      assert.match(r.out, new RegExp(`<ref> refs/tags/build-${esc(red(uuid))}: uuid-literal`));
      assertNoValues(r.out, [publicIp, host, uuid], label);
    }
  });
});

test("a <path> or <ref> hit is allow-listed per commit (or ref target) and value; refused rules stay refused", () => {
  withRepo((dir) => {
    writeFileSync(join(dir, `${publicIp}.txt`), "clean\n");
    gitEnv(dir, {}, "add", "-A");
    gitEnv(dir, {}, "commit", "-q", "-m", "add");
    const sha = gitEnv(dir, {}, "rev-parse", "HEAD").trim();
    gitEnv(dir, {}, "rm", "-q", `${publicIp}.txt`);
    gitEnv(dir, {}, "commit", "-q", "-m", "rm");
    const head = gitEnv(dir, {}, "rev-parse", "HEAD").trim();
    gitEnv(dir, {}, "branch", `rel-${otherIp}`);
    let r = runGate(dir, "--history", "--fingerprints");
    assert.equal(r.code, 1, r.out);
    const pathEntry = `${sha}:<path>:public-ipv4:${sha256(publicIp)}`;
    const refEntry = `${head}:<ref>:public-ipv4:${sha256(otherIp)}`;
    assert.ok(r.out.includes(`allow-list fingerprint: ${pathEntry}`), r.out);
    assert.ok(r.out.includes(`allow-list fingerprint: ${refEntry}`), r.out);
    assert.ok(!r.out.includes(publicIp) && !r.out.includes(otherIp), r.out);
    writeFileSync(join(dir, ALLOW), `# reviewed: synthetic file and branch names used as parser fixtures\n${pathEntry}\n${refEntry}\n`);
    r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
    // A <ref> entry for a refused rule is refused like any other.
    writeFileSync(join(dir, ALLOW), `# reviewed\n${head}:<ref>:railway-public-host:${sha256(host)}\n`);
    r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /rule railway-public-host cannot be allow-listed/);
  });
});

test("printed paths escape control characters", () => {
  const { dir } = historyRepo("tab\tdir/server.key", "k\n");
  try {
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /tab\\x09dir\/server\.key: forbidden-file/);
    assert.ok(!r.out.includes("tab\tdir"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the IPv4 rule matches before a trailing dot or a file extension, not inside a longer dotted run", () => {
  expectFinding({ "a.md": `connect to ${publicIp}.\n` }, "public-ipv4");
  expectFinding({ "a.md": `see logs/${publicIp}.txt\n` }, "public-ipv4");
  const dir = repoWith({ "ok.md": "version 1.2.3.4.5 and build 10.20.30.40.1 and 5.6.7.8.9.10\n" });
  try {
    assert.equal(runGate(dir).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Supabase identifiers and credentials (docs/GUARDRAILS.md G1) -----------
// Every value is synthetic and assembled at runtime so this file passes the gate.

const sbRef = ["qwertyuiop", "asdfghjklz"].join(""); // 20 characters, not a real project
const sbHost = [sbRef, "supabase", "co"].join(".");
const sbHostIn = [sbRef, "supabase", "in"].join(".");
const sbDbHost = ["db", sbRef, "supabase", "co"].join(".");
const sbPooler = ["aws-0-eu-west-2", "pooler", "supabase", "com"].join(".");
const sbSecret = ["sb", "secret", "k".repeat(30)].join("_");
const sbPublishable = ["sb", "publishable", "k".repeat(30)].join("_");
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => [b64url({ alg: "HS256", typ: "JWT" }), b64url(claims), "c2lnbmF0dXJlLW5vdC1yZWFs"].join(".");
const serviceJwt = jwt({ iss: "supabase", ref: sbRef, role: "service_role", iat: 1, exp: 2 });
const anonJwt = jwt({ iss: "supabase", role: "anon", iat: 1, exp: 2 });

for (const [name, content, ruleId] of [
  ["a Supabase project URL", `SUPABASE_URL=https://${sbHost}\n`, "supabase-project-host"],
  ["a Supabase project host on .supabase.in", `host = "${sbHostIn}"\n`, "supabase-project-host"],
  ["a direct database host db.<ref>.supabase.co in a connection string", `postgres://postgres:pw@${sbDbHost}:5432/postgres\n`, "supabase-project-host"],
  ["an upper-case project host", `url = https://${sbHost.toUpperCase()}\n`, "supabase-project-host"],
  ["a connection-pooler host", `DATABASE_URL=postgres://postgres.x:pw@${sbPooler}:6543/postgres\n`, "supabase-pooler-host"],
  ["an sb_secret_ key", `key = "${sbSecret}"\n`, "supabase-api-key"],
  ["an sb_publishable_ key", `VITE_KEY=${sbPublishable}\n`, "supabase-api-key"],
  ["a service_role JWT", `SUPABASE_SERVICE_ROLE_KEY=${serviceJwt}\n`, "service-role-jwt"],
]) {
  test(`detects ${name}`, () => {
    const r = expectFinding({ "cfg.ts": content }, ruleId);
    // Redacted: the value is never printed.
    for (const v of [sbRef, sbPooler, sbSecret, serviceJwt]) assert.ok(!r.out.includes(v), r.out);
  });
}

test("Supabase rules stay quiet on placeholders, docs links, bare key prefixes, an anon JWT and the documented synthetic ref", () => {
  const dir = repoWith({
    "ok.md": [
      "SBH_URL=https://<PROJECT_REF>.supabase.co and https://<project-ref>.supabase.co/functions/v1/idr-sync",
      "pricing at https://supabase.com/pricing, docs at https://supabase.com/docs/guides/database",
      "pooler: aws-0-<region>.pooler.supabase.com and <region>.pooler.supabase.com",
      "the `sb_publishable_` key and the `sb_secret_` key; the service_role role",
      "a label longer than a ref: averyveryverylongprojectlabel.supabase.co is not a project host",
      `anon key ${anonJwt}`,
      // The one documented synthetic ref (SYNTHETIC_SUPABASE_REFS), already in the public history.
      `https://${["abcdefghijklmnopqrst", "supabase", "co"].join(".")}`,
    ].join("\n") + "\n",
  });
  try {
    const r = runGate(dir);
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the synthetic marker does not opt out any Supabase rule", () => {
  const marked = (v) => `x = "${v}" // public-safety: allow-synthetic test input\n`;
  for (const [v, ruleId] of [
    [sbHost, "supabase-project-host"],
    [sbPooler, "supabase-pooler-host"],
    [sbSecret, "supabase-api-key"],
    [serviceJwt, "service-role-jwt"],
  ]) {
    const r = expectFinding({ "m.ts": marked(v) }, ruleId);
    assert.doesNotMatch(r.out, /opt-out/);
  }
});

test("--history finds a Supabase host, key and service JWT that were added then removed", () => {
  const { dir } = historyRepo("old.env.example", `SUPABASE_URL=https://${sbHost}\nKEY=${sbSecret}\nSERVICE=${serviceJwt}\nPOOL=${sbPooler}\n`);
  try {
    assert.equal(runGate(dir).code, 0);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    for (const rule of ["supabase-project-host", "supabase-api-key", "service-role-jwt", "supabase-pooler-host"]) {
      assert.match(r.out, new RegExp(`${rule}: .*\\n\\s+cannot be allow-listed`));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses an allow entry for service-role-jwt (hard error)", () => {
  const { dir, sha } = historyRepo("j.txt", `key ${serviceJwt}\n`);
  try {
    writeFileSync(join(dir, ALLOW), `# reviewed: it is fine, trust me\n${sha}:j.txt:service-role-jwt:${sha256(serviceJwt)}\n`);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /rule service-role-jwt cannot be allow-listed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
