# Gallery Import Research: Printables, MakerWorld, Thingiverse (verified 2026-07-04)

All "live-verified" claims below were tested today with plain `curl` from this machine (no browser, no cookies).

---

## 1. Printables (Prusa)

### API availability
- **No official/public API.** Prusa staff have acknowledged requests but never shipped one ([Prusa forum thread](https://forum.prusa3d.com/forum/english-forum-general-discussion-announcements-and-releases/printables-application-programmable-interface-api/)); Manyfold's Printables sync issue is labeled **blocked** for exactly this reason ([manyfold#4530](https://github.com/manyfold3d/manyfold/issues/4530), opened 2025-07-22).
- **However, the private GraphQL API the SPA uses is openly reachable and unauthenticated**: `POST https://api.printables.com/graphql/` (moved there from `www.prusaprinters.org/graphql/`; [Prusa forum: "GraphQL moved?"](https://forum.prusa3d.com/forum/english-forum-general-discussion-announcements-and-releases/graphql-moved/)).
- **Live-verified today, anonymously (only a browser-like User-Agent header needed):**
  - Metadata query `query { print(id: "3161") { name description license { name } tags { name } user { publicUsername } images { filePath } stls { id name fileSize } gcodes { id name } datePublished } }` returned full JSON for the 3DBenchy model: name, HTML description, `license.name` ("Creative Commons — Public Domain"), tags, author `publicUsername`, image `filePath`s, STL/gcode file lists with IDs and sizes.
  - Download mutation `mutation GetDownloadLink($id, $modelId, $fileType: DownloadFileTypeEnum!, $source: DownloadSourceEnum!) { getDownloadLink(id:…, printId:…, fileType:…, source:…) { ok output { link count ttl } } }` with `fileType: "stl"`, `source: "model_detail"` returned `ok: true` and a **direct CDN link** `https://files.printables.com/media/prints/3161/stls/....stl` with `ttl: 86400` (24 h). No login, no captcha.
- Model ID = numeric prefix in the URL slug: `printables.com/model/3161-3d-benchy` → `3161`. Images resolve at `https://media.printables.com/{filePath}`. File categories in the schema: `stls`, `gcodes`, `slas`, `otherFiles`. Search uses the `searchPrints2` operation (query/limit/ordering: `best_match`, `popular`, `latest`, `rating`, `makes_count`).
- Caveats: schema is undocumented and can change without notice; the site fronts with Cloudflare (some tools use `cloudscraper` for HTML pages, but the GraphQL endpoint itself accepted plain curl today). Printables **Club/paid models require an authenticated JWT** (`Authorization: Bearer`) from a logged-in session — skip these for v1.

### Metadata retrievable
Title, slug, HTML description, author (handle + display name), license (structured object), tags, image paths, per-file name/size/ID, publish date, ratings/likes/download counts, print settings fields (nozzle, layer height, material are also in the `print` type used by community clients).

### Legal/ToS
Prusa's [General Terms and Conditions of Use](https://www.prusa3d.com/page/general-terms-and-conditions-of-use-of-the-prusa-websites_231226/) Art. 9.1 prohibits "manual or automated extraction of the contents of the Websites including scraping" and Art. 9.3 prohibits scripts causing "unreasonable burdens"; content is "intended for personal use" (Art. 9.2). A single-user importer doing one model per user action is low-burden but technically outside the ToS letter; models themselves carry per-model licenses (mostly CC family) that generally permit personal printing. See also [Printables ToS](https://www.prusa3d.com/page/terms-of-service-of-printables-com_231249/).

### Importers to learn from
- [GhostTypes/printables-cli-api](https://github.com/GhostTypes/printables-cli-api) (Python) — cleanest reference: exact GraphQL queries for search, file lists, and the `GetDownloadLink` mutation ([printables_api.py](https://github.com/GhostTypes/printables-cli-api/blob/main/printables_api.py)).
- [100prznt/PrintablesGraphQL](https://github.com/100prznt/PrintablesGraphQL) (C#) — print/user detail queries.
- [gerolori/printables-batch-downloader](https://github.com/gerolori/printables-batch-downloader) — Selenium-based (collections/library pages that need login), useful as fallback pattern.
- [probielodan/printables_downloader](https://github.com/probielodan/printables_downloader).

---

## 2. MakerWorld (Bambu Lab)

### API availability
- **No official public API** ([forum request thread](https://forum.bambulab.com/t/public-api-for-makerworld/52699)). Two unofficial surfaces exist:
  1. **`api.bambulab.com` (Bambu Cloud) — the practical route.** Community-documented in [Doridian/OpenBambuAPI cloud-http.md](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md) and the [Bambuddy MakerWorld integration docs](https://wiki.bambuddy.cool/features/makerworld/):
     - `GET https://api.bambulab.com/v1/design-service/design/{designId}` — **live-verified today, anonymous**: returned full JSON for design 24966 (`title`, `slug`, `summary` HTML, `coverUrl`, `license: "BY-NC"`, `tags`, `designCreator{handle,name,avatar,uid}`, counts, and `instances[]` = print profiles with `profileId`, `title`, `instanceFilaments`, `needAms`, `materialCnt`, `pictures`, `hasZipStl`, ratings). The `designId` is the numeric prefix of `makerworld.com/en/models/{id}-slug`. Also `isExclusive`, `isPointRedeemable`, `paidSetting` flags let you detect non-importable paid/exclusive models.
     - `GET https://api.bambulab.com/v1/iot-service/api/user/profile/{profileId}?model_id={modelId}` — returns `{url, name}` where `url` is a **presigned S3 CDN URL valid ~5 minutes**; **requires `Authorization: Bearer {Bambu Cloud accessToken}`**. Fetch immediately, don't cache the URL, don't follow redirects or normalize the query string (S3 signature is over exact bytes) — all per Bambuddy docs.
     - Auth: `POST https://api.bambulab.com/v1/user-service/user/login` (password or email verification code; `loginType: "verifyCode"` response means MFA-style code required). Tokens live **~90 days (~7,776,000 s)**; the documented `refreshtoken` endpoint currently returns 401, so plan for re-login. China region uses `bambulab.cn` hosts.
  2. **`makerworld.com/api/v1/design-service/...` (website API)** — e.g. `instance/{id}/f3mf` — is **cookie-gated behind Cloudflare** and effectively unusable server-side (Bambuddy explicitly deprecated it). `makerworld.com` HTML itself returned **HTTP 403 to curl today** (enterprise WAF: JS challenges/CAPTCHA — also reported by commercial scrapers like [Apify actors](https://apify.com/stealth_mode/makerworld-models-details-scraper) and [Automatio](https://automatio.ai/how-to-scrape/makerworld)). Search/browse needs browser session state; treat page scraping as a non-option.
- **Design recommendation:** metadata + thumbnails anonymously via `design-service`; downloads require the user to supply Bambu account credentials (we already need a Bambu account context for the A1 mini anyway, though LAN printing itself doesn't). Downloads are print-profile (.3mf / sliced .gcode.3mf) oriented; raw STL zips exist where `hasZipStl` is true.

### Metadata retrievable
Title, summary/description (HTML), creator (handle/name/avatar), license (short code, e.g. "BY-NC"), tags, categories, cover + per-plate image galleries, download/like/print counts, full print-profile list with filament requirements and AMS flag, NSFW flag.

### Legal/ToS
[MakerWorld Terms of Use](https://makerworld.com/en/user-agreement) explicitly prohibits any "deep-link, page-scrape, robot, spider or other automatic device, program, algorithm or methodology … to access, acquire, copy, reproduce, exploit or monitor any portion of the site," and Bambu reserves the right to pursue legal action. This is the strictest of the three. Using a user's own Bambu Cloud token to download models they could download in Bambu Studio is materially the same traffic the official slicer generates, but it is still unauthorized-API use under ToS — worst realistic outcome for a homelab user is account suspension. Per-model licenses (CC variants) govern the models themselves.

### Importers to learn from
- [Bambuddy MakerWorld integration](https://wiki.bambuddy.cool/features/makerworld/) — best documented working design (resolve URL → plate list → import; token handling; thumbnail proxying).
- [Doridian/OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) — endpoint reference incl. login and design/profile/project endpoints.
- [Maker-Management-Platform/agent](https://github.com/Maker-Management-Platform/agent) — Go implementation; MakerWorld downloader shipped in v1.1.0 ([issue #28](https://github.com/Maker-Management-Platform/agent/issues/28), closed). Companion browser extension [mmp-companion](https://github.com/Maker-Management-Platform/mmp-companion) imports "as you browse" (sidesteps WAF by running in the user's browser — a good fallback pattern for us).
- [coelacant1/Bambu-Lab-Cloud-API](https://github.com/coelacant1/Bambu-Lab-Cloud-API) — Bambu Cloud analysis/compat layer.

---

## 3. Thingiverse (UltiMaker)

### API availability
- **Official REST API, still operating.** Base `https://api.thingiverse.com`; docs at [thingiverse.com/developers](https://www.thingiverse.com/developers) with [Swagger](https://www.thingiverse.com/developers/swagger) and [FAQ](https://www.thingiverse.com/developers/faq) (note: the developer-portal HTML pages are behind Cloudflare — they 403'd WebFetch and served a JS challenge to curl today — but the **API endpoint itself answered curl with clean JSON**: unauthenticated `GET /things/763622` → `{"error":"Unauthorized access…","code":401,"type":"NO_TOKEN_PROVIDED"}`, live-verified today).
- **Registration:** create an app at `https://www.thingiverse.com/apps/create` (choose "Desktop app" for a personal token) → get Client ID, Client Secret, and an **App Token** usable directly for read access; OAuth only needed for write operations ([getting started](https://www.thingiverse.com/developers/getting-started), [womenin3dprinting guide](https://womenin3dprinting.org/how-to-use-the-thingiverse-api-basic-read-access/), [thingy_grabber README](https://github.com/cwoac/thingy_grabber)). Auth via `Authorization: Bearer {token}` header (what Manyfold does) or `?access_token=` query param.
- **Key endpoints:** `GET /things/{id}` (metadata; response includes `zip_data.files[]` and `zip_data.images[]` with **direct download URLs** — this is what Manyfold uses), `GET /things/{id}/files`, `GET /things/{id}/images`, `GET /users/{user}/things`. 
- **Rate limit: 300 calls per 5-minute window** ([Openverse issue #1793](https://github.com/WordPress/openverse/issues/1793); [older analysis](https://tarinoitadigitalisaatiosta.wordpress.com/2017/01/02/thingiverse-research-impossible-due-to-api-rate-limiting/)) — irrelevant for single-model imports.
- Reliability caveat: the API/site has a long history of flakiness and login-form breakage during token generation ([Openverse #1688](https://github.com/WordPress/openverse/issues/1688)); build retries and clear error surfacing.

### Metadata retrievable
Name, description, creator (name + public_url + avatar), tags, is_nsfw, images (multiple sizes), files with direct URLs, like/collect/download counts, and a license field — though notably **Manyfold marks `license: false`** in its Thingiverse capabilities (they don't trust/import it); plan to map Thingiverse's license strings manually.

### Legal/ToS
Official API with its own [Developer API Terms](https://www.thingiverse.com/legal/api) (Cloudflare-blocked to server fetch today; read in a browser): standard restrictions on redistribution/caching of content and attribution requirements. Personal-use downloading via your own app token is the sanctioned path — this is the only one of the three where importing is clearly ToS-compliant. Per-model CC licenses still govern reuse.

### Importers to learn from
- **Manyfold** ([manyfold3d/manyfold](https://github.com/manyfold3d/manyfold)) — production-quality reference. Import-by-URL shipped in [PR #4497](https://github.com/manyfold3d/manyfold/pull/4497) (paste URL into search box → background job). Importer code (verified via GitHub API today): `app/deserializers/integrations/{thingiverse,cults3d,my_mini_factory,thangs}/`. Their `ModelDeserializer#deserialize` fetches `things/{id}` and builds `file_urls` from `zip_data.images` + `zip_data.files`; `BaseDeserializer#fetch` uses Faraday with `Authorization: Bearer {SiteSettings.thingiverse_api_key}`. URL canonicalization + creator matching logic worth copying. (No Printables/MakerWorld support: [#4530](https://github.com/manyfold3d/manyfold/issues/4530) blocked.)
- [cwoac/thingy_grabber](https://github.com/cwoac/thingy_grabber) (Python, MIT, v0.10.5) — archival/sync semantics: re-run detects changed files, failed downloads quarantined for retry.
- [jamesgopsill/thingiverse-client-py](https://github.com/jamesgopsill/thingiverse-client-py), [python-thingiverse](https://pypi.org/project/python-thingiverse/), [makerbot/thingiverse-js](https://github.com/makerbot/thingiverse-js).

---

## Cross-cutting design implications for our importer

1. **Per-site adapter pattern** (Manyfold's deserializer model maps cleanly to a Python `Protocol`): `canonicalize(url) → site+id`, `fetch_metadata(id)`, `list_files(id)`, `resolve_download(file) → short-lived URL`, executed in the Celery worker with immediate streaming to the storage backend (MakerWorld URLs die in ~5 min; Printables in 24 h).
2. **Credentials per site:** Thingiverse = user-supplied app token (settings page); Printables = none for free models; MakerWorld = user's Bambu account login with verification-code flow + ~90-day token, needs re-auth UX.
3. **Fragility budget:** Thingiverse = official/stable; Printables GraphQL = undocumented but tolerant (works anonymously today); MakerWorld = metadata easy, downloads need Bambu token, HTML scraping impossible (WAF). Ship Thingiverse + Printables first; MakerWorld behind a "connect Bambu account" feature flag. A browser-extension "push to library" companion (mmp-companion pattern) is the robust escape hatch if either unofficial API breaks.
4. **Store provenance:** source URL, author, license string, and import timestamp in model metadata — all three sites' content licenses require attribution for most CC variants.

Sources: [api.printables.com GraphQL (live probe)](https://api.printables.com/graphql/), [GhostTypes/printables-cli-api](https://github.com/GhostTypes/printables-cli-api/blob/main/printables_api.py), [manyfold#4530](https://github.com/manyfold3d/manyfold/issues/4530), [manyfold PR #4497](https://github.com/manyfold3d/manyfold/pull/4497), [Prusa GTC](https://www.prusa3d.com/page/general-terms-and-conditions-of-use-of-the-prusa-websites_231226/), [Bambuddy MakerWorld docs](https://wiki.bambuddy.cool/features/makerworld/), [OpenBambuAPI cloud-http](https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md), [api.bambulab.com design-service (live probe)](https://api.bambulab.com/v1/design-service/design/24966), [MakerWorld ToS](https://makerworld.com/en/user-agreement), [MMP agent #28](https://github.com/Maker-Management-Platform/agent/issues/28), [mmp-companion](https://github.com/Maker-Management-Platform/mmp-companion), [Thingiverse developers](https://www.thingiverse.com/developers), [Thingiverse getting started](https://www.thingiverse.com/developers/getting-started), [Thingiverse API legal](https://www.thingiverse.com/legal/api), [Openverse #1793 (rate limit)](https://github.com/WordPress/openverse/issues/1793), [womenin3dprinting API guide](https://womenin3dprinting.org/how-to-use-the-thingiverse-api-basic-read-access/), [thingy_grabber](https://github.com/cwoac/thingy_grabber), [Apify MakerWorld scraper](https://apify.com/stealth_mode/makerworld-models-details-scraper), [Bambu forum: public API request](https://forum.bambulab.com/t/public-api-for-makerworld/52699).