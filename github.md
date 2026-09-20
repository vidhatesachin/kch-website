repo: vidhatesachin/kch-website
branch: main

## Last sync
date: 2026-09-20T11:54:55Z

### Updated in this project
- Cloudflare Worker `/api/youtube` endpoint (src/index.js + wrangler.toml) fetching the channel's uploads playlist, classifying Shorts vs Videos, edge-cached 30 min
- Videos section frontend (filter tabs, thumbnail grid, modal player) wired to `fetch('/api/youtube')` with a graceful fallback card
- Full site rebuild on the Modernist design system (nav, hero slider, doctors, conditions, consultations, locations, testimonials, appointment form)

## Screen map
| Project screen | Repo files |
| --- | --- |
| Main site | index.html, Krishna Classical Homoeopathy.dc.html, support.js, image-slot.js, assets/, _ds/ |
| YouTube videos API | src/index.js, wrangler.toml |
