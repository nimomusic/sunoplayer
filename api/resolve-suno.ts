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

    // 1. 입력값 자체에 UUID가 포함되어 있는 경우
    const directMatch = url.match(uuidRegex);
    if (directMatch) {
      return res.json({ success: true, songId: directMatch[0].toLowerCase() });
    }

    // 2. URL 표준화 (https 누락 또는 단축코드 형태 보정)
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      if (url.startsWith("s/") || url.startsWith("/s/")) {
        url = "https://suno.com/" + url.replace(/^\/+/, "");
      } else if (url.includes("suno.com") || url.includes("suno.ai")) {
        url = "https://" + url;
      } else if (/^[a-zA-Z0-9_-]{10,25}$/.test(url)) {
        // 'fo27V3FIRHDQTrmk' 같은 순수 단축코드인 경우
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

    // 3. 빠른 수동 리디렉트 조회 (Suno /s/{code} -> HTTP 307 location: /song/{uuid})
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
      console.warn("Manual redirect warning:", manualErr);
    }

    // 4. 자동 리디렉트 추적 조회
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

    // 5. 응답 본문(HTML) 내부에서 UUID 탐색
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
    console.error("Vercel Serverless resolve error:", err);
    return res.status(500).json({
      success: false,
      error: err.message || "Suno 링크 분석 중 오류가 발생했습니다.",
    });
  }
}
