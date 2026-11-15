# Round 6 fixes and fixture decisions

- PLAYER-01 was a fixture authoring error: playlist mode requires `{{videos}}`, not independent `{{video:0}}` blocks. The corrected fixture exercises selection, auto-advance exactly once, and a single playing video. No player application code was changed for this defect.
- MUSIC-01 now shows an inline `role="alert"` in the music section for media errors or rejected play attempts. Play reloads a failed source for retry, and choosing another track remains available. Aborts caused by switching or pausing are ignored. Journeys exercise network and unsupported-media failures, successful retries, switching after failure, and absence of unhandled page errors.
- SEARCH-01 captures the initial browsing grid at filter initialization. Clearing the query, category, and all tags restores that slice, including card identity and order. Active queries and filters intentionally render matches from the site-wide index; they are not limited to the current pagination slice. Journeys cover the home page and page two, including combined filters. Superseded View Transition animations are treated as optional skipped animations so rapid query changes do not produce unhandled rejections.
- PAGINATION-01 adds `/page/2/` through the last generated home listing page to the sitemap using the same page count as HTML generation. Existing home, post, category, and tag locations remain. The site smoke test checks XML structure, absolute locations, existing post/taxonomy entries, and an actual generated pagination page.
- PAGINATION-02 was an invalid route expectation. The canonical tag route for `标签 空格` is `/tags/标签-空格/`, with UTF-8 percent encoding in URLs. The journey follows the generated slug; no alias route is added.

The revised fixture contains 65 posts, including the wallpaper post: pages contain 20, 20, 20, and 5 cards. The two music filenames and source URLs differ but use the same synthetic audio bytes. Broken HLS is a genuine fixture-server 404; the journey observes the response and records fallback versus visible error.

Remaining deliberate coverage gaps: fixture journeys use Chromium only; actual fullscreen state is not asserted beyond the request path; video seek uses the media element rather than a progress/keyboard interaction; the complete video keyboard/accessibility audit and paused-before-intent resume state remain unverified; history scroll restoration is recorded rather than guaranteed; sitemap journey checks are structural rather than a full XML schema validation. The site smoke test additionally checks balanced XML nesting and escaping.

Round 9 evidence is written under `qa/reports/round-9/{player,music,search,pagination}-fixtures/`. These report directories are ignored by Git.

Verification completed:

- `npx eslint src tests scripts`: passed.
- `npx prettier --check` for the changed source, tests, and documents: passed (Markdown is ignored by the repository's Prettier configuration).
- Round 9 fixture journeys: player 6/6, music 3/3, search 4/4, pagination 3/3; **16 passed, 0 failed, 0 skipped, 0 unhandled page errors**. Resource console errors from fixture 404s and deliberate media failures remain recorded in the JSON evidence.
- `node tests/site-smoke.mjs`: passed, including sitemap pagination assertions.
- `node tests/frontend-local.mjs`: passed in Chromium and WebKit.
- `node tests/experience-local.mjs`: WebKit passed; bundled Chromium timed out at the first real HLS playback assertion. Rerunning with the test's existing browser override, `PW_CHROMIUM=/snap/bin/chromium node tests/experience-local.mjs`, passed both engines, including cache/resume, early-click, fallback, and range checks. The system Chromium is also used by the fixture journeys. No assertions were weakened for this environment difference.

Files changed by this task:

- `src/assets/js/music.js`
- `src/assets/css/music.css`
- `src/assets/js/filter.js`
- `src/assets/js/cards/grid.js`
- `src/assets/js/search.js`
- `src/assets/js/motion/index.js`
- `scripts/site/render.mjs`
- `tests/site-smoke.mjs`
- `tests/ux/journeys/player-deep.spec.mjs`
- `tests/ux/journeys/music-deep.spec.mjs`
- `tests/ux/journeys/search-deep.spec.mjs`
- `tests/ux/journeys/pagination-deep.spec.mjs`
- `docs/qa/round-6-decisions.md`
- Ignored QA reports: the four Round 6 `findings.md` files and Round 9 per-area results, findings, JSON, and screenshots.

Pre-existing workspace changes were preserved. Nothing was committed, pushed, or deployed.
