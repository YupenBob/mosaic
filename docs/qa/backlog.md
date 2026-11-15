# QA backlog — blocked behaviors

Status: catalogued, intentionally not asserted yet. Behavior facts live in
`docs/qa/behaviors.json` (regenerate via `node scripts/qa/merge-catalog.mjs`); this page
is curated and updated when an item moves to pass.

Total: **81** blocked / 344 cataloged behaviors.

## admin (44)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| AD-06 | Draft body and slug payload | Draft body and slug payload |
| AD-07 | Draft category and tags payload | Draft category and tags payload |
| AD-08 | Publish new post and success toast | Publish new post and success toast |
| AD-10 | Editor reload guard | Editor reload guard |
| AD-12 | Command palette filters and navigates | Command palette filters and navigates |
| AD-16 | Posts sort and pagination | Posts sort and pagination |
| AD-21 | Draft preview and publish success UI | Draft preview and publish success UI |
| AD-23 | Library delete typed confirmation | Library delete typed confirmation |
| AD-24 | Upload progress | Upload progress |
| AD-25 | Upload fallback | Upload fallback |
| AD-26 | Library upload job retry and cancel | Library upload job retry and cancel |
| AD-29 | Rename category and tag | Rename category and tag |
| AD-30 | Delete taxonomy with confirmation | Delete taxonomy with confirmation |
| AD-36 | Enhancement toggle and dirty guard | Enhancement toggle and dirty guard |
| AD-40 | Build progress polling and cancel | Build progress polling and cancel |
| AD-47 | Task badge counts update | Task badge counts update |
| AD-50 | Cleanup dry-run POST | Cleanup dry-run POST |
| AD-56 | Session expiry no infinite spinner | Session expiry no infinite spinner |
| AD-58 | Post publish success toast | Post publish success toast |
| ADR-06 | Draft body and slug payload | Draft body and slug payload |
| ADR-07 | Draft category and tags payload | Draft category and tags payload |
| ADR-08 | Publish new post and success toast | Publish new post and success toast |
| ADR-10 | Editor reload guard | Editor reload guard |
| ADR-12 | Command palette filters and navigates | Command palette filters and navigates |
| ADR-16 | Posts sort and pagination | Posts sort and pagination |
| ADR-21 | Draft preview and publish success UI | Draft preview and publish success UI |
| ADR-23 | Library delete typed confirmation | Library delete typed confirmation |
| ADR-24 | Upload progress | Upload progress |
| ADR-25 | Upload fallback | Upload fallback |
| ADR-26 | Library upload job retry and cancel | Library upload job retry and cancel |
| ADR-29 | Rename category and tag | Rename category and tag |
| ADR-30 | Delete taxonomy with confirmation | Delete taxonomy with confirmation |
| ADR-36 | Enhancement toggle and dirty guard | Enhancement toggle and dirty guard |
| ADR-40 | Build progress polling and cancel | Build progress polling and cancel |
| ADR-47 | Task badge counts update | Task badge counts update |
| ADR-56 | Session expiry no infinite spinner | Session expiry no infinite spinner |
| ADR-58 | Post publish success toast | Post publish success toast |
| ADX-08 | Publish success and reset | POST and navigation verified; success toast and all requested reset state not independently asserted. |
| ADX-16 | Posts pagination and sort | Design gap: posts list renders all rows and sorts locally; no server pagination/sort request. Tracked in docs/qa/round-10-decisions.md |
| ADX-23 | Library delete and orphan cover | Usage warning, DELETE force query and removal exercised; typed confirmation absent, orphan cover untested. |
| ADX-24 | Direct upload progress | Presign 404 and direct POST, running and ready states exercised; row failure/retry and cancellation not exercised. |
| ADX-30 | Category and tag deletes | Count confirmation and payloads verified; nested category with children not exercised. |
| ADX-36 | Enhance toggle | Design gap: Enhance is a processing form, not a persistent settings toggle; tracked in docs/qa/round-10-decisions.md |
| ADX-40 | Build polling, cancel and history | Start, refresh, cancel, history detail and 2s after leaving exercised; staged automatic polling not verified. |

## edge (10)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| E-08 | Broken card images preserve layout | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-09 | Video manifest and segment failures | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-10 | Offline after loading and reconnect | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-11 | Offline from start | No offline-first requirement: a cold offline navigation shows the browser error page |
| E-12 | Rapid theme, note and like interactions | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-13 | Unknown and malformed deep links | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-15 | History and scroll across search category and post | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-16 | Keyboard escape and tab during modal animation | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-17 | Slow data and HTML failure | Graceful degradation and recovery without crashes or unsafe reflection. |
| E-19 | Production headers and data exposure | Safe validation, expected response codes and no stack disclosure. |

## media (5)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| C-12 | Playlist items listed | Playlist items listed |
| C-14 | Playlist auto-advance | Playlist auto-advance |
| C-23 | Music playback advances | Music playback advances |
| C-24 | Music track selection | Music track selection |
| C-25 | Music waveform renders | Music waveform renders |

## music (2)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| MU-01 | Two fixture tracks have identical file/source metadata; active-index change was observed b | Requested coverage |
| MU-02 | Error check tests presence of an alert/error element; no pageerror was observed. | Requested coverage |

## pagination (4)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| PG-01 | Back navigation reported scroll 133 after 500 before navigation; timing/restoration behavi | Requested coverage |
| PG-02 | 404 checks and remaining sitemap taxonomy checks were not reached after sitemap assertion  | Requested coverage |
| PG-03 | Header active state was only recorded for nested category; space tag check returned 404. | Requested coverage |
| PG-04 | Sitemap checks cover url/loc balance, not a full strict XML validation. | Requested coverage |

## player (6)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| PL-01 | WebKit blocked: runner only provides Chromium. | Requested coverage |
| PL-02 | Playlist auto-advance and one-playing assertion blocked by PLAYER-01. | Requested coverage |
| PL-03 | Fullscreen request path was instrumented; actual fullscreen state not verified. | Requested coverage |
| PL-04 | Seek was set on media element, not progress/keyboard; keyboard navigation and complete acc | Requested coverage |
| PL-05 | Broken HLS path forced to 404 because fixture server serves any master.m3u8 basename. Outc | Requested coverage |
| PL-06 | Resume checked after play intent; paused state after reload was not separately checked. | Requested coverage |

## post (1)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| G-106 | Music post playback | Music post can be played if one exists |

## search (2)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| SE-01 | Fixture has no 壁纸-tagged post, so matching-result part of IME check is blocked. | Requested coverage |
| SE-02 | Keyboard Enter navigation was not reached after SEARCH-01; case counts were recorded but e | Requested coverage |

## security (5)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| E-802 | Query, route and DOM injection | Query, route and DOM injection |
| E-806 | Media site-data privacy residual | Known residual: media-domain site-data/* stays public until the WAF rollout (needs CLOUDFLARE_ZONE_ID) |
| E-807 | Thirty-request rate limit | Thirty-request rate limit |
| E-808 | Unknown asset ID validation | Unknown asset ID validation |
| E-809 | Malicious category and tag fixture values | Malicious category and tag fixture values |

## visitor (2)

| ID | Behavior | Unblock condition / decision |
| --- | --- | --- |
| V-51 | Empty category state | Empty category state |
| V-76 | Locale switch | Locale switch |

