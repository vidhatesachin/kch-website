// Cloudflare Pages Function — GET /api/youtube
// Place this file at: functions/api/youtube.js in your repo root
// (Cloudflare Pages auto-routes /api/youtube to this file's onRequestGet)

const CHANNEL_ID = "UCKyOZpmOSAFw-_-QfBoJXuQ";
const UPLOADS_PLAYLIST_ID = "UUKyOZpmOSAFw-_-QfBoJXuQ";
const CACHE_TTL_SECONDS = 1800; // 30 minutes
const MAX_RESULTS = 24;

export async function onRequestGet(context) {
  const { env } = context;
  const apiKey = env.YOUTUBE_API_KEY;

  if (!apiKey) {
    return json({ error: "YOUTUBE_API_KEY not configured" }, 500);
  }

  // Serve from Cloudflare edge cache if present
  const cache = caches.default;
  const cacheKey = new Request("https://internal-cache/api/youtube");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${UPLOADS_PLAYLIST_ID}&maxResults=${MAX_RESULTS}&key=${apiKey}`;
    const playlistRes = await fetch(playlistUrl);
    if (!playlistRes.ok) {
      const errBody = await safeJson(playlistRes);
      return json({ error: "YouTube playlistItems request failed", details: errBody }, 502);
    }
    const playlistData = await playlistRes.json();
    const items = playlistData.items || [];
    if (!items.length) {
      const empty = json({ videos: [] });
      context.waitUntil(cache.put(cacheKey, empty.clone(), { expirationTtl: CACHE_TTL_SECONDS }));
      return empty;
    }

    const videoIds = items.map(it => it.contentDetails.videoId).join(",");

    // Fetch durations to classify Shorts (<= 60s) vs regular videos
    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${videoIds}&key=${apiKey}`;
    const videosRes = await fetch(videosUrl);
    if (!videosRes.ok) {
      const errBody = await safeJson(videosRes);
      return json({ error: "YouTube videos request failed", details: errBody }, 502);
    }
    const videosData = await videosRes.json();
    const durationById = {};
    (videosData.items || []).forEach(v => {
      durationById[v.id] = parseISODurationSeconds(v.contentDetails.duration);
    });

    const videos = items
      .filter(it => it.contentDetails && it.contentDetails.videoId)
      .map(it => {
        const id = it.contentDetails.videoId;
        const snippet = it.snippet || {};
        const thumb = (snippet.thumbnails && (snippet.thumbnails.maxres || snippet.thumbnails.high || snippet.thumbnails.medium || snippet.thumbnails.default)) || {};
        const seconds = durationById[id] || 0;
        return {
          id,
          title: snippet.title || "",
          description: snippet.description || "",
          thumbnail: thumb.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          publishedAt: formatDate(snippet.publishedAt),
          type: seconds > 0 && seconds <= 60 ? "short" : "video"
        };
      })
      // Newest first (playlistItems already returns in upload order, but sort explicitly for safety)
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

    const response = json({ videos });
    context.waitUntil(cache.put(cacheKey, response.clone(), { expirationTtl: CACHE_TTL_SECONDS }));
    return response;
  } catch (err) {
    return json({ error: "Unexpected error", details: String(err) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "Access-Control-Allow-Origin": "*"
    }
  });
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function parseISODurationSeconds(iso) {
  // Parses ISO 8601 durations like PT1M30S, PT45S, PT2H3M
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const s = parseInt(m[3] || "0", 10);
  return h * 3600 + min * 60 + s;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}
