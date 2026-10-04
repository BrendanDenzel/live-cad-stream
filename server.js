const express = require("express");
const { Readable } = require("stream");
const crypto = require("crypto");

// Set SECRET in Render's Environment tab (any long random string)
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString("hex");
const KEY = crypto.createHash("sha256").update(SECRET).digest();

function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

function open(token) {
  const buf = Buffer.from(token, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const app = express();
const PORT = process.env.PORT || 3000;

// Route name -> env var holding that feed's playlist URL
// Adds /police.m3u8 and /fire.m3u8
const FEEDS = {
  police: process.env.POLICE,
  fire: process.env.FIRE,
};

const UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

// Allowed upstream domains, worked out from the feed env vars
const ALLOWED_DOMAINS = Object.values(FEEDS)
  .filter(Boolean)
  .map((u) => new URL(u).hostname.split(".").slice(-2).join("."));
const hostAllowed = (h) =>
  ALLOWED_DOMAINS.some((d) => h === d || h.endsWith("." + d));

const UPSTREAM_HEADERS = {
  "User-Agent": UA,
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};
// Optional: only added if you set a REFERER env var
if (process.env.REFERER) {
  UPSTREAM_HEADERS.Referer = process.env.REFERER;
  UPSTREAM_HEADERS.Origin = new URL(process.env.REFERER).origin;
}

app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-cache",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Ping this with UptimeRobot
app.get("/ping", (req, res) => res.type("text").send("ok"));

async function relay(target, res) {
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    const upstream = await fetch(target, {
      headers: UPSTREAM_HEADERS,
      signal: controller.signal,
    });
    const isPlaylist = new URL(target).pathname.endsWith(".m3u8");

    if (isPlaylist) {
      const text = await upstream.text();
      const proxify = (u) => {
        const full = new URL(u, target);
        const ext = full.pathname.match(/\.[a-z0-9]+$/i)?.[0] || "";
        return "/s/" + seal(full.href) + ext;
      };

      const rewritten = text
        .split("\n")
        .map((line) => {
          const l = line.trim();
          if (!l) return line;
          if (l.startsWith("#")) {
            return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxify(u)}"`);
          }
          return proxify(l);
        })
        .join("\n");

      return res
        .status(upstream.status)
        .type("application/vnd.apple.mpegurl")
        .send(rewritten);
    }

    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.set("Content-Type", ct);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on("error", () => res.end()).pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(502).send("Upstream error");
    else res.end();
  }
}

// One route per feed: /police.m3u8, /fire.m3u8
for (const [name, url] of Object.entries(FEEDS)) {
  app.get(`/${name}.m3u8`, (req, res) => {
    if (!url) {
      return res.status(500).send(`${name.toUpperCase()} env var not set`);
    }
    relay(url, res);
  });
}

// Shared segment proxy for all feeds (encrypted URLs only)
app.get("/s/:token", (req, res) => {
  let target;
  try {
    target = open(req.params.token.replace(/\.[a-z0-9]+$/i, ""));
    if (!hostAllowed(new URL(target).hostname)) throw new Error();
  } catch {
    return res.status(400).send("Bad request");
  }
  relay(target, res);
});

app.listen(PORT, () => console.log(`Relay listening on ${PORT}`));
