#!/usr/bin/env node
// Lock pages behind an access code.
//
// The readable source of every locked page lives in  _private/pages/<site path>/
// (git-ignored, never published). This script encrypts each of those folders
// into the matching public folder: an index.html "gate" that asks for the code,
// plus .enc files that only open with it.
//
//   node bin/lock-pages.mjs
//
// The code is read from _private/access-code.txt (one line). To change the code,
// or after editing a page in _private/pages, run the script again and commit.
//
// Crypto: PBKDF2-SHA256 (600k rounds) -> AES-256-GCM. IVs are derived from the
// content, so unchanged files produce identical output and git stays quiet.

import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync, createCipheriv, createHmac, randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIVATE = join(ROOT, "_private");
const PAGES = join(PRIVATE, "pages");
const CODE_FILE = join(PRIVATE, "access-code.txt");
const SALT_FILE = join(ROOT, "bin", "lock-salt.txt"); // public by design; keeps output stable
const GATE_TEMPLATE = join(ROOT, "bin", "lock-gate.html");
const ITERATIONS = 600000;
const CONTACT = "zhangcy@mit.edu";

function fail(msg) { console.error("lock-pages: " + msg); process.exit(1); }

if (!existsSync(PAGES)) fail("nothing to lock: " + PAGES + " does not exist");
if (!existsSync(CODE_FILE)) fail("put the access code in " + CODE_FILE);
const code = readFileSync(CODE_FILE, "utf8").trim();
if (code.length < 6) fail("the access code must be at least 6 characters");

if (!existsSync(SALT_FILE)) writeFileSync(SALT_FILE, randomBytes(16).toString("base64") + "\n");
const salt = Buffer.from(readFileSync(SALT_FILE, "utf8").trim(), "base64");
const key = pbkdf2Sync(code.normalize("NFKC"), salt, ITERATIONS, 32, "sha256");

// Encrypt -> iv(12) | ciphertext | tag(16). The IV is an HMAC of path + content.
function encrypt(name, data) {
  const iv = createHmac("sha256", key).update(name).update("\0").update(data).digest().subarray(0, 12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// A page folder is any folder under _private/pages that holds an index.html.
function findPages(dir) {
  const here = existsSync(join(dir, "index.html")) ? [dir] : [];
  if (here.length) return here; // a page owns everything below it
  return readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory()).flatMap(findPages);
}

const gate = readFileSync(GATE_TEMPLATE, "utf8");
const gateEmbedded = readFileSync(join(ROOT, "bin", "lock-gate-embedded.html"), "utf8");
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

for (const src of findPages(PAGES)) {
  const sitePath = relative(PAGES, src).split(sep).join("/");
  const dest = join(ROOT, sitePath);
  let html = readFileSync(join(src, "index.html"), "utf8").replace(/\r\n/g, "\n");
  // A source that starts with Jekyll front matter is published inside the site
  // layout (navbar, theme, footer); the gate swaps the decrypted content in place.
  const fm = html.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) html = html.slice(fm[0].length);
  const title = fm
    ? (fm[1].match(/^title:\s*(.*)$/m) || [, sitePath])[1].trim()
    : (html.match(/<title>([^<]*)<\/title>/i) || [, sitePath])[1].trim();
  const assets = walk(src).map((p) => relative(src, p).split(sep).join("/")).filter((p) => p !== "index.html").sort();

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const a of assets) {
    const out = join(dest, a + ".enc");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, encrypt(sitePath + "/" + a, readFileSync(join(src, a))));
  }
  const payload = Buffer.from(JSON.stringify({ html, assets }), "utf8");
  writeFileSync(join(dest, "page.enc"), encrypt(sitePath + "/page", payload));
  const fill = (template, open, close) =>
    template
      .replaceAll(open + "TITLE" + close, escapeHtml(title))
      .replaceAll(open + "CONTACT" + close, CONTACT)
      .replaceAll(open + "SUBJECT" + close, encodeURIComponent("Access request: " + title))
      .replaceAll(open + "SALT" + close, salt.toString("base64"))
      .replaceAll(open + "ITERATIONS" + close, String(ITERATIONS));
  let out;
  if (fm) {
    out = fm[0] + fill(gateEmbedded, "[[", "]]");
    // Jekyll runs Liquid over this file, so it must not contain Liquid tags.
    if (/\{\{|\{%/.test(out.slice(fm[0].length))) fail("embedded gate for /" + sitePath + "/ contains Liquid syntax");
  } else {
    out = fill(gate, "{{", "}}");
  }
  writeFileSync(join(dest, "index.html"), out);
  console.log("locked /" + sitePath + "/  (" + assets.length + " files + page, " + (fm ? "in site layout" : "standalone") + ")");
}
