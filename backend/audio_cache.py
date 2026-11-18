"""Local Audio Downloader, RapidAPI Full-Track Resolver & Bounded 20-Track Cache Manager."""

from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import socket
import struct
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from urllib.parse import quote, urlsplit

import requests

try:
    import yt_dlp
except ImportError:  # pragma: no cover
    yt_dlp = None

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional fallback if python-dotenv unavailable
    load_dotenv = None

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if load_dotenv is not None:
    load_dotenv(PROJECT_ROOT / ".env", override=False)

AUDIO_CACHE_DIR = PROJECT_ROOT / "data" / "audio_cache"
MAX_LOCAL_AUDIO_FILES = 20
MIN_VALID_AUDIO_BYTES = 4096
MAX_PROXY_AUDIO_BYTES = 0x6400000  # 100 MiB (matching MusicFab web limit)
FULL_AUDIO_MIN_MS = 45_000
PREVIEW_AUDIO_MAX_MS = 38_000
SUPPORTED_AUDIO_EXTENSIONS = (".mp3", ".m4a", ".mp4", ".ogg", ".opus", ".aac", ".wav", ".webm")

DEFAULT_METADATA_HOST = "spotify-web-api3.p.rapidapi.com"
DEFAULT_MP3_HOST = "spotify-mp3-converter-downloader.p.rapidapi.com"
DEFAULT_BACKUP_HOST = "spotify-downloader9.p.rapidapi.com"
DEFAULT_RAPIDAPI_TIMEOUT_MS = 30_000

_BLOCKED_DIRECT_AUDIO_HOSTS = frozenset({"open.spotify.com", "spotify.link", "spoti.fi"})
_SPOTIFY_ID_RE = re.compile(r"^[a-zA-Z0-9]{22}$")
_SAFE_STEM_RE = re.compile(r"^[a-zA-Z0-9_-]{8,40}$")

_cache_lock = threading.Lock()
_REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) EmBeatAudioFetcher/1.0"
}

# MPEG-1/2/2.5 Layer III bitrate table (kbps) indexed by (is_mpeg1, bitrate_index)
_MP3_BITRATES_V1_L3 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)
_MP3_BITRATES_V2_L3 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)
_MP3_SAMPLE_RATES = {
    3: (44100, 48000, 32000),  # MPEG 1
    2: (22050, 24000, 16000),  # MPEG 2
    0: (11025, 12000, 8000),   # MPEG 2.5
}

_AUDIO_URL_KEYS = (
    "downloadUrl",
    "download_url",
    "downloadLink",
    "download_link",
    "audioUrl",
    "audio_url",
    "audio",
    "link",
    "url",
    "web_url",
)

_PREVIEW_HOST_HINTS = ("scdn.co/mp3-preview", "audio-ssl.itunes.apple.com", "mzstatic.com")


def ensure_cache_dir() -> Path:
    """Ensure local audio cache directory exists and return it."""
    AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return AUDIO_CACHE_DIR


def _get_env_str(name: str, default: str = "") -> str:
    return str(os.environ.get(name, default) or default).strip()


def _get_rapidapi_timeout_sec() -> float:
    raw = _get_env_str("RAPIDAPI_TIMEOUT_MS", str(DEFAULT_RAPIDAPI_TIMEOUT_MS))
    try:
        ms = float(raw)
    except ValueError:
        ms = float(DEFAULT_RAPIDAPI_TIMEOUT_MS)
    return max(3.0, min(60.0, ms / 1000.0))


def is_rapidapi_configured() -> bool:
    """Return True when a non-empty RAPIDAPI_KEY is available in the environment."""
    key = _get_env_str("RAPIDAPI_KEY")
    return bool(key and key != "your_rapidapi_key_here")


def is_native_engine_available() -> bool:
    """Return True when yt-dlp is installed and usable for native Spodown audio downloads."""
    return yt_dlp is not None


def get_audio_resolver_config() -> Dict[str, Any]:
    """Return non-secret audio resolver configuration status for UI and diagnostics."""
    configured = is_rapidapi_configured()
    native_avail = is_native_engine_available()
    if configured and native_avail:
        mode = "hybrid_full"
    elif native_avail:
        mode = "full_native"
    elif configured:
        mode = "full_rapidapi"
    else:
        mode = "preview_fallback"

    return {
        "rapidapi_configured": configured,
        "native_engine_available": native_avail,
        "mode": mode,
        "metadata_host": _get_env_str("SPOTIFY_METADATA_HOST", DEFAULT_METADATA_HOST),
        "primary_host": _get_env_str("SPOTIFY_MP3_HOST", DEFAULT_MP3_HOST),
        "backup_host": _get_env_str("SPOTIFY_BACKUP_DOWNLOAD_HOST", DEFAULT_BACKUP_HOST),
        "timeout_ms": int(_get_rapidapi_timeout_sec() * 1000),
        "max_proxy_bytes": MAX_PROXY_AUDIO_BYTES,
        "max_local_cache_files": MAX_LOCAL_AUDIO_FILES,
    }


def is_valid_external_audio_url(url: str) -> bool:
    """Validate that candidate URL is HTTP(S), credential-free, and not a Spotify web page."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url.strip())
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    if parsed.username or parsed.password or not parsed.hostname:
        return False
    if parsed.hostname.lower() in _BLOCKED_DIRECT_AUDIO_HOSTS:
        return False
    return True


def is_safe_proxy_url(url: str) -> bool:
    """Validate external URL and reject private/loopback/link-local targets against SSRF."""
    if not is_valid_external_audio_url(url):
        return False
    parsed = urlsplit(url.strip())
    hostname = (parsed.hostname or "").strip().lower()
    if not hostname or hostname == "localhost":
        return False

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        return False

    if not infos:
        return False

    for info in infos:
        ip_str = info[4][0].split("%")[0]
        try:
            addr = ipaddress.ip_address(ip_str)
        except ValueError:
            return False
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
            or not addr.is_global
        ):
            return False
    return True


def _sanitize_download_filename(track: Dict[str, Any], ext: str) -> str:
    artist = str(track.get("artist_name") or track.get("artist") or "").strip()
    title = str(track.get("track_name") or track.get("title") or "Spotify Track").strip()
    base = " - ".join(part for part in (artist, title) if part) or "Spotify Track"
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', " ", base)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .")[:140] or "track"
    clean_ext = ext if ext.startswith(".") else f".{ext}"
    return f"{cleaned}{clean_ext}"


def _build_proxy_url(external_url: str, track: Dict[str, Any], ext: str = ".mp3") -> str:
    filename = _sanitize_download_filename(track, ext)
    return f"/api/audio/proxy?url={quote(external_url, safe='')}&filename={quote(filename, safe='')}"


def _build_spotify_track_url(track: Dict[str, Any]) -> Optional[str]:
    uri = str(track.get("spotify_uri") or "").strip()
    if uri.startswith("spotify:track:"):
        tid = uri.split(":")[-1].strip()
        if _SPOTIFY_ID_RE.match(tid):
            return f"https://open.spotify.com/track/{tid}"

    tid = str(track.get("track_id") or "").strip()
    if _SPOTIFY_ID_RE.match(tid) and not tid.startswith(("sp_", "csv_", "trk_")):
        return f"https://open.spotify.com/track/{tid}"

    raw_url = str(track.get("spotify_url") or track.get("external_url") or "").strip()
    if raw_url.startswith(("http://", "https://")) and "open.spotify.com/track/" in raw_url:
        return raw_url.split("?")[0]
    return None


def _track_cache_stem(track: Dict[str, Any]) -> str:
    """Create a deterministic, filesystem-safe filename stem for a track."""
    tid = str(track.get("track_id") or "").strip()
    if tid and _SAFE_STEM_RE.match(tid):
        return tid
    raw_key = f"{track.get('track_name', '')}__{track.get('artist_name') or track.get('artist', '')}"
    return f"trk_{hashlib.sha1(raw_key.encode('utf-8')).hexdigest()[:16]}"


def _find_cached_file_for_stem(stem: str) -> Optional[Path]:
    """Return existing cached audio file for stem if valid and >= MIN_VALID_AUDIO_BYTES."""
    ensure_cache_dir()
    for ext in SUPPORTED_AUDIO_EXTENSIONS:
        candidate = AUDIO_CACHE_DIR / f"{stem}{ext}"
        if candidate.is_file() and candidate.stat().st_size >= MIN_VALID_AUDIO_BYTES:
            return candidate
    return None


def _guess_extension(url: str, content_type: Optional[str]) -> str:
    ct = (content_type or "").lower()
    low_url = (url or "").lower().split("?")[0]
    if "mpeg" in ct or "mp3" in ct or low_url.endswith(".mp3"):
        return ".mp3"
    if "flac" in ct or low_url.endswith(".flac"):
        return ".flac"
    if "wav" in ct or low_url.endswith(".wav"):
        return ".wav"
    if "ogg" in ct or low_url.endswith(".ogg"):
        return ".ogg"
    if "opus" in ct or low_url.endswith(".opus"):
        return ".opus"
    if "webm" in ct or low_url.endswith(".webm"):
        return ".webm"
    if "mp4" in ct or "m4a" in ct or "m4p" in ct or "aac" in ct or low_url.endswith((".m4a", ".m4p", ".mp4", ".aac")):
        return ".m4a"
    if "scdn.co/mp3-preview" in low_url:
        return ".mp3"
    return ".m4a"


def _estimate_mp3_duration_ms(data: bytes) -> Optional[int]:
    """Estimate MP3 duration in ms using Xing/Info header or MPEG frame bitrate."""
    size = len(data)
    if size < 128:
        return None

    offset = 0
    if data[:3] == b"ID3" and size >= 10:
        tag_size = (
            ((data[6] & 0x7F) << 21)
            | ((data[7] & 0x7F) << 14)
            | ((data[8] & 0x7F) << 7)
            | (data[9] & 0x7F)
        )
        offset = 10 + tag_size
        if data[5] & 0x10:  # ID3 footer present
            offset += 10

    limit = min(size - 4, offset + 65536)
    pos = offset
    while pos < limit:
        if data[pos] != 0xFF or (data[pos + 1] & 0xE0) != 0xE0:
            pos += 1
            continue

        b1, b2, b3 = data[pos + 1], data[pos + 2], data[pos + 3]
        version_id = (b1 >> 3) & 0x03
        layer = (b1 >> 1) & 0x03
        bitrate_idx = (b2 >> 4) & 0x0F
        sample_idx = (b2 >> 2) & 0x03

        if version_id == 1 or layer != 1 or bitrate_idx in (0, 15) or sample_idx == 3:
            pos += 1
            continue

        sample_rate = _MP3_SAMPLE_RATES[version_id][sample_idx]
        is_mpeg1 = version_id == 3
        kbps = (_MP3_BITRATES_V1_L3 if is_mpeg1 else _MP3_BITRATES_V2_L3)[bitrate_idx]
        if kbps <= 0 or sample_rate <= 0:
            pos += 1
            continue

        channel_mode = (b3 >> 6) & 0x03
        if is_mpeg1:
            side_info_len = 17 if channel_mode == 3 else 32
            samples_per_frame = 1152
        else:
            side_info_len = 9 if channel_mode == 3 else 17
            samples_per_frame = 576

        xing_pos = pos + 4 + side_info_len
        if xing_pos + 12 <= size and data[xing_pos : xing_pos + 4] in (b"Xing", b"Info"):
            flags = struct.unpack(">I", data[xing_pos + 4 : xing_pos + 8])[0]
            if flags & 0x01:
                total_frames = struct.unpack(">I", data[xing_pos + 8 : xing_pos + 12])[0]
                if total_frames > 0:
                    return int(round((total_frames * samples_per_frame / sample_rate) * 1000))

        audio_bytes = max(0, size - pos)
        return int(round((audio_bytes * 8.0) / kbps))

    return None


def _estimate_mp4_duration_ms(data: bytes) -> Optional[int]:
    """Parse ISO BMFF moov/mvhd atom to measure M4A/MP4 duration in ms."""
    size = len(data)

    def _find_atom(start: int, end: int, target: bytes) -> Optional[Tuple[int, int]]:
        cursor = start
        while cursor + 8 <= end:
            atom_size, atom_type = struct.unpack(">I4s", data[cursor : cursor + 8])
            header_len = 8
            if atom_size == 1 and cursor + 16 <= end:
                atom_size = struct.unpack(">Q", data[cursor + 8 : cursor + 16])[0]
                header_len = 16
            elif atom_size == 0:
                atom_size = end - cursor
            if atom_size < header_len or cursor + atom_size > end:
                break
            if atom_type == target:
                return cursor + header_len, cursor + atom_size
            cursor += atom_size
        return None

    moov = _find_atom(0, size, b"moov")
    if not moov:
        return None
    mvhd = _find_atom(moov[0], moov[1], b"mvhd")
    if not mvhd:
        return None
    payload_start, payload_end = mvhd
    if payload_start + 20 > payload_end:
        return None

    version = data[payload_start]
    if version == 0 and payload_start + 20 <= payload_end:
        timescale, duration = struct.unpack(">II", data[payload_start + 12 : payload_start + 20])
    elif version == 1 and payload_start + 32 <= payload_end:
        timescale, duration = struct.unpack(">IQ", data[payload_start + 20 : payload_start + 32])
    else:
        return None

    if timescale <= 0 or duration <= 0:
        return None
    return int(round((duration / timescale) * 1000))


def _estimate_wav_duration_ms(data: bytes) -> Optional[int]:
    """Parse RIFF WAVE fmt/data chunks for duration in ms."""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    pos = 12
    byte_rate = 0
    data_size = 0
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        chunk_size = struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        if chunk_id == b"fmt " and chunk_size >= 16 and pos + 8 + 16 <= len(data):
            byte_rate = struct.unpack("<I", data[pos + 16 : pos + 20])[0]
        elif chunk_id == b"data":
            data_size = chunk_size
            break
        pos += 8 + chunk_size + (chunk_size % 2)
    if byte_rate > 0 and data_size > 0:
        return int(round((data_size / byte_rate) * 1000))
    return None


def _estimate_audio_duration_ms(
    raw_bytes: bytes,
    ext: str = "",
    content_type: str = "",
) -> Optional[int]:
    """Estimate actual audio duration in milliseconds from raw audio bytes."""
    if not raw_bytes or len(raw_bytes) < MIN_VALID_AUDIO_BYTES:
        return None

    low_ext = ext.lower()
    low_ct = (content_type or "").lower()
    if low_ext == ".mp3" or "mpeg" in low_ct or raw_bytes[:3] == b"ID3":
        dur = _estimate_mp3_duration_ms(raw_bytes)
        if dur:
            return dur
    if low_ext in (".m4a", ".mp4", ".aac") or "mp4" in low_ct or b"ftyp" in raw_bytes[:16]:
        dur = _estimate_mp4_duration_ms(raw_bytes)
        if dur:
            return dur
    if low_ext == ".wav" or "wav" in low_ct or raw_bytes[:4] == b"RIFF":
        dur = _estimate_wav_duration_ms(raw_bytes)
        if dur:
            return dur

    # Conservative fallback for OGG/OPUS/WebM when container parser isn't invoked (~128 kbps)
    if low_ext in (".ogg", ".opus", ".webm") or any(k in low_ct for k in ("ogg", "opus", "webm")):
        return int(round((len(raw_bytes) * 8.0) / 128.0))
    return None


def _classify_audio_kind(
    audio_duration_ms: Optional[int],
    catalog_duration_ms: Optional[int] = None,
    url: str = "",
    explicit_kind: Optional[str] = None,
) -> str:
    """
    Classify audio stream as 'full' vs 'preview' (MusicFab audioKind pattern).
    Prevents 30s preview clips from being treated as full tracks.
    """
    if audio_duration_ms is not None and audio_duration_ms > 0:
        if audio_duration_ms >= FULL_AUDIO_MIN_MS:
            return "full"
        if catalog_duration_ms and catalog_duration_ms >= FULL_AUDIO_MIN_MS:
            if audio_duration_ms >= int(catalog_duration_ms * 0.65):
                return "full"
        if audio_duration_ms <= PREVIEW_AUDIO_MAX_MS:
            return "preview"

    low_url = (url or "").lower()
    if any(hint in low_url for hint in _PREVIEW_HOST_HINTS):
        return "preview"

    if explicit_kind in ("full", "preview"):
        return explicit_kind
    return "preview"


def _parse_duration_to_ms(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        num = float(value)
        if num <= 0:
            return None
        return int(round(num * 1000)) if num < 1000 else int(round(num))
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return _parse_duration_to_ms(int(text))
        m = re.match(r"^(\d+):(\d{1,2})$", text)
        if m:
            return (int(m.group(1)) * 60 + int(m.group(2))) * 1000
    return None


def _extract_audio_candidate_from_payload(payload: Any) -> Optional[Dict[str, Any]]:
    """
    Normalize RapidAPI JSON responses across different Spotify downloader wrappers
    into {url, catalog_duration_ms, cover_art_url, extension, audio_kind}.
    """
    if not isinstance(payload, dict):
        return None

    data_node = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    search_nodes: List[Dict[str, Any]] = []
    for candidate in (
        data_node.get("track"),
        data_node.get("metadata"),
        payload.get("metadata"),
        payload.get("result"),
        data_node,
        payload,
    ):
        if isinstance(candidate, dict):
            search_nodes.append(candidate)

    for key in ("medias", "tracks", "items"):
        seq = data_node.get(key) or payload.get(key)
        if isinstance(seq, list) and seq and isinstance(seq[0], dict):
            search_nodes.append(seq[0])

    resolved_url: Optional[str] = None
    matched_node: Dict[str, Any] = {}
    for node in search_nodes:
        for url_key in _AUDIO_URL_KEYS:
            val = node.get(url_key)
            if isinstance(val, str) and is_valid_external_audio_url(val):
                resolved_url = val.strip()
                matched_node = node
                break
        if resolved_url:
            break

    if not resolved_url:
        return None

    catalog_ms = None
    for node in (matched_node, data_node, payload):
        for dur_key in ("catalogDurationMs", "duration_ms", "durationMs", "duration"):
            parsed = _parse_duration_to_ms(node.get(dur_key))
            if parsed:
                catalog_ms = parsed
                break
        if catalog_ms:
            break

    cover_url = None
    for node in (matched_node, data_node, payload):
        for img_key in ("cover", "image", "cover_art_url", "albumCover", "thumbnail"):
            img = node.get(img_key)
            if isinstance(img, str) and img.startswith(("http://", "https://")):
                cover_url = img.strip()
                break
        if cover_url:
            break

    raw_kind = matched_node.get("audioKind") or data_node.get("audioKind") or payload.get("audioKind")
    explicit_kind = raw_kind if raw_kind in ("full", "preview") else None
    if explicit_kind is None and not any(hint in resolved_url.lower() for hint in _PREVIEW_HOST_HINTS):
        explicit_kind = "full"

    ext_raw = str(matched_node.get("extension") or matched_node.get("format") or "").strip().lstrip(".").lower()
    return {
        "url": resolved_url,
        "catalog_duration_ms": catalog_ms,
        "cover_art_url": cover_url,
        "extension": f".{ext_raw}" if ext_raw else None,
        "audio_kind": explicit_kind,
    }


def _build_rapidapi_probe_specs(
    host: str,
    spotify_url: Optional[str],
    track_id: str,
    custom_endpoint: str = "",
) -> List[Tuple[str, str, Dict[str, Any]]]:
    """Return candidate (method, url, params) probes for a RapidAPI audio host."""
    param_override = _get_env_str("RAPIDAPI_PARAM_NAME")
    target_ref = spotify_url or track_id
    if not target_ref:
        return []

    if custom_endpoint:
        full_url = (
            custom_endpoint
            if custom_endpoint.startswith(("http://", "https://"))
            else f"https://{host}{custom_endpoint if custom_endpoint.startswith('/') else '/' + custom_endpoint}"
        )
        if param_override:
            return [("GET", full_url, {param_override: target_ref})]
        probes = [("GET", full_url, {"url": target_ref})]
        if spotify_url:
            probes.append(("GET", full_url, {"spotify_url": spotify_url}))
        if _SPOTIFY_ID_RE.match(track_id):
            probes.append(("GET", full_url, {"songId": track_id}))
        return probes

    if "downloader9" in host:
        probes = []
        if _SPOTIFY_ID_RE.match(track_id):
            probes.append(("GET", f"https://{host}/downloadSong", {"songId": spotify_url or track_id}))
        if spotify_url:
            probes.append(("GET", f"https://{host}/downloadSong", {"spotify_url": spotify_url}))
            probes.append(("GET", f"https://{host}/downloadTrack", {"url": spotify_url}))
        return probes

    # Default multi-shape probes for spotify-mp3-converter-downloader & compatible hosts
    probes = []
    if spotify_url:
        probes.append(("GET", f"https://{host}/download", {"url": spotify_url}))
        probes.append(("GET", f"https://{host}/v1/track/download", {"track": spotify_url}))
    if _SPOTIFY_ID_RE.match(track_id):
        probes.append(("GET", f"https://{host}/download", {"songId": track_id}))
        probes.append(("GET", f"https://{host}/track", {"id": track_id}))
    return probes


def _search_spotify_track_via_rapidapi(
    track_name: str,
    artist_name: str,
    timeout_sec: float,
) -> Optional[Tuple[str, Optional[int]]]:
    """Resolve canonical Spotify track ID & duration_ms using SPOTIFY_METADATA_HOST when ID is missing."""
    api_key = _get_env_str("RAPIDAPI_KEY")
    metadata_host = _get_env_str("SPOTIFY_METADATA_HOST", DEFAULT_METADATA_HOST)
    if not api_key or not metadata_host or not track_name:
        return None

    query = f"{track_name} {artist_name}".strip()
    headers = {
        "x-rapidapi-key": api_key,
        "x-rapidapi-host": metadata_host,
        "Accept": "application/json",
    }
    try:
        resp = requests.get(
            f"https://{metadata_host}/search/",
            params={"q": query, "type": "tracks", "offset": 0, "limit": 1},
            headers=headers,
            timeout=timeout_sec,
        )
        if resp.status_code != 200:
            return None
        body = resp.json()
        items = (
            body.get("tracks", {}).get("items")
            or body.get("data", {}).get("tracks", {}).get("items")
            or []
        )
        if not items:
            return None
        first = items[0].get("data") if isinstance(items[0], dict) and "data" in items[0] else items[0]
        if not isinstance(first, dict):
            return None
        tid = str(first.get("id") or "").strip()
        if not tid and isinstance(first.get("uri"), str) and ":" in first["uri"]:
            tid = first["uri"].split(":")[-1].strip()
        dur_ms = _parse_duration_to_ms(first.get("duration_ms") or (first.get("duration") or {}).get("totalMilliseconds"))
        if _SPOTIFY_ID_RE.match(tid):
            return f"https://open.spotify.com/track/{tid}", dur_ms
    except Exception as exc:
        logger.debug("RapidAPI metadata search failed for %s: %s", query, exc)
    return None


def _resolve_via_rapidapi(
    track: Dict[str, Any],
    timeout_sec: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """
    MusicFab-style RapidAPI fallback chain:
    Primary host (SPOTIFY_MP3_HOST) -> Backup host (SPOTIFY_BACKUP_DOWNLOAD_HOST).
    """
    if not is_rapidapi_configured():
        return None

    api_key = _get_env_str("RAPIDAPI_KEY")
    timeout = timeout_sec if timeout_sec is not None else _get_rapidapi_timeout_sec()
    tid = str(track.get("track_id") or "").strip()
    spotify_url = _build_spotify_track_url(track)
    catalog_ms = _parse_duration_to_ms(track.get("duration_ms"))

    if not spotify_url:
        found = _search_spotify_track_via_rapidapi(
            str(track.get("track_name") or "").strip(),
            str(track.get("artist_name") or track.get("artist") or "").strip(),
            timeout_sec=min(timeout, 10.0),
        )
        if found:
            spotify_url, meta_dur = found
            tid = spotify_url.rstrip("/").split("/")[-1]
            if not catalog_ms and meta_dur:
                catalog_ms = meta_dur

    if not spotify_url and not _SPOTIFY_ID_RE.match(tid):
        return None

    providers = [
        ("rapidapi_primary", _get_env_str("SPOTIFY_MP3_HOST", DEFAULT_MP3_HOST), _get_env_str("SPOTIFY_MP3_ENDPOINT")),
        ("rapidapi_backup", _get_env_str("SPOTIFY_BACKUP_DOWNLOAD_HOST", DEFAULT_BACKUP_HOST), _get_env_str("SPOTIFY_BACKUP_ENDPOINT")),
    ]

    for source_name, host, custom_ep in providers:
        if not host:
            continue
        headers = {
            "x-rapidapi-key": api_key,
            "x-rapidapi-host": host,
            "Accept": "application/json",
            **_REQUEST_HEADERS,
        }
        probes = _build_rapidapi_probe_specs(host, spotify_url, tid, custom_endpoint=custom_ep)
        for method, endpoint_url, params in probes:
            try:
                resp = requests.request(method, endpoint_url, params=params, headers=headers, timeout=timeout)
                if resp.status_code in (401, 403, 429):
                    logger.warning("RapidAPI host %s returned HTTP %s", host, resp.status_code)
                    break
                if resp.status_code == 404:
                    continue
                if resp.status_code != 200:
                    continue
                payload = resp.json()
                candidate = _extract_audio_candidate_from_payload(payload)
                if candidate:
                    return {
                        **candidate,
                        "source": source_name,
                        "catalog_duration_ms": candidate.get("catalog_duration_ms") or catalog_ms,
                    }
            except Exception as exc:
                logger.debug("RapidAPI probe failed (%s %s): %s", host, endpoint_url, exc)
                continue

    return None


def _resolve_via_native_engine(
    track: Dict[str, Any],
    download: bool = True,
    timeout_sec: float = 25.0,
) -> Optional[Dict[str, Any]]:
    """
    Spodown / SpotDL native full-track extraction engine using yt-dlp + ffmpeg.
    Bypasses RapidAPI daily rate limits (HTTP 429) and downloads or streams 100% full songs.
    """
    if not is_native_engine_available():
        return None

    track_name = str(track.get("track_name") or track.get("title") or "").strip()
    artist_name = str(track.get("artist_name") or track.get("artist") or "").strip()
    if not track_name:
        return None

    query = f"ytsearch1:{track_name} {artist_name} audio".strip()
    stem = _track_cache_stem(track)
    catalog_ms = _parse_duration_to_ms(track.get("catalog_duration_ms") or track.get("duration_ms"))

    ensure_cache_dir()

    if download:
        out_template = str(AUDIO_CACHE_DIR / f"{stem}.%(ext)s")
        # Try MP3 extraction via ffmpeg first
        ydl_opts_mp3 = {
            "format": "bestaudio/best",
            "outtmpl": out_template,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }],
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts_mp3) as ydl:
                ydl.extract_info(query, download=True)
        except Exception as exc:
            logger.debug("yt-dlp mp3 extraction error, trying raw audio: %s", exc)
            ydl_opts_raw = {
                "format": "bestaudio/best",
                "outtmpl": out_template,
                "noplaylist": True,
                "quiet": True,
                "no_warnings": True,
            }
            try:
                with yt_dlp.YoutubeDL(ydl_opts_raw) as ydl:
                    ydl.extract_info(query, download=True)
            except Exception as e2:
                logger.warning("Native engine download failed for %s: %s", query, e2)
                return None

        saved_file = None
        for ext in (".mp3", ".m4a", ".webm", ".opus", ".aac", ".ogg"):
            cand = AUDIO_CACHE_DIR / f"{stem}{ext}"
            if cand.is_file() and cand.stat().st_size >= MIN_VALID_AUDIO_BYTES:
                saved_file = cand
                break

        if not saved_file:
            return None

        # Clean old partial or other extension files for same stem
        for ext in SUPPORTED_AUDIO_EXTENSIONS:
            cand = AUDIO_CACHE_DIR / f"{stem}{ext}"
            if cand.is_file() and cand != saved_file:
                try:
                    cand.unlink(missing_ok=True)
                except OSError:
                    pass

        meta = _inspect_cached_audio_meta(saved_file, track)
        audio_dur = meta.get("audio_duration_ms")
        kind = _classify_audio_kind(audio_dur, catalog_duration_ms=catalog_ms, explicit_kind="full")

        return {
            "source": "spodown_native",
            "file_path": saved_file,
            "audio_kind": kind,
            "audio_duration_ms": audio_dur,
            "catalog_duration_ms": catalog_ms,
        }

    else:
        ydl_opts = {
            "format": "bestaudio/best",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(query, download=False)
            entries = info.get("entries") or [info]
            if not entries or not entries[0]:
                return None
            first = entries[0]
            stream_url = first.get("url")
            if not stream_url or not is_valid_external_audio_url(stream_url):
                return None

            dur_sec = first.get("duration")
            audio_ms = int(dur_sec * 1000) if dur_sec else catalog_ms
            kind = _classify_audio_kind(audio_ms, catalog_duration_ms=catalog_ms, explicit_kind="full")
            return {
                "source": "spodown_native",
                "url": stream_url,
                "audio_kind": kind,
                "audio_duration_ms": audio_ms,
                "catalog_duration_ms": catalog_ms,
                "cover_art_url": first.get("thumbnail"),
                "extension": ".mp3",
            }
        except Exception as exc:
            logger.warning("Native engine stream resolve failed for %s: %s", query, exc)
            return None


def fetch_rapidapi_playlist_metadata(
    playlist_id: str,
    timeout_sec: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """
    Fetch Spotify playlist metadata & full catalog track info (ISRC, duration_ms, cover art)
    via SPOTIFY_METADATA_HOST when RAPIDAPI_KEY is configured.
    """
    if not is_rapidapi_configured() or not playlist_id:
        return None

    api_key = _get_env_str("RAPIDAPI_KEY")
    host = _get_env_str("SPOTIFY_METADATA_HOST", DEFAULT_METADATA_HOST)
    custom_ep = _get_env_str("SPOTIFY_METADATA_ENDPOINT")
    if not host:
        return None

    timeout = timeout_sec if timeout_sec is not None else _get_rapidapi_timeout_sec()
    headers = {
        "x-rapidapi-key": api_key,
        "x-rapidapi-host": host,
        "Accept": "application/json",
        **_REQUEST_HEADERS,
    }

    probe_urls: List[Tuple[str, Dict[str, Any]]] = []
    if custom_ep:
        ep = custom_ep.format(playlist_id=playlist_id, id=playlist_id)
        url = ep if ep.startswith(("http://", "https://")) else f"https://{host}{ep if ep.startswith('/') else '/' + ep}"
        probe_urls.append((url, {"id": playlist_id}))
    else:
        probe_urls = [
            (f"https://{host}/playlist_tracks/", {"id": playlist_id, "offset": 0, "limit": 100}),
            (f"https://{host}/v1/playlists/{playlist_id}/tracks", {"offset": 0, "limit": 100}),
            (f"https://{host}/playlist/", {"id": playlist_id}),
        ]

    for url, params in probe_urls:
        try:
            resp = requests.get(url, params=params, headers=headers, timeout=timeout)
            if resp.status_code in (401, 403, 429):
                logger.warning("RapidAPI metadata host %s returned HTTP %s", host, resp.status_code)
                return None
            if resp.status_code != 200:
                continue
            body = resp.json()
            items = body.get("items") or body.get("tracks", {}).get("items") or []
            if not isinstance(items, list) or not items:
                continue

            tracks: List[Dict[str, Any]] = []
            for idx, entry in enumerate(items, start=1):
                trk = entry.get("track") if isinstance(entry, dict) and isinstance(entry.get("track"), dict) else entry
                if not isinstance(trk, dict):
                    continue
                tid = str(trk.get("id") or "").strip()
                uri = str(trk.get("uri") or (f"spotify:track:{tid}" if tid else "")).strip()
                artists = trk.get("artists") or []
                artist_names = ", ".join(
                    str(a.get("name")) for a in artists if isinstance(a, dict) and a.get("name")
                ) or str(trk.get("artist") or "Unknown Artist")
                album = trk.get("album") if isinstance(trk.get("album"), dict) else {}
                images = album.get("images") or []
                cover_url = images[0].get("url") if images and isinstance(images[0], dict) else None
                ext_ids = trk.get("external_ids") if isinstance(trk.get("external_ids"), dict) else {}

                tracks.append(
                    {
                        "track_id": tid or f"sp_{idx}",
                        "spotify_uri": uri,
                        "track_name": trk.get("name") or trk.get("title") or f"Track {idx}",
                        "artist": artist_names,
                        "album_name": album.get("name") or "",
                        "album_image_url": cover_url,
                        "album_cover_url": cover_url,
                        "duration_ms": int(trk.get("duration_ms") or 0),
                        "preview_url": trk.get("preview_url"),
                        "popularity": trk.get("popularity"),
                        "isrc": ext_ids.get("isrc") or "",
                        "explicit": str(bool(trk.get("explicit"))).lower(),
                    }
                )

            if tracks:
                title = body.get("name") or body.get("title") or f"Spotify Playlist ({playlist_id})"
                return {
                    "playlist_id": playlist_id,
                    "title": title,
                    "tracks": tracks,
                }
        except Exception as exc:
            logger.debug("RapidAPI playlist fetch failed (%s): %s", url, exc)
            continue

    return None


def resolve_preview_url_for_track(track: Dict[str, Any], timeout: int = 8) -> Optional[str]:
    """
    Resolve a streamable 30s preview URL for a track using:
    1. Existing `preview_url` field
    2. Spotify track embed metadata (if 22-char track_id)
    3. Apple iTunes Search API fallback
    """
    existing = str(track.get("preview_url") or "").strip()
    if existing.startswith(("http://", "https://")):
        return existing

    tid = str(track.get("track_id") or "").strip()
    if len(tid) == 22 and not tid.startswith(("sp_", "csv_", "trk_")):
        try:
            sp_resp = requests.get(
                f"https://open.spotify.com/embed/track/{tid}",
                timeout=timeout,
                headers=_REQUEST_HEADERS,
            )
            if sp_resp.status_code == 200:
                m = re.search(
                    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
                    sp_resp.text,
                )
                if m:
                    next_data = json.loads(m.group(1))
                    entity = (
                        next_data.get("props", {})
                        .get("pageProps", {})
                        .get("state", {})
                        .get("data", {})
                        .get("entity", {})
                    )
                    preview = (entity.get("audioPreview") or {}).get("url")
                    if preview:
                        return str(preview)
        except Exception:
            pass

    track_name = str(track.get("track_name") or "").strip()
    artist_name = str(track.get("artist_name") or track.get("artist") or "").strip()
    if not track_name:
        return None

    try:
        term = f"{track_name} {artist_name}".strip()
        resp = requests.get(
            "https://itunes.apple.com/search",
            params={"term": term, "media": "music", "entity": "song", "limit": 1},
            timeout=timeout,
            headers={"Accept": "application/json", **_REQUEST_HEADERS},
        )
        if resp.status_code == 200:
            results = resp.json().get("results") or []
            if results and results[0].get("previewUrl"):
                return str(results[0]["previewUrl"])
    except Exception:
        pass

    return None


def _inspect_cached_audio_meta(cached_path: Path, track: Dict[str, Any]) -> Dict[str, Any]:
    """Read cached audio metadata (estimated duration_ms and full-vs-preview classification)."""
    catalog_ms = _parse_duration_to_ms(track.get("catalog_duration_ms") or track.get("duration_ms"))
    try:
        raw_bytes = cached_path.read_bytes()
    except OSError:
        raw_bytes = b""
    audio_ms = _estimate_audio_duration_ms(raw_bytes, ext=cached_path.suffix)
    audio_kind = _classify_audio_kind(audio_ms, catalog_duration_ms=catalog_ms)
    return {
        "audio_duration_ms": audio_ms,
        "catalog_duration_ms": catalog_ms,
        "audio_kind": audio_kind,
    }


def _save_audio_bytes_to_cache(
    stem: str,
    raw_bytes: bytes,
    ext: str,
) -> Path:
    ensure_cache_dir()
    # Clean older extensions for the same stem when upgrading (e.g., .m4a -> .mp3)
    for old_ext in SUPPORTED_AUDIO_EXTENSIONS:
        old_path = AUDIO_CACHE_DIR / f"{stem}{old_ext}"
        if old_ext != ext and old_path.is_file():
            try:
                old_path.unlink(missing_ok=True)
            except OSError:
                pass

    target_path = AUDIO_CACHE_DIR / f"{stem}{ext}"
    tmp_path = AUDIO_CACHE_DIR / f".tmp_{stem}_{int(time.time() * 1000)}{ext}"
    tmp_path.write_bytes(raw_bytes)
    tmp_path.replace(target_path)
    return target_path


def _download_audio_bytes(url: str, timeout: float = 20.0) -> Optional[Tuple[bytes, str]]:
    """Fetch audio bytes safely, rejecting HTML/JSON error pages and oversized payloads."""
    try:
        resp = requests.get(url, timeout=timeout, headers=_REQUEST_HEADERS, stream=True)
        content_type = resp.headers.get("Content-Type", "")
        low_ct = content_type.lower()
        if resp.status_code not in (200, 206):
            resp.close()
            return None
        if any(bad in low_ct for bad in ("text/html", "application/json", "text/plain")):
            resp.close()
            return None

        chunks: List[bytes] = []
        total = 0
        for chunk in resp.iter_content(chunk_size=65536):
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_PROXY_AUDIO_BYTES:
                resp.close()
                return None
            chunks.append(chunk)
        resp.close()

        raw_bytes = b"".join(chunks)
        if len(raw_bytes) < MIN_VALID_AUDIO_BYTES:
            return None
        return raw_bytes, content_type
    except Exception as exc:
        logger.debug("Audio byte download failed (%s): %s", url, exc)
        return None


def _apply_cached_track_fields(
    updated: Dict[str, Any],
    file_path: Path,
    audio_source: str,
    audio_kind: str,
    audio_duration_ms: Optional[int],
    catalog_duration_ms: Optional[int],
) -> Dict[str, Any]:
    local_url = f"/api/playlist/local-audio/{file_path.name}"
    updated["local_audio_filename"] = file_path.name
    updated["local_audio_url"] = local_url
    updated["stream_url"] = local_url
    updated["audio_cached"] = True
    updated["audio_source"] = audio_source
    updated["audio_kind"] = audio_kind
    if audio_duration_ms is not None:
        updated["audio_duration_ms"] = audio_duration_ms
    if catalog_duration_ms is not None:
        updated["catalog_duration_ms"] = catalog_duration_ms
    return updated


def _download_single_track(
    track: Dict[str, Any],
    download: bool = True,
    prefer_full: bool = True,
) -> Tuple[str, Dict[str, Any]]:
    """
    Ensure local audio file (full via RapidAPI when configured, or 30s preview fallback)
    is available in AUDIO_CACHE_DIR.
    Returns (status_tag, updated_track_dict) where status_tag in {'cache_hit', 'downloaded', 'failed'}.
    """
    updated = dict(track)
    stem = _track_cache_stem(updated)
    rapidapi_active = prefer_full and is_rapidapi_configured()

    cached_path = _find_cached_file_for_stem(stem)
    if cached_path is not None:
        cached_meta = _inspect_cached_audio_meta(cached_path, updated)
        can_resolve_full = rapidapi_active or (prefer_full and is_native_engine_available())
        should_upgrade = prefer_full and download and can_resolve_full and cached_meta["audio_kind"] != "full"
        if not should_upgrade:
            try:
                os.utime(cached_path, None)
            except OSError:
                pass
            _apply_cached_track_fields(
                updated,
                cached_path,
                audio_source="local_cache",
                audio_kind=cached_meta["audio_kind"],
                audio_duration_ms=cached_meta["audio_duration_ms"],
                catalog_duration_ms=cached_meta["catalog_duration_ms"],
            )
            return "cache_hit", updated
    else:
        cached_meta = None

    # 1. Try MusicFab-style RapidAPI full-audio resolution when configured
    rapid_candidate = _resolve_via_rapidapi(updated) if rapidapi_active else None
    if rapid_candidate:
        rapid_url = rapid_candidate["url"]
        catalog_ms = rapid_candidate.get("catalog_duration_ms") or _parse_duration_to_ms(updated.get("duration_ms"))
        if rapid_candidate.get("cover_art_url") and not updated.get("album_cover_url"):
            updated["album_cover_url"] = rapid_candidate["cover_art_url"]

        if download:
            fetched = _download_audio_bytes(rapid_url, timeout=_get_rapidapi_timeout_sec())
            if fetched is not None:
                raw_bytes, content_type = fetched
                ext = rapid_candidate.get("extension") or _guess_extension(rapid_url, content_type)
                if ext not in SUPPORTED_AUDIO_EXTENSIONS:
                    ext = _guess_extension(rapid_url, content_type)
                audio_ms = _estimate_audio_duration_ms(raw_bytes, ext=ext, content_type=content_type)
                kind = _classify_audio_kind(
                    audio_ms,
                    catalog_duration_ms=catalog_ms,
                    url=rapid_url,
                    explicit_kind=rapid_candidate.get("audio_kind"),
                )
                saved_path = _save_audio_bytes_to_cache(stem, raw_bytes, ext)
                _apply_cached_track_fields(
                    updated,
                    saved_path,
                    audio_source=rapid_candidate["source"],
                    audio_kind=kind,
                    audio_duration_ms=audio_ms or catalog_ms,
                    catalog_duration_ms=catalog_ms,
                )
                return "downloaded", updated
        else:
            updated["stream_url"] = _build_proxy_url(rapid_url, updated, rapid_candidate.get("extension") or ".mp3")
            updated["audio_cached"] = False
            updated["audio_source"] = rapid_candidate["source"]
            updated["audio_kind"] = rapid_candidate.get("audio_kind") or "full"
            if catalog_ms:
                updated["catalog_duration_ms"] = catalog_ms
            updated["local_audio_url"] = None
            return "cache_hit", updated

    # 2. Try Spodown / SpotDL Native Full-Audio Engine (yt-dlp + ffmpeg) when prefer_full
    if prefer_full and is_native_engine_available():
        native_candidate = _resolve_via_native_engine(updated, download=download)
        if native_candidate:
            catalog_ms = native_candidate.get("catalog_duration_ms") or _parse_duration_to_ms(updated.get("duration_ms"))
            if native_candidate.get("cover_art_url") and not updated.get("album_cover_url"):
                updated["album_cover_url"] = native_candidate["cover_art_url"]

            if download and "file_path" in native_candidate:
                saved_path = native_candidate["file_path"]
                _apply_cached_track_fields(
                    updated,
                    saved_path,
                    audio_source=native_candidate["source"],
                    audio_kind=native_candidate["audio_kind"],
                    audio_duration_ms=native_candidate.get("audio_duration_ms") or catalog_ms,
                    catalog_duration_ms=catalog_ms,
                )
                return "downloaded", updated
            elif not download and "url" in native_candidate:
                native_url = native_candidate["url"]
                updated["stream_url"] = _build_proxy_url(native_url, updated, native_candidate.get("extension") or ".mp3")
                updated["audio_cached"] = False
                updated["audio_source"] = native_candidate["source"]
                updated["audio_kind"] = native_candidate.get("audio_kind") or "full"
                if catalog_ms:
                    updated["catalog_duration_ms"] = catalog_ms
                updated["local_audio_url"] = None
                return "cache_hit", updated

    # 3. If upgrading an existing cached preview failed, keep serving the existing cached file
    if cached_path is not None and cached_meta is not None:
        try:
            os.utime(cached_path, None)
        except OSError:
            pass
        _apply_cached_track_fields(
            updated,
            cached_path,
            audio_source="local_cache",
            audio_kind=cached_meta["audio_kind"],
            audio_duration_ms=cached_meta["audio_duration_ms"],
            catalog_duration_ms=cached_meta["catalog_duration_ms"],
        )
        return "cache_hit", updated

    # 4. Fallback to existing 30s preview pipeline (preserves test_api.py monkeypatch compatibility)
    preview_url = resolve_preview_url_for_track(updated)
    if preview_url:
        updated["preview_url"] = preview_url

    if not download or not preview_url:
        updated["audio_cached"] = False
        updated["audio_source"] = "remote_stream" if preview_url else "unavailable"
        updated["audio_kind"] = "preview" if preview_url else "unavailable"
        updated["stream_url"] = preview_url
        updated["local_audio_url"] = None
        return ("failed" if download else "cache_hit"), updated

    try:
        resp = requests.get(preview_url, timeout=12, headers=_REQUEST_HEADERS, stream=False)
        content_type = resp.headers.get("Content-Type", "")
        raw_bytes = resp.content or b""
        if (
            resp.status_code in (200, 206)
            and len(raw_bytes) >= MIN_VALID_AUDIO_BYTES
            and "text/html" not in content_type.lower()
        ):
            ext = _guess_extension(preview_url, content_type)
            target_path = _save_audio_bytes_to_cache(stem, raw_bytes, ext)
            audio_ms = _estimate_audio_duration_ms(raw_bytes, ext=ext, content_type=content_type)
            catalog_ms = _parse_duration_to_ms(updated.get("duration_ms"))
            kind = _classify_audio_kind(audio_ms, catalog_duration_ms=catalog_ms, url=preview_url)
            _apply_cached_track_fields(
                updated,
                target_path,
                audio_source="downloaded_local",
                audio_kind=kind,
                audio_duration_ms=audio_ms,
                catalog_duration_ms=catalog_ms,
            )
            return "downloaded", updated
    except Exception as exc:
        logger.debug("Audio download failed for %s: %s", updated.get("track_name"), exc)

    updated["audio_cached"] = False
    updated["audio_source"] = "remote_stream" if preview_url else "unavailable"
    updated["audio_kind"] = "preview" if preview_url else "unavailable"
    updated["stream_url"] = preview_url
    updated["local_audio_url"] = None
    return "failed", updated


def resolve_single_track_audio(
    track: Dict[str, Any],
    prefer_full: bool = True,
    cache_locally: bool = True,
) -> Dict[str, Any]:
    """
    Resolve a single track for GlobalAudioBar playback (MusicFab /api/spotify pattern).
    Returns stream_url (local cache or CORS-safe /api/audio/proxy), audio_kind ('full'|'preview'|'unavailable'),
    audio_duration_ms, catalog_duration_ms, and album_cover_url.
    """
    status, resolved = _download_single_track(track, download=cache_locally, prefer_full=prefer_full)

    if cache_locally and resolved.get("local_audio_filename"):
        enforce_cache_limit(
            protected_filenames=[str(resolved["local_audio_filename"])],
            max_files=MAX_LOCAL_AUDIO_FILES,
        )

    stream_url = resolved.get("local_audio_url") or resolved.get("stream_url") or resolved.get("preview_url")
    if (
        not cache_locally
        and stream_url
        and stream_url.startswith(("http://", "https://"))
        and is_valid_external_audio_url(stream_url)
    ):
        stream_url = _build_proxy_url(stream_url, resolved)

    return {
        "status": "ok" if stream_url else "unavailable",
        "cache_status": status,
        "track_id": resolved.get("track_id"),
        "stream_url": stream_url,
        "local_audio_url": resolved.get("local_audio_url"),
        "preview_url": resolved.get("preview_url"),
        "album_cover_url": resolved.get("album_cover_url"),
        "audio_cached": bool(resolved.get("audio_cached")),
        "audio_source": resolved.get("audio_source", "unavailable"),
        "audio_kind": resolved.get("audio_kind", "unavailable"),
        "audio_duration_ms": resolved.get("audio_duration_ms"),
        "catalog_duration_ms": resolved.get("catalog_duration_ms"),
        "rapidapi_configured": is_rapidapi_configured(),
    }


def enforce_cache_limit(
    protected_filenames: Optional[Iterable[str]] = None,
    max_files: int = MAX_LOCAL_AUDIO_FILES,
) -> int:
    """
    Prune oldest audio files from AUDIO_CACHE_DIR so total cached files <= max_files (20),
    keeping tracks belonging to the currently active mix protected when possible.
    """
    ensure_cache_dir()
    protected: Set[str] = {name for name in (protected_filenames or []) if name}

    with _cache_lock:
        files = [
            p
            for p in AUDIO_CACHE_DIR.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS
        ]
        # Clean stray partial files
        for tmp in AUDIO_CACHE_DIR.glob(".tmp_*"):
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

        if len(files) <= max_files:
            return len(files)

        # Sort oldest mtime first, preferring evicting non-protected files
        files.sort(key=lambda p: (p.name in protected, p.stat().st_mtime))
        excess = len(files) - max_files
        removed = 0
        for p in files:
            if removed >= excess:
                break
            try:
                p.unlink(missing_ok=True)
                removed += 1
            except OSError:
                pass

        remaining = [
            p
            for p in AUDIO_CACHE_DIR.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS
        ]
        return len(remaining)


def download_playlist_audio_batch(
    tracks: List[Dict[str, Any]],
    max_tracks: int = MAX_LOCAL_AUDIO_FILES,
    download: bool = True,
    prefer_full: bool = True,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Resolve & download audio files locally for up to `max_tracks` (strictly capped at 20).
    Uses concurrent fetching and classifies full vs preview tracks.
    """
    capped = max(1, min(MAX_LOCAL_AUDIO_FILES, int(max_tracks or MAX_LOCAL_AUDIO_FILES)))
    target_tracks = list(tracks[:capped])
    results: List[Optional[Dict[str, Any]]] = [None] * len(target_tracks)

    downloaded_count = 0
    cache_hits = 0
    failed_count = 0
    protected_files: List[str] = []

    if target_tracks:
        workers = min(6, len(target_tracks))
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {
                executor.submit(_download_single_track, trk, download, prefer_full): idx
                for idx, trk in enumerate(target_tracks)
            }
            for fut in as_completed(future_map):
                idx = future_map[fut]
                try:
                    status, upd = fut.result()
                except Exception:
                    status = "failed"
                    upd = dict(target_tracks[idx])
                    upd["audio_cached"] = False
                    upd["audio_kind"] = "unavailable"
                    upd["local_audio_url"] = None

                results[idx] = upd
                if status == "downloaded":
                    downloaded_count += 1
                elif status == "cache_hit":
                    cache_hits += 1
                else:
                    failed_count += 1

                if upd.get("local_audio_filename"):
                    protected_files.append(str(upd["local_audio_filename"]))

    final_tracks = [r if r is not None else dict(target_tracks[i]) for i, r in enumerate(results)]
    total_on_disk = enforce_cache_limit(protected_filenames=protected_files, max_files=MAX_LOCAL_AUDIO_FILES)

    stats = {
        "requested": len(final_tracks),
        "downloaded": downloaded_count,
        "cache_hits": cache_hits,
        "ready_local": sum(1 for t in final_tracks if t.get("audio_cached")),
        "full_count": sum(1 for t in final_tracks if t.get("audio_kind") == "full"),
        "preview_count": sum(1 for t in final_tracks if t.get("audio_kind") == "preview"),
        "failed": failed_count,
        "total_cached_on_disk": total_on_disk,
        "max_limit": MAX_LOCAL_AUDIO_FILES,
        "rapidapi_configured": is_rapidapi_configured(),
    }
    return final_tracks, stats


def get_cached_audio_path(filename: str) -> Optional[Path]:
    """Safely resolve a filename inside AUDIO_CACHE_DIR against path traversal."""
    ensure_cache_dir()
    clean_name = Path(filename).name
    if clean_name != filename or clean_name.startswith("."):
        return None
    if Path(clean_name).suffix.lower() not in SUPPORTED_AUDIO_EXTENSIONS:
        return None
    target = (AUDIO_CACHE_DIR / clean_name).resolve()
    try:
        target.relative_to(AUDIO_CACHE_DIR.resolve())
    except ValueError:
        return None
    return target if target.is_file() else None


def get_audio_cache_status() -> Dict[str, Any]:
    """Return summary of local audio files stored in data/audio_cache."""
    ensure_cache_dir()
    files = sorted(
        [
            p
            for p in AUDIO_CACHE_DIR.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS
        ],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    total_bytes = sum(p.stat().st_size for p in files)
    return {
        "cached_files": len(files),
        "max_limit": MAX_LOCAL_AUDIO_FILES,
        "total_size_mb": round(total_bytes / (1024 * 1024), 2),
        "files": [p.name for p in files],
    }


def clear_audio_cache() -> Dict[str, Any]:
    """Delete all locally cached audio files and return deleted count."""
    ensure_cache_dir()
    deleted = 0
    with _cache_lock:
        for p in AUDIO_CACHE_DIR.iterdir():
            if p.is_file() and (
                p.suffix.lower() in SUPPORTED_AUDIO_EXTENSIONS or p.name.startswith(".tmp_")
            ):
                try:
                    p.unlink(missing_ok=True)
                    deleted += 1
                except OSError:
                    pass
    return {"deleted_files": deleted, "cached_files": 0, "max_limit": MAX_LOCAL_AUDIO_FILES}
