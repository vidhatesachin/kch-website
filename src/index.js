// Cloudflare Worker entry point (Workers-with-static-assets pattern)
// Place at: src/index.js in your repo root, alongside wrangler.toml (repo root).
// Serves your existing static site via the ASSETS binding, and handles /api/youtube itself.

const CHANNEL_ID = "UCKyOZpmOSAFw-_-QfBoJXuQ";
const UPLOADS_PLAYLIST_ID = "UUKyOZpmOSAFw-_-QfBoJXuQ";
const CACHE_TTL_SECONDS = 1800; // 30 minutes
const MAX_RESULTS = 24;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/youtube") {
      return handleYoutube(env, ctx);
    }
    if (url.pathname === "/api/reviews") {
      return handleReviews(env, ctx);
    }
    // Everything else: serve the static site exactly as before
    return env.ASSETS.fetch(request);
  }
};

const PLACE_ID = "ChIJAQDEZR-5wjsRWp34KGm5guU";
const REVIEWS_CACHE_TTL_SECONDS = 21600; // 6 hours

async function handleReviews(env, ctx) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return json({ error: "GOOGLE_PLACES_API_KEY not configured" }, 500);
  }

  const cache = caches.default;
  const cacheKey = new Request("https://internal-cache/api/reviews-v2");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const placeUrl = `https://places.googleapis.com/v1/places/${PLACE_ID}?languageCode=en`;
    const res = await fetch(placeUrl, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "id,displayName,rating,userRatingCount,googleMapsUri,reviews.rating,reviews.text,reviews.originalText,reviews.authorAttribution,reviews.relativePublishTimeDescription,reviews.publishTime"
      }
    });
    if (!res.ok) {
      const errBody = await safeJson(res);
      return json({ error: "Google Places request failed", details: errBody }, 502);
    }
    const data = await res.json();
    const reviews = (data.reviews || []).map(r => ({
      author: (r.authorAttribution && r.authorAttribution.displayName) || "Google user",
      photo: (r.authorAttribution && r.authorAttribution.photoUri) || "",
      rating: r.rating || 5,
      text: (r.text && r.text.text) || (r.originalText && r.originalText.text) || "",
      relativeTime: r.relativePublishTimeDescription || ""
    }));

    const response = json({
      rating: data.rating || null,
      userRatingCount: data.userRatingCount || 0,
      mapsUri: data.googleMapsUri || `https://search.google.com/local/reviews?placeid=${PLACE_ID}`,
      reviews
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone(), { expirationTtl: REVIEWS_CACHE_TTL_SECONDS }));
    return response;
  } catch (err) {
    return json({ error: "Unexpected error", details: String(err) }, 500);
  }
}

async function handleYoutube(env, ctx) {
  const apiKey = env.YOUTUBE_API_KEY;
  if (!apiKey) {
    return json({ error: "YOUTUBE_API_KEY not configured" }, 500);
  }

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
      ctx.waitUntil(cache.put(cacheKey, empty.clone(), { expirationTtl: CACHE_TTL_SECONDS }));
      return empty;
    }

    const videoIds = items.map(it => it.contentDetails.videoId).join(",");
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
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

    const response = json({ videos });
    ctx.waitUntil(cache.put(cacheKey, response.clone(), { expirationTtl: CACHE_TTL_SECONDS }));
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
