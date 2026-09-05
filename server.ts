import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Suno URL & Short-link resolver endpoint
  app.all("/api/resolve-suno", async (req, res) => {
    try {
      const inputUrl = (req.query.url as string) || (req.body && (req.body.url as string)) || "";
      if (!inputUrl || typeof inputUrl !== "string") {
        return res.status(400).json({ success: false, error: "URL이 누락되었습니다." });
      }

      let url = inputUrl.trim();
      const uuidRegex = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

      // 1. Direct UUID in input string
      const directMatch = url.match(uuidRegex);
      if (directMatch) {
        return res.json({ success: true, songId: directMatch[0].toLowerCase() });
      }

      // 2. Normalizing Suno URLs and short codes
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        if (url.startsWith("s/") || url.startsWith("/s/")) {
          url = "https://suno.com/" + url.replace(/^\/+/, "");
        } else if (url.includes("suno.com") || url.includes("suno.ai")) {
          url = "https://" + url;
        } else if (/^[a-zA-Z0-9_-]{10,25}$/.test(url)) {
          // Plain short code like 'fo27V3FIRHDQTrmk'
          url = `https://suno.com/s/${url}`;
        } else {
          url = "https://" + url;
        }
      }

      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      };

      // 3. Fast manual redirect lookup (Suno /s/{code} returns HTTP 307 with location: /song/{uuid})
      try {
        const manualRes = await fetch(url, {
          redirect: "manual",
          headers,
        });

        const location = manualRes.headers.get("location");
        if (location) {
          const locMatch = location.match(uuidRegex);
          if (locMatch) {
            return res.json({
              success: true,
              songId: locMatch[0].toLowerCase(),
              resolvedUrl: location,
            });
          }
        }
      } catch (manualErr) {
        console.warn("Manual redirect fetch warning:", manualErr);
      }

      // 4. Follow redirect lookup
      const followRes = await fetch(url, {
        headers,
      });

      const followMatch = followRes.url.match(uuidRegex);
      if (followMatch) {
        return res.json({
          success: true,
          songId: followMatch[0].toLowerCase(),
          resolvedUrl: followRes.url,
        });
      }

      // 5. Check response HTML body for UUID
      const html = await followRes.text();
      const htmlMatch = html.match(uuidRegex);
      if (htmlMatch) {
        return res.json({
          success: true,
          songId: htmlMatch[0].toLowerCase(),
        });
      }

      return res.status(404).json({
        success: false,
        error: "Suno 곡 정보를 찾을 수 없습니다. 주소를 다시 확인해 주세요.",
      });
    } catch (err: any) {
      console.error("Resolve error:", err);
      return res.status(500).json({
        success: false,
        error: err.message || "Suno 링크 분석 중 오류가 발생했습니다.",
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
