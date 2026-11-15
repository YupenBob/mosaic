# Round 5 UX decisions

- **FEED-03:** The vertical feed stays video-only. Gallery-only and music-only posts remain available through cards and the note modal. Mixed posts participate when they have playable video sources. Supporting other slide types needs a separate playback and navigation design; it is outside this defect fix.
- **FEED-02:** Opening and navigating the feed replace the current URL's `feed` query parameter with the active slug, preserving other parameters and history state. Reloading a valid video slug reopens that slide. Closing removes the parameter. Slide changes do not add browser history entries; unknown or non-video slugs do not automatically open the feed.
- **FEED-01:** Desktop feed content occupies a centered portrait column. Clicking the surrounding backdrop dismisses it and restores entry focus. Slide and control clicks stay inside the feed. On narrow screens the content fills the width.
- **NOTE-02:** Keep the visual position dots and add a small numeric `aria-live="polite"` counter, updated by the existing carousel state handler for buttons, keyboard and swipes. Single-item notes need no counter.
- **Gallery verification:** The shared fixture JPEG is 96×64 pixels, smaller than the viewer even at the tested zoom levels. Gallery zoom journeys substitute a 1920×1080 synthetic image so cursor anchoring and edge-clamped mouse/touch panning can be exercised. The broken-image journey still aborts the original fixture request.

Verification evidence is generated under `qa/reports/round-9/{feed,note,gallery}-fixtures/`.

Round-9 results: feed **5/5**, note **6/6**, gallery **12/12**, with no page JavaScript errors or skipped journeys. The reports retain fixture HTTP 404 messages and deliberately aborted photo requests from the broken-image journey.

ESLint (`src tests/ux`, plus `tests/experience-local.mjs`), Prettier on changed files, the production build, and `frontend-local`, `cards-media`, `experience-local`, and `local-e2e` regressions passed. Frontend, cards/media and experience checks exercised local Chromium and WebKit; local-e2e passed all four checks after the build.

This host's bundled Playwright Chromium has no H.264 decoder. Run the experience regression with `PW_CHROMIUM=/snap/bin/chromium node tests/experience-local.mjs` to use the installed Chromium with codec support. The launcher accepts this override; playback assertions remain unchanged. The music journey's undeclared test globals were qualified with `window` so the required full UX lint command passes.
