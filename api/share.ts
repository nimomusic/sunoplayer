import fs from "fs";
import path from "path";

// Vercel Serverless Function to serve HTML with dynamic OG tags for shared Suno songs
export default async function handler(req: any, res: any) {
  try {
    const query = req.query || {};
    const songParam = (query.s || query.id || query.url || query.suno) as string;

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

    let songId: string | null = null;
    if (songParam) {
      const trimmed = songParam.trim();
      const directUuid = trimmed.match(uuidRegex);
      if (directUuid) {
        songId = directUuid[0].toLowerCase();
      } else {
        const b62 = base62ToUuid(trimmed);
        if (b62) {
          songId = b62;
        } else {
          // Attempt short link resolution
          try {
            const shortRes = await fetch(`https://suno.com/s/${trimmed}`, {
              redirect: "manual",
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              },
            });
            const loc = shortRes.headers.get("location");
            if (loc) {
              const locMatch = loc.match(uuidRegex);
              if (locMatch) songId = locMatch[0].toLowerCase();
            }
          } catch (e) {}
        }
      }
    }

    // Default template reading with robust multiple fallback search paths
    let template = "";
    const cwd = process.cwd();
    const possiblePaths = [
      path.join(cwd, "dist", "index.html"),
      path.join(cwd, "index.html"),
      path.join(cwd, "public", "index.html"),
    ];
    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          template = fs.readFileSync(p, "utf-8");
          if (template) break;
        }
      } catch (e) {}
    }

    // Details resolution
    let title = "";
    let artist = "Suno Creator";
    let imageUrl = songId ? `https://cdn2.suno.ai/image_large_${songId}.jpeg` : "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=1200&auto=format&fit=crop&q=80";

    if (songId) {
      try {
        const pageRes = await fetch(`https://suno.com/song/${songId}`, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        if (pageRes.ok) {
          const html = await pageRes.text();

          const pageTitleMatch =
            html.match(/\\?"children\\?":\s*\\?"([^\\"]+?)\s+by\s+([^\\"]+?)\s+\|\s*Suno\\?"/i) ||
            html.match(/<title>([^<]+?)\s+by\s+([^<]+?)\s+\|\s*Suno<\/title>/i);
          if (pageTitleMatch) {
            title = pageTitleMatch[1].trim();
            artist = pageTitleMatch[2].trim();
          }

          const descMatch =
            html.match(/name\\?":\s*\\?"description\\?",\s*\\?"content\\?":\s*\\?"([^\\"]+)\\?"/i) ||
            html.match(/<meta[^>]+name=["\\]*description["\\]*[^>]+content=["\\]*([^"\\>]+)["\\]*/i);
          if (descMatch && descMatch[1]) {
            const parsedDesc = descMatch[1].match(/^(.+?)\s+by\s+(.+?)(?:\s+\(@([^\)]+)\))?(?:\.|\s+Listen|$)/i);
            if (parsedDesc) {
              if (!title) title = parsedDesc[1].trim();
              if (!artist) artist = parsedDesc[2].trim();
            }
          }

          const imgMatch =
            html.match(/(?:og:image|twitter:image)\\?"\s*,\s*\\?"content\\?"\s*:\s*\\?"([^\\"]+)\\?"/i) ||
            html.match(/image_large_url\\?":\s*\\?"(https:\/\/[^\\"]+)\\?"/i);
          if (imgMatch && imgMatch[1]) {
            imageUrl = imgMatch[1].trim().replace(/\\\//g, "/");
          }
        }
      } catch (e) {}

      if (!title) {
        try {
          const oembedRes = await fetch(
            `https://studio-api-prod.suno.com/api/oembed?url=https%3A%2F%2Fsuno.com%2Fsong%2F${songId}`
          );
          if (oembedRes.ok) {
            const oembed = await oembedRes.json();
            if (oembed.title) title = oembed.title.trim();
          }
        } catch (e) {}
      }
    }

    const songTitle = songId ? (title || `Suno Track (${songId.slice(0, 8)})`) : "Suno 즉석 플레이어";
    const displayArtist = artist || "Suno Creator";
    const shareDesc = songId ? "프롬프트 노출없이 쉽고 빠르게 공유" : "Suno음악을 프롬프트 노출없이 재생";

    function escapeHtml(str: string) {
      return (str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    // If template file could not be read from lambda disk, use embedded resilient HTML shell
    if (!template) {
      template = `<!doctype html>
<html lang="ko" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(songTitle)} - ${escapeHtml(displayArtist)} | Suno 즉석 플레이어</title>
    <meta name="description" content="${escapeHtml(shareDesc)}" />

    <!-- Open Graph (OG) 소셜 미디어 메타태그 (카카오톡, 페이스북, 디스코드 등) -->
    <meta property="og:title" content="${escapeHtml(songTitle)}" />
    <meta property="og:description" content="${escapeHtml(shareDesc)}" />
    <meta property="og:type" content="music.song" />
    <meta property="og:image" content="${escapeHtml(imageUrl)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="1200" />
    <meta property="og:site_name" content="Suno 즉석 플레이어" />

    <!-- Twitter 카드 메타태그 -->
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:title" content="${escapeHtml(songTitle)}" />
    <meta property="twitter:description" content="${escapeHtml(shareDesc)}" />
    <meta property="twitter:image" content="${escapeHtml(imageUrl)}" />

    <meta http-equiv="refresh" content="0; url=/?${songId ? `id=${encodeURIComponent(songId)}` : ''}" />
    <script>
      window.location.replace("/?" + ${JSON.stringify(songId ? `id=${encodeURIComponent(songId)}` : '')});
    </script>
  </head>
  <body class="bg-slate-950 text-white flex items-center justify-center min-h-screen font-sans">
    <div class="text-center p-6 space-y-4">
      <img src="${escapeHtml(imageUrl)}" alt="Cover" class="w-32 h-32 mx-auto rounded-2xl shadow-xl object-cover" />
      <h1 class="text-xl font-bold">${escapeHtml(songTitle)}</h1>
      <p class="text-slate-400 text-sm">by ${escapeHtml(displayArtist)}</p>
      <p class="text-xs text-rose-400">Suno 플레이어로 연결 중...</p>
    </div>
  </body>
</html>`;
    } else if (songId) {
      // Replace existing template OG meta tags
      template = template.replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(songTitle)} - ${escapeHtml(displayArtist)} | Suno 즉석 플레이어</title>`);
      template = template.replace(/<meta\s+property=["']og:title["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta property="og:title" content="${escapeHtml(songTitle)}" />`);
      template = template.replace(/<meta\s+property=["']og:description["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta property="og:description" content="${escapeHtml(shareDesc)}" />`);
      template = template.replace(/<meta\s+property=["']og:image["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`);
      template = template.replace(/<meta\s+name=["']description["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta name="description" content="${escapeHtml(shareDesc)}" />`);
      template = template.replace(/<meta\s+(?:property|name)=["']twitter:title["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta property="twitter:title" content="${escapeHtml(songTitle)}" />`);
      template = template.replace(/<meta\s+(?:property|name)=["']twitter:description["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta property="twitter:description" content="${escapeHtml(shareDesc)}" />`);
      template = template.replace(/<meta\s+(?:property|name)=["']twitter:image["']\s+content=["'][^"']*["']\s*\/?>/i, `<meta property="twitter:image" content="${escapeHtml(imageUrl)}" />`);

      // Pre-render body elements for instant hydration without flashing
      template = template.replace(
        /id="popup-song-title"[^>]*>([^<]*)<\/h3>/i,
        `id="popup-song-title" title="${escapeHtml(songTitle)}" class="text-base sm:text-lg font-bold text-white tracking-tight truncate select-text">${escapeHtml(songTitle)}</h3>`
      );
      template = template.replace(
        /id="popup-song-artist"[^>]*>([^<]*)<\/span>/i,
        `id="popup-song-artist" class="text-rose-400 font-semibold truncate max-w-[180px] sm:max-w-[220px]">${escapeHtml(displayArtist)}</span>`
      );
      template = template.replace(
        /id="popup-cover-img"\s+src="[^"]*"/i,
        `id="popup-cover-img" src="${escapeHtml(imageUrl)}"`
      );
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    return res.status(200).send(template);
  } catch (err: any) {
    return res.status(500).send(err.message || "Internal error");
  }
}
