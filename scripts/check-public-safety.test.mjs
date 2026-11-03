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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GATE = resolve(import.meta.dirname, "check-public-safety.mjs");

function repoWith(files) {
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

function runGate(dir) {
  const r = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: "utf8" });
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
