"""Integration tests for FastAPI Backend endpoints using TestClient."""

from pathlib import Path
from fastapi.testclient import TestClient
import pytest

from backend.app import app


@pytest.fixture(scope="module")
def client():
    """Initialize TestClient with lifespan context to load the model once."""
    with TestClient(app) as test_client:
        yield test_client


def test_health_check(client: TestClient):
    """Verify /api/v1/health returns 200 with loaded model metadata and relative artifact_path."""
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["model_loaded"] is True
    assert data["total_tracks"] > 0
    assert data["artifact_path"] is not None
    assert not Path(data["artifact_path"]).is_absolute()


def test_search_tracks(client: TestClient):
    """Verify /api/v1/search?q=a&limit=5 returns tracks with embed URL and 9 rounded audio features."""
    response = client.get("/api/v1/search", params={"q": "a", "limit": 5})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert data["total"] == len(data["results"])
    assert len(data["results"]) == 5

    for idx, item in enumerate(data["results"], start=1):
        assert item["rank"] == idx
        assert item["track_id"]
        assert item["spotify_embed_url"].startswith(
            "https://open.spotify.com/embed/track/"
        )
        assert item["audio_features"] is not None
        assert len(item["audio_features"]) == 9
        for val in item["audio_features"].values():
            assert isinstance(val, float)
            assert round(val, 4) == val


def test_get_track_details_valid_and_404(client: TestClient):
    """Verify /api/v1/tracks/{track_id} returns 200 for a valid ID and 404 with detail for unknown ID."""
    pop_res = client.get("/api/v1/recommend/popular", params={"k": 1})
    assert pop_res.status_code == 200
    valid_track_id = pop_res.json()["recommendations"][0]["track_id"]

    valid_res = client.get(f"/api/v1/tracks/{valid_track_id}")
    assert valid_res.status_code == 200
    track_data = valid_res.json()
    assert track_data["track_id"] == valid_track_id
    assert track_data["audio_features"] is not None

    not_found_res = client.get("/api/v1/tracks/non_existent_id_999")
    assert not_found_res.status_code == 404
    err_data = not_found_res.json()
    assert "detail" in err_data
    assert "Track ID not found" in err_data["detail"]
    assert "non_existent_id_999" in err_data["detail"]


def test_recommend_by_track_strategies(client: TestClient):
    """Verify /api/v1/recommend/track/{track_id} across audio, hybrid, and mmr strategies."""
    pop_res = client.get("/api/v1/recommend/popular", params={"k": 1})
    seed_id = pop_res.json()["recommendations"][0]["track_id"]

    for strategy in ("audio", "hybrid", "mmr"):
        response = client.get(
            f"/api/v1/recommend/track/{seed_id}",
            params={"k": 5, "strategy": strategy},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "success"
        assert data["mode"] == strategy
        assert data["seed_track"]["track_id"] == seed_id

        recs = data["recommendations"]
        assert len(recs) == 5
        rec_ids = {item["track_id"] for item in recs}
        assert seed_id not in rec_ids

        for idx, item in enumerate(recs, start=1):
            assert item["rank"] == idx
            assert item["similarity_score"] is not None
            assert 0.0 <= item["similarity_score"] <= 1.0
            assert item["audio_features"] is not None
            if strategy == "mmr":
                assert item["mmr_score"] is not None
            else:
                assert item["mmr_score"] is None


def test_recommend_mmr_similarity_score_non_negative(client: TestClient):
    """Verify strategy=mmr returns non-negative hybrid similarity_score even with high diversity weight."""
    pop_res = client.get("/api/v1/recommend/popular", params={"k": 1})
    seed_id = pop_res.json()["recommendations"][0]["track_id"]

    response = client.get(
        f"/api/v1/recommend/track/{seed_id}",
        params={"k": 10, "strategy": "mmr", "mmr_lambda": 0.3},
    )
    assert response.status_code == 200
    data = response.json()
    recs = data["recommendations"]
    assert len(recs) == 10
    for item in recs:
        assert item["similarity_score"] is not None
        assert 0.0 <= item["similarity_score"] <= 1.0
        assert item["mmr_score"] is not None


def test_recommend_by_track_404(client: TestClient):
    """Verify /api/v1/recommend/track/invalid_id returns 404 and checks detail content."""
    response = client.get("/api/v1/recommend/track/invalid_id")
    assert response.status_code == 404
    err_data = response.json()
    assert "detail" in err_data
    assert "Track ID not found" in err_data["detail"]
    assert "invalid_id" in err_data["detail"]


def test_recommend_taste_profile(client: TestClient):
    """Verify POST /api/v1/recommend/profile with valid track IDs and deduplication."""
    pop_res = client.get("/api/v1/recommend/popular", params={"k": 2})
    assert pop_res.status_code == 200
    track_ids = [item["track_id"] for item in pop_res.json()["recommendations"]]
    assert len(track_ids) == 2

    # Send with a duplicate ID to verify deduplication
    response = client.post(
        "/api/v1/recommend/profile",
        json={"track_ids": [track_ids[0], track_ids[1], track_ids[0]], "k": 5},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert len(data["seed_tracks"]) == 2
    assert len(data["recommendations"]) == 5
    rec_ids = {item["track_id"] for item in data["recommendations"]}
    for tid in track_ids:
        assert tid not in rec_ids


def test_recommend_taste_profile_404(client: TestClient):
    """Verify POST /api/v1/recommend/profile with unknown track_id returns 404 and checks detail."""
    response = client.post(
        "/api/v1/recommend/profile",
        json={"track_ids": ["non_existent_track_999"], "k": 5},
    )
    assert response.status_code == 404
    err_data = response.json()
    assert "detail" in err_data
    assert "Track ID not found" in err_data["detail"]
    assert "non_existent_track_999" in err_data["detail"]


def test_recommend_popular(client: TestClient):
    """Verify /api/v1/recommend/popular?k=10 returns 200 and 10 tracks."""
    response = client.get("/api/v1/recommend/popular", params={"k": 10})
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "success"
    assert len(data["recommendations"]) == 10


def test_recommend_mood_valid_and_400(client: TestClient):
    """Verify /api/v1/recommend/mood/happy?k=5 returns 200 and invalid_mood returns 400 with detail."""
    valid_res = client.get("/api/v1/recommend/mood/happy", params={"k": 5})
    assert valid_res.status_code == 200
    data = valid_res.json()
    assert data["status"] == "success"
    assert len(data["recommendations"]) == 5
    for item in data["recommendations"]:
        assert item["similarity_score"] is not None

    invalid_res = client.get("/api/v1/recommend/mood/invalid_mood", params={"k": 5})
    assert invalid_res.status_code == 400
    err_data = invalid_res.json()
    assert "detail" in err_data
    assert "Unsupported mood" in err_data["detail"]
    assert "invalid_mood" in err_data["detail"]


def test_validation_422_errors(client: TestClient):
    """Verify 422 Unprocessable Entity and detail structure for k out of range, invalid strategy, empty track_ids, and >50 track_ids."""
    pop_res = client.get("/api/v1/recommend/popular", params={"k": 1})
    seed_id = pop_res.json()["recommendations"][0]["track_id"]

    # 1. k out of bounds (k=0 and k=51)
    for invalid_k in (0, 51):
        res_k = client.get(
            f"/api/v1/recommend/track/{seed_id}", params={"k": invalid_k}
        )
        assert res_k.status_code == 422
        detail_k = res_k.json().get("detail")
        assert isinstance(detail_k, list) and len(detail_k) > 0
        assert any("k" in err.get("loc", []) for err in detail_k)

    # 2. Invalid strategy
    res_strategy = client.get(
        f"/api/v1/recommend/track/{seed_id}",
        params={"k": 5, "strategy": "invalid_strategy"},
    )
    assert res_strategy.status_code == 422
    detail_strategy = res_strategy.json().get("detail")
    assert isinstance(detail_strategy, list) and len(detail_strategy) > 0
    assert any("strategy" in err.get("loc", []) for err in detail_strategy)

    # 3. Empty track_ids list
    res_empty = client.post(
        "/api/v1/recommend/profile", json={"track_ids": [], "k": 5}
    )
    assert res_empty.status_code == 422
    detail_empty = res_empty.json().get("detail")
    assert isinstance(detail_empty, list) and len(detail_empty) > 0
    assert any("track_ids" in err.get("loc", []) for err in detail_empty)

    # 4. track_ids exceeding max_length=50
    res_too_many = client.post(
        "/api/v1/recommend/profile",
        json={"track_ids": [seed_id] * 51, "k": 5},
    )
    assert res_too_many.status_code == 422
    detail_many = res_too_many.json().get("detail")
    assert isinstance(detail_many, list) and len(detail_many) > 0
    assert any("track_ids" in err.get("loc", []) for err in detail_many)


def test_playlist_dj_mix_and_20_limit(client: TestClient, tmp_path, monkeypatch):
    """Verify AI DJ Mix sequencing, strict 20-audio cap, local file caching & audio serving."""
    import backend.audio_cache as audio_cache_mod

    monkeypatch.setattr(audio_cache_mod, "AUDIO_CACHE_DIR", tmp_path)
    monkeypatch.setattr(
        audio_cache_mod,
        "resolve_preview_url_for_track",
        lambda trk, timeout=8: f"https://cdn.example.com/{trk['track_id']}.mp3",
    )

    class _FakeResp:
        status_code = 200
        headers = {"Content-Type": "audio/mpeg"}
        content = b"ID3" + (b"\x00" * 5000)

    monkeypatch.setattr(
        audio_cache_mod.requests,
        "get",
        lambda *args, **kwargs: _FakeResp(),
    )

    pop_res = client.get("/api/v1/recommend/popular", params={"k": 25})
    assert pop_res.status_code == 200
    tracks = pop_res.json()["recommendations"]
    assert len(tracks) == 25

    # Exceeding max_tracks=20 must fail Pydantic validation (422)
    over_limit_res = client.post(
        "/api/playlist/make-mix",
        json={"tracks": tracks, "max_tracks": 25},
    )
    assert over_limit_res.status_code == 422

    # Making DJ mix from 25 tracks capped at 20 tracks with local downloads & mix_plan
    mix_res = client.post(
        "/api/playlist/make-mix",
        json={
            "tracks": tracks,
            "model": "dj_mix",
            "max_tracks": 20,
            "selection_mode": "smart_cohesive",
            "auto_download": True,
        },
    )
    assert mix_res.status_code == 200
    data = mix_res.json()
    assert data["max_audio_limit"] == 20
    assert len(data["tracks"]) == 20
    assert data["download_stats"]["ready_local"] == 20
    assert data["download_stats"]["total_cached_on_disk"] <= 20
    assert "avg_smoothness_percent" in data

    first_track = data["tracks"][0]
    assert first_track["audio_cached"] is True
    assert first_track["local_audio_url"].startswith("/api/playlist/local-audio/")
    assert first_track["mix_plan"] is not None
    assert "recommended_crossfade_sec" in first_track["mix_plan"]
    assert "tempo_sync_ratio" in first_track["mix_plan"]

    # Local audio streaming endpoint works cleanly with audio MIME type
    audio_file_res = client.get(first_track["local_audio_url"])
    assert audio_file_res.status_code == 200
    assert audio_file_res.headers["content-type"].startswith("audio/")

    status_res = client.get("/api/playlist/local-audio/status")
    assert status_res.status_code == 200
    assert status_res.json()["cached_files"] == 20
    assert status_res.json()["max_limit"] == 20

    # Clear cache endpoint removes files cleanly
    clear_res = client.delete("/api/playlist/local-audio/cache")
    assert clear_res.status_code == 200
    assert clear_res.json()["cached_files"] == 0


def _make_fake_wav(duration_sec: int, byte_rate: int = 16000) -> bytes:
    """Construct minimal valid RIFF WAVE header declaring exact duration without large buffers."""
    import struct

    data_size = duration_sec * byte_rate
    fmt_chunk = struct.pack("<4sIHHIIHH", b"fmt ", 16, 1, 1, 8000, byte_rate, 2, 16)
    data_header = struct.pack("<4sI", b"data", data_size)
    riff_header = struct.pack("<4sI4s", b"RIFF", 36 + 4096, b"WAVE")
    return riff_header + fmt_chunk + data_header + (b"\x00" * 4096)


def test_audio_config_endpoint(client: TestClient, monkeypatch):
    """Verify /api/audio/config exposes mode without leaking RAPIDAPI_KEY."""
    import backend.audio_cache as audio_cache_mod

    # Case 1: Pure fallback (no RapidAPI key and no native engine)
    monkeypatch.delenv("RAPIDAPI_KEY", raising=False)
    monkeypatch.setattr(audio_cache_mod, "yt_dlp", None)
    res_off = client.get("/api/audio/config")
    assert res_off.status_code == 200
    cfg_off = res_off.json()
    assert cfg_off["rapidapi_configured"] is False
    assert cfg_off["mode"] == "preview_fallback"
    assert "RAPIDAPI_KEY" not in cfg_off

    # Case 2: RapidAPI configured without native engine
    monkeypatch.setenv("RAPIDAPI_KEY", "secret-test-key-123")
    res_on = client.get("/api/audio/config")
    assert res_on.status_code == 200
    cfg_on = res_on.json()
    assert cfg_on["rapidapi_configured"] is True
    assert cfg_on["mode"] == "full_rapidapi"
    assert "secret-test-key-123" not in str(cfg_on)

    # Case 3: Hybrid mode when native yt-dlp engine is active
    monkeypatch.setattr(audio_cache_mod, "yt_dlp", object())
    res_hybrid = client.get("/api/audio/config")
    assert res_hybrid.status_code == 200
    cfg_hybrid = res_hybrid.json()
    assert cfg_hybrid["mode"] == "hybrid_full"
    assert cfg_hybrid["native_engine_available"] is True


def test_audio_resolve_rapidapi_full_and_cache_upgrade(client: TestClient, tmp_path, monkeypatch):
    """Verify RapidAPI fallback chain, full-vs-preview classification, and upgrading cached 30s preview to full."""
    import backend.audio_cache as audio_cache_mod

    monkeypatch.setattr(audio_cache_mod, "AUDIO_CACHE_DIR", tmp_path)
    monkeypatch.setenv("RAPIDAPI_KEY", "test-rapidapi-key")

    track_id = "6rqhFgbbKwnb9MLmUQDhG6"
    # Seed cache with a 30s preview WAV first
    preview_wav = _make_fake_wav(duration_sec=30)
    (tmp_path / f"{track_id}.wav").write_bytes(preview_wav)

    full_wav = _make_fake_wav(duration_sec=195)

    class _MockResponse:
        def __init__(self, status_code: int, json_body=None, content: bytes = b"", headers=None):
            self.status_code = status_code
            self._json = json_body
            self.content = content
            self.headers = headers or {}

        def json(self):
            return self._json

        def iter_content(self, chunk_size=65536):
            for idx in range(0, len(self.content), chunk_size):
                yield self.content[idx : idx + chunk_size]

        def close(self):
            return None

    def _fake_request(method, url, **kwargs):
        if "spotify-mp3-converter-downloader" in url:
            return _MockResponse(404)
        if "spotify-downloader9" in url:
            return _MockResponse(
                200,
                json_body={
                    "success": True,
                    "data": {
                        "title": "Test Full Track",
                        "artist": "Test Artist",
                        "duration_ms": 195000,
                        "downloadLink": "https://cdn.example.com/audio/full_track.wav",
                    },
                },
            )
        return _MockResponse(404)

    def _fake_get(url, **kwargs):
        if "cdn.example.com/audio/full_track.wav" in url:
            return _MockResponse(
                200,
                content=full_wav,
                headers={"Content-Type": "audio/wav"},
            )
        return _MockResponse(404)

    monkeypatch.setattr(audio_cache_mod.requests, "request", _fake_request)
    monkeypatch.setattr(audio_cache_mod.requests, "get", _fake_get)

    res = client.post(
        "/api/audio/resolve",
        json={
            "track_id": track_id,
            "track_name": "Test Full Track",
            "artist_name": "Test Artist",
            "duration_ms": 195000,
            "prefer_full": True,
            "cache_locally": True,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["audio_kind"] == "full"
    assert body["audio_source"] == "rapidapi_backup"
    assert body["audio_duration_ms"] >= 190000
    assert body["audio_cached"] is True
    assert body["stream_url"] == f"/api/playlist/local-audio/{track_id}.wav"


def test_audio_proxy_ssrf_and_streaming(client: TestClient, monkeypatch):
    """Verify /api/audio/proxy blocks SSRF/Spotify URLs and streams valid upstream audio."""
    import backend.app as app_mod

    for blocked in (
        "http://127.0.0.1:8000/secret",
        "http://localhost/admin",
        "http://169.254.169.254/latest/meta-data/",
        "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6",
    ):
        res = client.get("/api/audio/proxy", params={"url": blocked})
        assert res.status_code == 400

    class _StreamResp:
        status_code = 200
        headers = {"Content-Type": "audio/mpeg", "Content-Length": "4100", "Accept-Ranges": "bytes"}

        def iter_content(self, chunk_size=65536):
            yield b"ID3" + (b"\x00" * 4097)

        def close(self):
            return None

    monkeypatch.setattr(app_mod, "is_safe_proxy_url", lambda u: u.startswith("https://cdn.example.com/"))
    monkeypatch.setattr(app_mod.requests, "get", lambda *a, **kw: _StreamResp())

    ok_res = client.get(
        "/api/audio/proxy",
        params={"url": "https://cdn.example.com/song.mp3", "filename": "Artist - Song.mp3"},
    )
    assert ok_res.status_code == 200
    assert ok_res.headers["content-type"].startswith("audio/mpeg")
    assert ok_res.headers["accept-ranges"] == "bytes"
    assert ok_res.content.startswith(b"ID3")


def test_mp3_xing_duration_parser():
    """Verify pure-Python MP3 Xing VBR parser distinguishes full tracks from 30s previews."""
    import struct
    import backend.audio_cache as audio_cache_mod

    # MPEG-1 (version_id=3), Layer III (layer=1), 128 kbps (idx=9), 44100 Hz (idx=0), stereo (mode=0)
    frame_hdr = bytes([0xFF, 0xFB, 0x90, 0x00])
    side_info = b"\x00" * 32
    xing = b"Xing" + struct.pack(">II", 0x01, 8000)  # 8000 frames * 1152 / 44100 ≈ 208.98s
    fake_mp3 = frame_hdr + side_info + xing + (b"\x00" * 4500)

    dur_ms = audio_cache_mod._estimate_audio_duration_ms(fake_mp3, ext=".mp3")
    assert dur_ms is not None
    assert 208_000 <= dur_ms <= 210_000
    assert audio_cache_mod._classify_audio_kind(dur_ms) == "full"
    assert audio_cache_mod._classify_audio_kind(30_000) == "preview"
