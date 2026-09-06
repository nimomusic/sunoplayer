// Vercel Serverless Function for /api/resolve-suno
export default async function handler(req: any, res: any) {
  // CORS 헤더 설정
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const inputUrl =
      (req.query && (req.query.url as string)) ||
      (req.body && (req.body.url as string)) ||
      "";

    if (!inputUrl || typeof inputUrl !== "string") {
      return res.status(400).json({ success: false, error: "URL이 누락되었습니다." });
    }

    let url = inputUrl.trim();
    const uuidRegex = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
    const B62_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

    function base62ToUuid(b62Str: string): string | null {
      try {
        const trimmed = b62Str.trim();
        if (!/^[0-9a-zA-Z]{21,22}$/.test(trimmed)) return null;
        let num = 0n;
        for (let i = 0; i < trimmed.length; i++) {
          const char = trimmed[i];
          const val = BigInt(B62_CHARS.indexOf(char));
          if (val < 0n) return null;
          num = num * 62n + val;
        }
        const hex = num.toString(16).padStart(32, "0");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toLowerCase();
      } catch (e) {
        return null;
      }
    }

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    // Helper to fetch song details (title, artist, handle, tags, cover image, direct audio URL)
    async function getSongDetails(songId: string, preloadedHtml?: string) {
      const normalizedId = songId.toLowerCase();
      let html = preloadedHtml;
      if (!html) {
        try {
          const pageRes = await fetch(`https://suno.com/song/${normalizedId}`, { headers });
          html = await pageRes.text();
        } catch (e) {
          console.warn("Failed to fetch song page for metadata:", e);
        }
      }

      let title = "";
      let artist = "";
      let handle = "";
      let tags = "";
      let imageUrl = `https://cdn2.suno.ai/image_large_${normalizedId}.jpeg`;
      let audioUrl = "";

      if (html) {
        // 1. Title & Artist from Next.js children tag: "Title by Artist | Suno"
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
            `https://studio-api-prod.suno.com/api/oembed?url=https%3A%2F%2Fsuno.com%2Fsong%2F${normalizedId}`
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
        songId: normalizedId,
        title: title || `Suno Track (${normalizedId.slice(0, 8)})`,
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

    // 2. Base62 lossless string match
    const b62Uuid = base62ToUuid(url);
    if (b62Uuid) {
      const details = await getSongDetails(b62Uuid);
      return res.json({ success: true, ...details });
    }

    // 3. URL normalization
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      if (url.startsWith("s/") || url.startsWith("/s/")) {
        url = "https://suno.com/" + url.replace(/^\/+/, "");
      } else if (url.includes("suno.com") || url.includes("suno.ai")) {
        url = "https://" + url;
      } else if (/^[a-zA-Z0-9_-]{10,25}$/.test(url)) {
        url = `https://suno.com/s/${url}`;
      } else {
        url = "https://" + url;
      }
    }

    // 4. Fast manual redirect lookup (Suno /s/{code} -> HTTP 307 location: /song/{uuid})
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
      console.warn("Manual redirect warning:", manualErr);
    }

    // 5. Follow redirect lookup
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

    // 6. Check response HTML body for UUID
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
    console.error("Vercel Serverless resolve error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Suno 링크 분석 중 오류가 발생했습니다.",
    });
  }
}
