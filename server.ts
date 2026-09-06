import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

// Base62 conversion utilities for 22-char lossless compressed UUIDs
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

const uuidRegex = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

const userAgentHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

interface SongDetails {
  songId: string;
  title: string;
  artist: string;
  handle: string;
  tags: string;
  imageUrl: string;
  audioUrl: string;
}

// In-memory cache to ensure instant (<5ms) responses for social media crawler bots
const songDetailsCache = new Map<string, SongDetails>();

/**
 * High-precision metadata parser for Suno songs
 * Extracts actual title, artist, handle, tags, image, and direct audio stream
 */
async function getSongDetails(songId: string, preloadedHtml?: string): Promise<SongDetails> {
  const normalizedId = songId.toLowerCase();
  if (songDetailsCache.has(normalizedId)) {
    return songDetailsCache.get(normalizedId)!;
  }

  let html = preloadedHtml;
  if (!html) {
    try {
      const pageRes = await fetch(`https://suno.com/song/${normalizedId}`, {
        headers: userAgentHeaders,
      });
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

  const result: SongDetails = {
    songId: normalizedId,
    title: title || `Suno Track (${normalizedId.slice(0, 8)})`,
    artist: artist || "Suno Creator",
    handle: handle || "",
    tags: tags || "",
    imageUrl,
    audioUrl,
  };

  songDetailsCache.set(normalizedId, result);
  return result;
}

/**
 * Resolve any input (UUID, short-code, suno.com URL) to a UUID and song details
 */
async function resolveSong(rawInput: string): Promise<{ resolvedUrl?: string; details: SongDetails } | null> {
  let url = rawInput.trim();

  // 1. Direct UUID match in input string
  const directMatch = url.match(uuidRegex);
  if (directMatch) {
    const details = await getSongDetails(directMatch[0]);
    return { details };
  }

  // 2. Base62 lossless 22-char string match
  const b62Uuid = base62ToUuid(url);
  if (b62Uuid) {
    const details = await getSongDetails(b62Uuid);
    return { details };
  }

  // 3. Normalizing Suno URLs and short codes
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

  // 4. Fast manual redirect lookup (Suno /s/{code} returns HTTP 307 with location: /song/{uuid})
  try {
    const manualRes = await fetch(url, {
      redirect: "manual",
      headers: userAgentHeaders,
    });

    const location = manualRes.headers.get("location");
    if (location) {
      const locMatch = location.match(uuidRegex);
      if (locMatch) {
        const details = await getSongDetails(locMatch[0]);
        return {
          resolvedUrl: location,
          details,
        };
      }
    }
  } catch (manualErr) {
    console.warn("Manual redirect fetch warning:", manualErr);
  }

  // 5. Follow redirect lookup
  try {
    const followRes = await fetch(url, {
      headers: userAgentHeaders,
    });

    const followMatch = followRes.url.match(uuidRegex);
    const html = await followRes.text();

    if (followMatch) {
      const details = await getSongDetails(followMatch[0], html);
      return {
        resolvedUrl: followRes.url,
        details,
      };
    }

    // 6. Check response HTML body for UUID
    const htmlMatch = html.match(uuidRegex);
    if (htmlMatch) {
      const details = await getSongDetails(htmlMatch[0], html);
      return { details };
    }
  } catch (followErr) {
    console.warn("Follow redirect fetch warning:", followErr);
  }

  return null;
}

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Injects actual song title into the Black box (og:title / twitter:title)
 * and the shared Suno song image into the Red box (og:image / twitter:image)
 * of the SNS preview card.
 */
function injectSongMeta(html: string, meta: SongDetails): string {
  const songTitle = meta.title || `Suno Track (${meta.songId.slice(0, 8)})`;
  const artistName = meta.artist || "Suno Creator";
  const songImage = meta.imageUrl || `https://cdn2.suno.ai/image_large_${meta.songId}.jpeg`;
  const pageTitle = `${songTitle} - ${artistName} | Suno 즉석 플레이어`;

  // 검정색 부분: 곡 제목 (og:title, twitter:title)
  const shareTitle = songTitle;

  // 붉은색 부분: 공유한 수노곡의 이미지 (og:image, twitter:image)
  const shareImage = songImage;

  // 공유 카드 하단 설명 문구
  const shareDesc = "프롬프트 노출없이 쉽고 빠르게 공유";

  let result = html;

  // 1. <title> 태그 교체
  result = result.replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(pageTitle)}</title>`);

  // 2. Open Graph 태그 교체 (카카오톡, 페이스북, 디스코드 등)
  result = result.replace(
    /<meta\s+property=["']og:title["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="og:title" content="${escapeHtml(shareTitle)}" />`
  );
  result = result.replace(
    /<meta\s+property=["']og:description["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="og:description" content="${escapeHtml(shareDesc)}" />`
  );
  result = result.replace(
    /<meta\s+property=["']og:image["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="og:image" content="${escapeHtml(shareImage)}" />`
  );

  // 3. Twitter 카드 메타태그 교체
  result = result.replace(
    /<meta\s+(?:property|name)=["']twitter:title["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="twitter:title" content="${escapeHtml(shareTitle)}" />`
  );
  result = result.replace(
    /<meta\s+(?:property|name)=["']twitter:description["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="twitter:description" content="${escapeHtml(shareDesc)}" />`
  );
  result = result.replace(
    /<meta\s+(?:property|name)=["']twitter:image["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta property="twitter:image" content="${escapeHtml(shareImage)}" />`
  );

  // 4. 일반 description 메타태그 교체
  result = result.replace(
    /<meta\s+name=["']description["']\s+content=["'][^"']*["']\s*\/?>/i,
    `<meta name="description" content="${escapeHtml(shareDesc)}" />`
  );

  // 5. HTML 초기 렌더링 시 깜빡임 방지를 위해 본문 내 초기 텍스트 및 이미지도 동적 주입
  result = result.replace(
    /id="popup-song-title"[^>]*>([^<]*)<\/h3>/i,
    `id="popup-song-title" title="${escapeHtml(songTitle)}" class="text-base sm:text-lg font-bold text-white tracking-tight truncate select-text">${escapeHtml(songTitle)}</h3>`
  );
  result = result.replace(
    /id="popup-song-artist"[^>]*>([^<]*)<\/span>/i,
    `id="popup-song-artist" class="text-rose-400 font-semibold truncate max-w-[180px] sm:max-w-[220px]">${escapeHtml(artistName)}</span>`
  );
  result = result.replace(
    /id="popup-cover-img"\s+src="[^"]*"/i,
    `id="popup-cover-img" src="${escapeHtml(songImage)}"`
  );

  return result;
}

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

      const result = await resolveSong(inputUrl);
      if (result) {
        return res.json({
          success: true,
          resolvedUrl: result.resolvedUrl,
          ...result.details,
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

  // Vite development middleware initialization
  let vite: any = null;
  if (process.env.NODE_ENV !== "production") {
    vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
  }

  // Open Graph dynamic meta injection for shared song links (KakaoTalk, Twitter, Facebook, etc.)
  app.get("*", async (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith("/api")) return next();
    // Skip static assets
    if (/\.(js|css|json|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map)$/i.test(req.path)) {
      return next();
    }

    let songQuery = (req.query.s || req.query.id || req.query.url || req.query.suno) as string;
    if (!songQuery) {
      const matchS = req.path.match(/^\/s\/([a-zA-Z0-9_-]+)/);
      const matchSong = req.path.match(/^\/song\/([a-zA-Z0-9_-]+)/);
      if (matchS) songQuery = matchS[1];
      else if (matchSong) songQuery = matchSong[1];
    }
    if (!songQuery || typeof songQuery !== "string") {
      return next();
    }

    try {
      const resolved = await resolveSong(songQuery);
      if (!resolved) {
        return next();
      }

      let template = "";
      if (process.env.NODE_ENV !== "production" && vite) {
        const indexPath = path.resolve(process.cwd(), "index.html");
        template = fs.readFileSync(indexPath, "utf-8");
        template = await vite.transformIndexHtml(req.originalUrl, template);
      } else {
        const distPath = path.resolve(process.cwd(), "dist", "index.html");
        template = fs.existsSync(distPath)
          ? fs.readFileSync(distPath, "utf-8")
          : fs.readFileSync(path.resolve(process.cwd(), "index.html"), "utf-8");
      }

      const htmlWithMeta = injectSongMeta(template, resolved.details);
      return res.status(200).set({ "Content-Type": "text/html; charset=utf-8" }).send(htmlWithMeta);
    } catch (err) {
      console.error("OG injection middleware warning:", err);
      return next();
    }
  });

  // Vite middleware for dev or static files for prod
  if (vite) {
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
