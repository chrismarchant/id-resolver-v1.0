/**
 * Self-test for scripts/check-public-safety.mjs: proves each rule fires on a
 * planted (synthetic) violation and stays quiet on allowed forms, so the CI
 * gate cannot silently pass because a rule regressed.
 * Run: node --test scripts/check-public-safety.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
  const r = spawnSync(process.execPath, [GATE, ...args], { cwd: dir, encoding: "utf8" });
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
    assert.match(r.out, /allow-list fingerprint: [0-9a-f]{40}:old\.ts:public-ipv4:/);
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

test("--history honours exact commit:path:rule:value fingerprints and nothing broader", () => {
  const { dir, sha } = historyRepo("old.ts", `ip = "${publicIp}"\n`);
  try {
    const allow = join(dir, ".public-safety-history-allow");
    // Wrong path, wrong value and a short sha must not match.
    writeFileSync(allow, [`${sha}:other.ts:public-ipv4:${publicIp}`, `${sha}:old.ts:public-ipv4:${[9, 9, 9, 8].join(".")}`, `${sha.slice(0, 7)}:old.ts:public-ipv4:${publicIp}`].join("\n") + "\n");
    assert.equal(runGate(dir, "--history").code, 1);
    writeFileSync(allow, `# reviewed: synthetic\n${sha}:old.ts:public-ipv4:${publicIp}\n`);
    const r = runGate(dir, "--history");
    assert.equal(r.code, 0, r.out);
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
