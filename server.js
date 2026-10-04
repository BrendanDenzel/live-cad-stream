const express = require("express");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

// Set this in Render's Environment tab (don't hardcode it if your repo is public)
const PLAYLIST = process.env.PLAYLIST;

const UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

const ALLOWED_HOST = /(^|\.)broadcastify\.com$/;

const UPSTREAM_HEADERS = {
  "User-Agent": UA,
  Referer: "https://www.broadcastify.com/",
  Origin: "https://www.broadcastify.com",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

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
      const proxify = (u) =>
        "/seg?u=" + encodeURIComponent(new URL(u, target).href);

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

app.get("/playlist.m3u8", (req, res) => {
  if (!PLAYLIST) return res.status(500).send("PLAYLIST env var not set");
  relay(PLAYLIST, res);
});

app.get("/seg", (req, res) => {
  let parsed;
  try {
    parsed = new URL(req.query.u);
  } catch {
    return res.status(400).send("Bad request");
  }
  if (!ALLOWED_HOST.test(parsed.hostname)) {
    return res.status(403).send("Forbidden");
  }
  relay(parsed.href, res);
});

app.listen(PORT, () => console.log(`Relay listening on ${PORT}`));
