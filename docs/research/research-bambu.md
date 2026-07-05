# Bambu Lab A1 mini LAN Integration from Python — Research Findings (as of 2026-07-04)

## 1. Current state of Bambu LAN access (post-Jan-2025 "authorization control")

**Timeline & policy.** On 2025-01-20 Bambu Lab announced ["Updates and Third-Party Integration with Bambu Connect"](https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/): new firmware adds an **authorization control system** so that, by default, LAN MQTT/FTP commands must be cryptographically signed (routed through their **Bambu Connect** app or approved partners). Unsigned MQTT commands on locked-down firmware are rejected (community reports error `84033543`; HMS code `0500-0500-0001-0007` "MQTT verification failed"). After significant backlash (and Bambu Connect's signing key being extracted within days of release), Bambu added an official escape hatch: **LAN Developer Mode**, which "leaves the MQTT channel, live stream, and FTP open" with no authorization verification — explicitly unsupported by Bambu support, user assumes responsibility ([Bambu wiki: third-party integration](https://wiki.bambulab.com/en/software/third-party-integration), [forum announcement](https://forum.bambulab.com/t/updates-and-third-party-integration-with-bambu-connect/137408)).

**What this means for the app:** for a homelab single-user deployment, **require the user to enable LAN Developer Mode on the A1 mini**. Then the classic protocol (MQTT 8883 + FTPS 990 + camera 6000, all with user `bblp` + LAN access code) works exactly as pre-2025. Do **not** attempt the Bambu Connect signed path — it requires a partnership (devpartner@bambulab.com) and is a moving target.

**A1 mini specifics:**
- Developer Mode option exists on **A1/A1 mini firmware ≥ 01.05.00.00** (X1: ≥ 01.08.03.00; P1: ≥ 01.08.02.00) per [SimplyPrint's setup guide](https://help.simplyprint.io/en/article/bambu-lab-lan-only-mode-and-developer-mode-how-to-enable-xa0hch/). Latest A1 mini firmware is **01.08.00.00 (2026-05-13)** ([firmware download page](https://bambulab.com/en/support/firmware-download/a1-mini)) and retains Developer Mode. (The official [A1 mini firmware release history](https://wiki.bambulab.com/en/a1-mini/manual/a1-mini-firmware-release-history) wiki page returned HTTP 402 to automated fetches — have the user confirm on-device.)
- **Enable procedure (on printer screen):** Settings → WLAN/Network → enable **LAN-only Mode** → power-cycle → the **Developer Mode** toggle appears in the same menu → enable it. The **access code** is shown in the LAN-only Mode screen (if it shows zeros, toggle LAN-only off/on) ([Bambu wiki: enable developer mode](https://wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode), [SimplyPrint](https://help.simplyprint.io/en/article/bambu-lab-lan-only-mode-and-developer-mode-how-to-enable-xa0hch/)).
- **Tradeoff to document in your UI:** Developer Mode requires LAN-only mode, i.e. the printer disconnects from Bambu Cloud — Bambu Handy remote monitoring stops working. Firmware updates then happen via microSD or by temporarily re-enabling cloud.

**Certificate situation:** MQTT (8883), FTPS (990) and the camera port (6000) all present a **self-signed certificate from Bambu's private CA** ("BBL Technologies Co., Ltd."), which no system trust store accepts. Every working client either disables verification (`ssl.CERT_NONE` + `tls_insecure_set(True)` — what [bambulabs_api](https://github.com/BambuTools/bambulabs_api) does) or pins the printer/CA cert (OpenBambuAPI has a TLS-certificates page; the CA cert can also be captured with `openssl s_client` on first connect — TOFU pinning is the reasonable middle ground for your app). There is **no hostname that matches**, so hostname checking must always be off.

## 2. Exact LAN protocol details

### FTPS upload (implicit TLS, port 990)
- **Implicit FTPS** on port **990** (not explicit AUTH TLS, not SFTP). Login `bblp` / LAN access code ([forum: FTP on P1/A1 series](https://forum.bambulab.com/t/we-can-now-connect-to-ftp-on-the-p1-and-a1-series/6464)).
- Python's `ftplib.FTP_TLS` does **not** support implicit mode natively — subclass it and wrap the socket in SSL at connect time (the standard ~20-line `ImplicitFTP_TLS` pattern; see [bambulabs_api's ftp_client.py](https://raw.githubusercontent.com/BambuTools/bambulabs_api/main/bambulabs_api/ftp_client.py) which does exactly this: subclass overriding the `sock` property to auto-wrap, `login()` then `prot_p()`, `storbinary()` with 32 KB blocks).
- **Known server quirks:**
  - Some firmware returns `227 (0,0,0,0,...)` in PASV (advertises 0.0.0.0) ([Lan Tian's FileZilla workaround writeup](https://lantian.pub/en/article/modify-computer/modify-filezilla-workaround-bambu-3d-printer-ftp-issue.lantian/)). Python is immune by default: modern `ftplib` ignores the PASV-advertised IPv4 address and reuses the control-connection host unless `trust_server_pasv_ipv4_address=True`.
  - `storbinary` can hang waiting for the transfer-complete reply; bambulabs_api works around it by explicitly calling `conn.unwrap()` on the TLS data socket after upload.
  - The FTP server is slow (embedded SoC) — upload one file at a time; early-2023 firmware reportedly reset on >256 KB uploads, long since fixed (Bambu Studio itself sends multi-MB `.gcode.3mf` over this channel).
- **Filesystem layout** (root = microSD): visible dirs include `cache/`, `image/`, `timelapse/`, `logger/`, plus user files at root. Bambu Studio uploads print jobs to **`/cache/`**; uploading to `/` also works. Upload path must match the `url` you later send over MQTT.

### MQTT (port 8883, TLS)
- Broker **on the printer**, port **8883**, TLS (self-signed, see above), username **`bblp`**, password = **LAN access code**. Port 1883 is closed — TLS only. ([OpenBambuAPI mqtt.md](https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md))
- Topics: publish commands to **`device/{SERIAL}/request`**, subscribe to **`device/{SERIAL}/report`**. `{SERIAL}` is the printer serial number (shown on device / in Bambu Studio). All payloads JSON.
- **Start a print of an uploaded `.gcode.3mf`** — `print.project_file`. Canonical documented form ([OpenBambuAPI mqtt.md](https://raw.githubusercontent.com/Doridian/OpenBambuAPI/main/mqtt.md)):

```json
{
  "print": {
    "sequence_id": "0",
    "command": "project_file",
    "param": "Metadata/plate_1.gcode",
    "project_id": "0", "profile_id": "0", "task_id": "0", "subtask_id": "0",
    "subtask_name": "MyJobName",
    "file": "",
    "url": "file:///sdcard/cache/myfile.gcode.3mf",
    "md5": "",
    "timelapse": false,
    "bed_type": "auto",
    "bed_levelling": true,
    "flow_cali": true,
    "vibration_cali": true,
    "layer_inspect": false,
    "ams_mapping": [0],
    "use_ams": true
  }
}
```
  - `param`: always the in-archive path **`Metadata/plate_N.gcode`** (N = plate number inside the 3MF; plate 1 for single-plate exports).
  - `url`: three variants seen working in the wild: `file:///sdcard/<path>` and `file:///sdcard/cache/<file>` (captured from a real app-initiated P1/A1 print in [ha-bambulab discussion #628](https://github.com/greghesp/ha-bambulab/discussions/628)), `file:///mnt/sdcard/<path>` (OpenBambuAPI docs, X1-flavored), and `ftp:///<file>` (what [bambulabs_api](https://github.com/BambuTools/bambulabs_api) sends — resolves relative to FTP root). For the A1 mini use `file:///sdcard/...` matching your FTPS upload path.
  - `subtask_name`: display name on the printer screen / job history.
  - `use_ams` + `ams_mapping`: see gotchas below. `md5` may be left empty. Community consensus: the printer **silently ignores** malformed project_file commands — get fields exactly right ([#628](https://github.com/greghesp/ha-bambulab/discussions/628)).
- **Status**: request full state with `{"pushing": {"sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1}}`. Reports arrive on `/report` under the `print` key. Key fields ([OpenBambuAPI](https://raw.githubusercontent.com/Doridian/OpenBambuAPI/main/mqtt.md)): `gcode_state` (`IDLE`/`RUNNING`/`PAUSE`/`FINISH`/`FAILED`/`PREPARE`), `mc_percent` (0–100), `mc_remaining_time` (minutes), `layer_num`/`total_layer_num`, `print_error` (0 = none), `stg_cur` (current stage id), `nozzle_temper`/`bed_temper`, `spd_lvl` (1–4), `ams_status`, `subtask_name`, `gcode_file`, `wifi_signal`.
- **Critical A1/P1 behavior:** unlike X1 (full state every report), **A1-class printers send incremental diffs** — your worker must keep a merged state dict, applying each report on top, and call `pushall` only to (re)baseline: **at most once per ~5 minutes** — hammering pushall lags the printer's weak SoC ([Bambu forum: MQTT limitations](https://forum.bambulab.com/t/bambu-lab-mqtt-limitations/83440)). Other useful request commands: `print.pause`, `print.resume`, `print.stop`, `system.ledctrl` (chamber light), `print.gcode_line` (send raw G-code lines).

## 3. Python libraries (state of play, mid-2026)

| Library | Status | Verdict |
|---|---|---|
| [**bambulabs_api**](https://github.com/BambuTools/bambulabs_api) ([PyPI](https://pypi.org/project/bambulabs-api/)) | **Active**: v2.6.6 released 2026-01-31, 316 commits, CI green, MIT, Python ≥3.10. Targets P1/A1-class printers (README caveats are about X1 camera and untested H2D — A1 family is the mainline path). Has `upload_file()` (implicit-FTPS with the unwrap workaround), `start_print()` (project_file w/ AMS mapping, skip_objects), full MQTT state, camera client. Uses `tls_insecure_set(True)`/`CERT_NONE`. | **Recommended** |
| pybambu ([greghesp/ha-bambulab](https://github.com/greghesp/ha-bambulab)) | The most battle-tested state parser (HA integration, v2.2.22 on 2026-05-12, 2.2k stars, supports A1 mini + Developer Mode + A1 camera), **but vendored** at `custom_components/bambu_lab/pybambu` — not published to PyPI; upstream [greghesp/pybambu](https://github.com/greghesp/pybambu) is stale. | Mine it as a reference for report-field semantics, don't depend on it |
| [bambu-connect](https://github.com/mattcar15/bambu-connect) (mattcar15) | MIT; last release 0.3.1 **Aug 2024** ("Bug fixes and A1 mini support"); effectively unmaintained, predates the 2025 firmware era. Its [CameraClient.py](https://raw.githubusercontent.com/mattcar15/bambu-connect/main/bambu_connect/CameraClient.py) is the cleanest reference for the port-6000 camera protocol. | Reference only |
| Doridian/[OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) | Not a library — the community protocol spec (MQTT, FTPS, camera, TLS certs). Actively maintained. | Primary protocol doc |

**Recommendation:** use **`bambulabs-api` (PyPI, MIT)** in the Celery worker for upload + start + status. It's thin enough that if it stalls, falling back to **raw `paho-mqtt` + a 30-line `ImplicitFTP_TLS`** is a ~200-line rewrite with zero conceptual risk — the protocol itself (topics + JSON above) is fully documented and stable in Developer Mode. Isolate it behind your own `PrinterAdapter` interface either way.

## 4. Gotchas

- **microSD card is mandatory.** The A1 mini has no internal print storage; FTPS writes to the SD card, and without a mounted/healthy card uploads fail and prints can't start ("Insert SD card" symptom even with flaky cards) ([BambuStudio issue #3457](https://github.com/bambulab/BambuStudio/issues/3457), [Call3D SD error guide](https://www.call-3d.com/blogs/hardware-failure-guide-diagnose-call3d-printlab/how-to-tell-if-your-bambu-lab-micro-sd-card-error)). Surface "SD card missing/full" as a first-class error in your send-to-printer flow.
- **`.gcode.3mf` only, not plain `.gcode`, for remote start.** `project_file` expects a 3MF container with `Metadata/plate_N.gcode` inside — exactly what Bambu Studio's "Export plate sliced file" produces. The legacy `print.gcode_file` command for bare `.gcode` is unreliable/undocumented on modern firmware (users can't get it working; it's believed to be for built-in service gcode) ([forum thread](https://forum.bambulab.com/t/printing-gcode-not-sliced-3mf-using-mqtt/172699)). Validate on upload that the file is a `.gcode.3mf` (a ZIP containing `Metadata/plate_*.gcode`) — that also lets you extract plate thumbnails (`Metadata/plate_N.png`) and slice metadata (`Metadata/slice_info.config`) for free.
- **AMS lite:** if the user has an AMS lite on the A1 mini, multi-color jobs need `use_ams: true` plus a correct `ams_mapping` array (one entry per filament in the 3MF, values = AMS tray index, `-1` = external spool); wrong mappings make the printer ignore the command or misload ([ha-bambulab #628](https://github.com/greghesp/ha-bambulab/discussions/628), [AMS mapping guide](https://cinder.works/blog/bambu-bambu-ams-filament-mapping-guide)). Safe v1 default: `use_ams: false`, `ams_mapping: [0]` (external spool / as-sliced), with an "advanced" toggle. Also expose `bed_levelling`, `flow_cali`, `timelapse` as checkboxes — they map 1:1 to payload fields.
- **Only start prints when `gcode_state` is `IDLE`/`FINISH`/`FAILED`** — the printer ignores project_file while `RUNNING`. Poll merged MQTT state before sending.
- **Camera (nice-to-have): available on A1 mini in Developer Mode.** Not RTSP — a custom TLS socket on **port 6000**: send a 96-byte auth packet (`0x40` u32 LE, `0x3000` u32 LE, 8 null bytes, username `bblp` null-padded to 32 bytes, access code null-padded to 32 bytes), then read a stream of JPEG frames delimited by `FF D8 FF E0` … `FF D9` ([bambu-connect CameraClient](https://raw.githubusercontent.com/mattcar15/bambu-connect/main/bambu_connect/CameraClient.py); port confirmed for A1 series by [SimplyPrint's webcam guide](https://help.simplyprint.io/en/article/bambu-lab-integration-webcam-setup-and-usage-guide-u8nmfm/), test with `nc -zv IP 6000`). Low frame rate (~0.5–1 fps class hardware); typically one client at a time — treat as snapshot/MJPEG-relay, not video.
- **Firmware drift risk:** Bambu ships new firmware regularly (A1 mini 01.08.00.00 May 2026) and has stated Developer Mode continues to exist, but each update re-tests community tooling; keep printer integration behind a feature flag and pin known-good firmware in your docs. If the printer is in cloud (non-LAN) mode on current firmware, third-party MQTT commands are blocked outright — your setup wizard should verify Developer Mode by connecting to 8883 and issuing `pushall`.
- **Single admin/homelab fit:** store IP + serial + access code as printer config; all three are on the printer screen. mDNS: printers announce via SSDP/mDNS but static IP or DHCP reservation is more reliable for a headless worker.

### Sources
- https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect/
- https://wiki.bambulab.com/en/software/third-party-integration
- https://wiki.bambulab.com/en/knowledge-sharing/enable-developer-mode
- https://help.simplyprint.io/en/article/bambu-lab-lan-only-mode-and-developer-mode-how-to-enable-xa0hch/
- https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md
- https://github.com/greghesp/ha-bambulab (and discussion #628)
- https://github.com/BambuTools/bambulabs_api / https://pypi.org/project/bambulabs-api/
- https://github.com/mattcar15/bambu-connect
- https://forum.bambulab.com/t/we-can-now-connect-to-ftp-on-the-p1-and-a1-series/6464
- https://forum.bambulab.com/t/bambu-lab-mqtt-limitations/83440
- https://forum.bambulab.com/t/printing-gcode-not-sliced-3mf-using-mqtt/172699
- https://lantian.pub/en/article/modify-computer/modify-filezilla-workaround-bambu-3d-printer-ftp-issue.lantian/
- https://bambulab.com/en/support/firmware-download/a1-mini
- https://help.simplyprint.io/en/article/bambu-lab-integration-webcam-setup-and-usage-guide-u8nmfm/
- https://printer-hub.ru/en/posts/bambu-lab-firmware-guide