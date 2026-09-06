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

      const headers = {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      };

      // Helper to fetch song details (title, artist, handle, tags, cover image, direct audio URL)
      async function getSongDetails(songId: string, preloadedHtml?: string) {
        let html = preloadedHtml;
        if (!html) {
          try {
            const pageRes = await fetch(`https://suno.com/song/${songId}`, { headers });
            html = await pageRes.text();
          } catch (e) {
            console.warn("Failed to fetch song page for metadata:", e);
          }
        }

        let title = "";
        let artist = "";
        let handle = "";
        let tags = "";
        let imageUrl = `https://cdn2.suno.ai/image_large_${songId}.jpeg`;
        let audioUrl = "";

        if (html) {
          // 1. Title & Artist from children tag: "Title by Artist | Suno"
          const pageTitleMatch =
            html.match(/\\?"children\\?":\s*\\?"([^\\"]+?)\s+by\s+([^\\"]+?)\s+\|\s*Suno\\?"/i) ||
            html.match(/<title>([^<]+?)\s+by\s+([^<]+?)\s+\|\s*Suno<\/title>/i);
          if (pageTitleMatch) {
            title = pageTitleMatch[1].trim();
            artist = pageTitleMatch[2].trim();
          }

          // 2. Title & Artist from description: "Title by Artist (@handle). Listen and make your own on Suno."
          const descMatch =
            html.match(/name\\?":\s*\\?"description\\?",\s*\\?"content\\?":\s*\\?"([^\\"]+)\\?"/i) ||
            html.match(/<meta[^>]+name=["\\]*description["\\]*[^>]+content=["\\]*([^"\\>]+)["\\]*/i);
          if (descMatch && descMatch[1]) {
            const parsedDesc = descMatch[1].match(/^(.+?)\s+by\s+(.+?)(?:\s+\(@([^\)]+)\))?(?:\.|\s+Listen|$)/i);
            if (parsedDesc) {
              if (!title) title = parsedDesc[1].trim();
              if (!artist) artist = parsedDesc[2].trim();
              if (parsedDesc[3]) handle = `@${parsedDesc[3].trim().replace(/^@/, "")}`;
            }
          }

          // 3. Fallback og:title / twitter:title
          if (!title) {
            const ogTitleMatch =
              html.match(/(?:og:title|twitter:title)\\?"\s*,\s*\\?"content\\?"\s*:\s*\\?"([^\\"]+)\\?"/i) ||
              html.match(/property=["\\]*(?:og:title|twitter:title)["\\]*\s+content=["\\]*([^"\\>]+)["\\]*/i);
            if (ogTitleMatch && ogTitleMatch[1]) {
              title = ogTitleMatch[1].trim();
            }
          }

          // 4. Extract display tags / musical style
          const tagsMatch =
            html.match(/\\?"display_tags\\?":\s*\\?"([^\\"]+)\\?"/i) ||
            html.match(/\\?"tags\\?":\s*\\?"([^\\"]+)\\?"/i);
          if (tagsMatch && tagsMatch[1]) {
            tags = tagsMatch[1].trim().replace(/\\n/g, ", ");
          }

          // 5. Handle / creator handle
          if (!handle) {
            const handleMatch = html.match(/\\?"handle\\?":\s*\\?"([^\\"]+)\\?"/i);
            if (handleMatch && handleMatch[1]) {
              handle = `@${handleMatch[1].trim().replace(/^@/, "")}`;
            }
          }

          // 6. Cover image URL
          const imgMatch =
            html.match(/(?:og:image|twitter:image)\\?"\s*,\s*\\?"content\\?"\s*:\s*\\?"([^\\"]+)\\?"/i) ||
            html.match(/image_large_url\\?":\s*\\?"(https:\/\/[^\\"]+)\\?"/i) ||
            html.match(/property=["\\]*(?:og:image|twitter:image)["\\]*\s+content=["\\]*([^"\\>]+)["\\]*/i);
          if (imgMatch && imgMatch[1]) {
            imageUrl = imgMatch[1].trim().replace(/\\\//g, "/");
          }

          // 7. Extract direct audio stream if available
          const audioMatches =
            html.match(/https:\/\/[^"'\s\\]+cloudfront\.net\/[^"'\s\\]+\.m4a/g) ||
            html.match(/https:\/\/[^"'\s\\]+\.(?:m4a|mp3)/g);
          if (audioMatches) {
            const validAudio = audioMatches.find((a) => !a.includes("sil-100.mp3"));
            if (validAudio) {
              audioUrl = validAudio;
            }
          }
        }

        // 8. Official Suno oEmbed API fallback for title if still missing
        if (!title) {
          try {
            const oembedRes = await fetch(
              `https://studio-api-prod.suno.com/api/oembed?url=https%3A%2F%2Fsuno.com%2Fsong%2F${songId}`
            );
            if (oembedRes.ok) {
              const oembed = await oembedRes.json();
              if (oembed.title) {
                title = oembed.title.trim();
              }
            }
          } catch (e) {
            console.warn("oEmbed fallback failed:", e);
          }
        }

        return {
          songId: songId.toLowerCase(),
          title: title || `Suno Track (${songId.slice(0, 8)})`,
          artist: artist || "Suno Creator",
          handle: handle || "",
          tags: tags || "",
          imageUrl,
          audioUrl,
        };
      }

      // 1. Direct UUID in input string
      const directMatch = url.match(uuidRegex);
      if (directMatch) {
        const details = await getSongDetails(directMatch[0]);
        return res.json({ success: true, ...details });
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
            const details = await getSongDetails(locMatch[0]);
            return res.json({
              success: true,
              resolvedUrl: location,
              ...details,
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
      const html = await followRes.text();

      if (followMatch) {
        const details = await getSongDetails(followMatch[0], html);
        return res.json({
          success: true,
          resolvedUrl: followRes.url,
          ...details,
        });
      }

      // 5. Check response HTML body for UUID
      const htmlMatch = html.match(uuidRegex);
      if (htmlMatch) {
        const details = await getSongDetails(htmlMatch[0], html);
        return res.json({
          success: true,
          ...details,
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
