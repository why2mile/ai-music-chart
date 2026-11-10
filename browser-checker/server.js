import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 10000);
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || "";

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-music-chart-browser-checker" });
});

function normalizeVideoId(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    }
    if (u.hostname.endsWith("youtube.com")) {
      const id = u.searchParams.get("v");
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    }
  } catch {}
  return null;
}

app.get("/self-test", async (_req, res) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    const results = [];
    for (const videoId of ["XUl9vv_JWKc", "AW58Ofv_QeU"]) {
      let page;
      try {
        page = await browser.newPage({ locale: "en-US", userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" });
        await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`, { waitUntil: "domcontentloaded", timeout: 8000 });
        await page.waitForSelector("#title-row", { timeout: 15000 });
        const found = await page.evaluate(() => {
          const row = document.querySelector("#title-row");
          const labels = row ? [...row.querySelectorAll("yt-metadata-badge-renderer")].map(el => el.querySelector("badge-shape")?.getAttribute("aria-label") || el.textContent || "").map(x => x.trim()).filter(Boolean) : [];
          const pattern = /(?:content\\s+was\\s+made\\s+with\\s+ai|made\\s+with\\s+ai|generated\\s+with\\s+ai|ai[- ]generated|altered\\s+or\\s+synthetic)/i;
          return { title: document.querySelector("h1 yt-formatted-string")?.textContent?.trim() || "", labels, ai_label: labels.some(x => pattern.test(x)) };
        });
        results.push({ video_id: videoId, ...found, status: "checked" });
      } catch (e) {
        results.push({ video_id: videoId, ai_label: null, status: "check_failed", error: String(e?.message || e).slice(0, 200) });
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
    return res.json({ results });
  } catch (e) {
    return res.status(503).json({ error: "browser_unavailable", detail: String(e?.message || e).slice(0, 200) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.post("/verify", async (req, res) => {
  if (!SERVICE_TOKEN || req.get("x-service-token") !== SERVICE_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const raw = req.body?.video_ids;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
    return res.status(400).json({ error: "video_ids must contain 1 to 20 IDs" });
  }

  const ids = [...new Set(raw.map(normalizeVideoId).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ error: "no valid YouTube video IDs" });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
    const results = [];
    for (const videoId of ids) {
      let page;
      try {
        page = await browser.newPage({
          locale: "en-US",
          userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        });
        await page.goto(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
        await page.waitForSelector("#title-row", { timeout: 15000 });
        const found = await page.evaluate(() => {
          const row = document.querySelector("#title-row");
          if (!row) return { titleRow: false, title: "" };
          const title = document.querySelector("h1 yt-formatted-string")?.textContent?.trim() || "";
          const labels = [...row.querySelectorAll("yt-metadata-badge-renderer")]
            .map(el => el.querySelector("badge-shape")?.getAttribute("aria-label") || el.textContent || "")
            .map(s => s.trim())
            .filter(Boolean);
          const pattern = /(?:content\s+was\s+made\s+with\s+ai|made\s+with\s+ai|generated\s+with\s+ai|ai[- ]generated|altered\s+or\s+synthetic)/i;
          const match = labels.find(label => pattern.test(label));
          return { titleRow: true, title, labels, match: match || null };
        });
        results.push({
          video_id: videoId,
          ai_label: Boolean(found.match),
          status: found.titleRow ? "checked" : "title_row_missing",
          title: found.title,
          badge_label: found.match
        });
      } catch (error) {
        results.push({
          video_id: videoId,
          ai_label: null,
          status: "check_failed",
          error: String(error?.message || error).slice(0, 300)
        });
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
    return res.json({ results });
  } catch (error) {
    return res.status(503).json({ error: "browser_unavailable", detail: String(error?.message || error).slice(0, 300) });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI label checker listening on ${PORT}`);
});
