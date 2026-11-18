"""FastAPI Backend Server for Embeat Music Recommender System."""

from contextlib import asynccontextmanager
import hashlib
import json
import logging
import math
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable, Dict, List, Literal, Optional
from urllib.parse import urljoin

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
import requests

from backend.audio_cache import (
    MAX_LOCAL_AUDIO_FILES,
    MAX_PROXY_AUDIO_BYTES,
    clear_audio_cache,
    download_playlist_audio_batch,
    fetch_rapidapi_playlist_metadata,
    get_audio_cache_status,
    get_audio_resolver_config,
    get_cached_audio_path,
    is_safe_proxy_url,
    resolve_single_track_audio,
)
from backend.schemas import (
    AudioFeatures,
    HealthResponse,
    RecommendationResponse,
    SearchResponse,
    TasteProfileRequest,
    TrackItem,
)
from src.playlist_mixer import (
    MAX_LOCAL_AUDIO_LIMIT,
    compute_standardized_vector,
    curate_tracks_for_mix,
    optimize_dj_sequence,
)
from src.preprocess import AUDIO_FEATURES
from src.recommender import EmbeatRecommender

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ARTIFACT_PATH = PROJECT_ROOT / "artifacts" / "embeat_recommender.joblib"
FALLBACK_CSV_PATHS = [
    PROJECT_ROOT / "data" / "processed" / "balanced_eda.csv",
    PROJECT_ROOT / "data" / "processed" / "embeat_sample_tracks.csv",
    PROJECT_ROOT / "data" / "processed" / "sample_tracks.csv",
]

AUDIO_FEATURE_FIELDS = (
    "danceability",
    "energy",
    "valence",
    "tempo",
    "acousticness",
    "instrumentalness",
    "liveness",
    "speechiness",
    "loudness",
)

SCORE_COLUMNS = (
    "hybrid_similarity",
    "similarity",
    "mood_similarity",
)

# Thread-safe singleton model state initialized once during startup lifespan
_model_lock = threading.Lock()
model: Optional[EmbeatRecommender] = None
model_mode: str = "unloaded"
loaded_artifact_path: Optional[str] = None
popularity_is_unit_scale: bool = True


def _detect_unit_popularity_scale(df: pd.DataFrame) -> bool:
    """Return True if dataset popularity column uses 0.0..1.0 unit scale instead of 0..100."""
    if df is None or "popularity" not in df.columns:
        return True
    pop_series = pd.to_numeric(df["popularity"], errors="coerce").dropna()
    if pop_series.empty:
        return True
    return float(pop_series.max()) <= 1.0


def _to_relative_path(path: Path) -> str:
    """Return path relative to PROJECT_ROOT using POSIX slashes, or basename if outside."""
    try:
        return path.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return path.name


def _load_model_once() -> EmbeatRecommender:
    """Thread-safely load the EmbeatRecommender artifact or fallback to CSV dataset."""
    global model, model_mode, loaded_artifact_path, popularity_is_unit_scale

    if model is not None and model.df is not None:
        return model

    with _model_lock:
        if model is not None and model.df is not None:
            return model

        if ARTIFACT_PATH.exists():
            try:
                logger.info("Loading model artifact from %s", ARTIFACT_PATH)
                model = EmbeatRecommender.load_artifact(ARTIFACT_PATH)
                model_mode = "artifact_joblib"
                loaded_artifact_path = _to_relative_path(ARTIFACT_PATH)
                popularity_is_unit_scale = _detect_unit_popularity_scale(model.df)
                return model
            except Exception as exc:
                logger.warning(
                    "Failed to load artifact %s (%s). Falling back to CSV...",
                    ARTIFACT_PATH,
                    exc,
                )

        for csv_path in FALLBACK_CSV_PATHS:
            if csv_path.exists():
                logger.info("Fitting fallback model from CSV %s", csv_path)
                df = pd.read_csv(csv_path)
                recommender = EmbeatRecommender()
                recommender.fit(df)
                model = recommender
                model_mode = "fallback_csv"
                loaded_artifact_path = _to_relative_path(csv_path)
                popularity_is_unit_scale = _detect_unit_popularity_scale(model.df)
                return model

        raise RuntimeError(
            "Could not load model: neither artifacts/embeat_recommender.joblib "
            "nor fallback CSV files in data/processed/ were found."
        )


def _get_model() -> EmbeatRecommender:
    """Retrieve the active recommender model, ensuring it is loaded."""
    if model is None or model.df is None:
        return _load_model_once()
    return model


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    """FastAPI lifespan handler to load the recommendation model once at startup."""
    loaded = _load_model_once()
    app_instance.state.model = loaded
    app_instance.state.mode = model_mode
    app_instance.state.artifact_path = loaded_artifact_path
    yield


app = FastAPI(
    title="Embeat Music Recommender API",
    description="Content-Based & Hybrid Music Recommendation REST API powered by Embeat 45M Spotify Tracks.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges"],
)


def _clean_scalar(value: Any) -> Any:
    """Convert NaN, np.nan, or +/-inf values to None and normalize numpy scalars."""
    if value is None:
        return None
    if isinstance(value, (float, np.floating)):
        if math.isnan(value) or math.isinf(value):
            return None
        return float(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (str, bytes, dict, list, tuple, set)):
        return value
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return value


def _normalize_popularity(raw_pop: Any) -> Optional[int]:
    """Convert popularity to integer (handling both 0..1 float scale and 0..100 int scale)."""
    cleaned_pop = _clean_scalar(raw_pop)
    if cleaned_pop is None:
        return None
    try:
        if isinstance(raw_pop, (int, np.integer)) and not isinstance(raw_pop, bool):
            return int(raw_pop)
        pop_float = float(cleaned_pop)
        if math.isnan(pop_float) or math.isinf(pop_float):
            return None
        if 0.0 < pop_float < 1.0 or (
            popularity_is_unit_scale
            and 0.0 <= pop_float <= 1.0
            and isinstance(raw_pop, (float, np.floating))
        ):
            return int(round(pop_float * 100))
        return int(round(pop_float))
    except (TypeError, ValueError):
        return None


def _extract_audio_features(cleaned: Dict[str, Any]) -> Optional[AudioFeatures]:
    """Extract and round the 9 acoustic features if present."""
    if all(feat in cleaned and cleaned[feat] is not None for feat in AUDIO_FEATURE_FIELDS):
        return AudioFeatures(
            **{feat: round(float(cleaned[feat]), 4) for feat in AUDIO_FEATURE_FIELDS}
        )
    raw_af = cleaned.get("audio_features")
    if isinstance(raw_af, AudioFeatures):
        af_dict = raw_af.model_dump()
        return AudioFeatures(
            **{feat: round(float(af_dict[feat]), 4) for feat in AUDIO_FEATURE_FIELDS}
        )
    if isinstance(raw_af, dict):
        af_clean = {k: _clean_scalar(v) for k, v in raw_af.items()}
        if all(feat in af_clean and af_clean[feat] is not None for feat in AUDIO_FEATURE_FIELDS):
            return AudioFeatures(
                **{feat: round(float(af_clean[feat]), 4) for feat in AUDIO_FEATURE_FIELDS}
            )
    return None


def _row_to_track_item(row: dict, rank: int | None = None) -> TrackItem:
    """Convert a track dictionary row into a validated TrackItem schema."""
    cleaned: Dict[str, Any] = {k: _clean_scalar(v) for k, v in row.items()}

    track_id = str(cleaned.get("track_id") or "")
    track_name = str(cleaned.get("track_name") or "Unknown Track")

    artist_name = cleaned.get("artist_name")
    if artist_name is not None:
        artist_name = str(artist_name)

    artist_genres = cleaned.get("artist_genres")
    if artist_genres is not None:
        artist_genres = str(artist_genres)

    popularity = _normalize_popularity(row.get("popularity"))

    similarity_score: Optional[float] = None
    for col in SCORE_COLUMNS:
        if col in cleaned and cleaned[col] is not None:
            similarity_score = round(float(cleaned[col]), 4)
            break
    if similarity_score is None and cleaned.get("similarity_score") is not None:
        similarity_score = round(float(cleaned["similarity_score"]), 4)

    mmr_score: Optional[float] = None
    if cleaned.get("mmr_score") is not None:
        mmr_score = round(float(cleaned["mmr_score"]), 4)

    resolved_rank = rank if rank is not None else cleaned.get("rank")
    if resolved_rank is not None:
        resolved_rank = int(resolved_rank)

    return TrackItem(
        rank=resolved_rank,
        track_id=track_id,
        track_name=track_name,
        artist_name=artist_name,
        artist_genres=artist_genres,
        popularity=popularity,
        similarity_score=similarity_score,
        mmr_score=mmr_score,
        spotify_embed_url=f"https://open.spotify.com/embed/track/{track_id}",
        audio_features=_extract_audio_features(cleaned),
    )


def _execute_with_artist_fallback(
    invoke_fn: Callable[[bool], List[Dict[str, Any]]],
    exclude_same_artist: bool,
) -> List[Dict[str, Any]]:
    """
    Execute a recommendation callable with graceful fallback if dataset lacks artist_id,
    and map ValueError exceptions to standardized FastAPI HTTPExceptions.
    """
    try:
        return invoke_fn(exclude_same_artist)
    except ValueError as exc:
        err_msg = str(exc)
        if exclude_same_artist and "artist_id" in err_msg:
            return invoke_fn(False)
        if "Track ID not found" in err_msg:
            raise HTTPException(status_code=404, detail=err_msg) from exc
        raise HTTPException(status_code=400, detail=err_msg) from exc


def _rows_to_track_items(rows: List[Dict[str, Any]]) -> List[TrackItem]:
    """Convert a list of raw recommendation dicts into ranked TrackItem objects."""
    return [_row_to_track_item(row, rank=idx) for idx, row in enumerate(rows, start=1)]


@app.get("/api/v1/health", response_model=HealthResponse)
@app.get("/health", response_model=HealthResponse)
def health_check() -> HealthResponse:
    """Return server health and loaded model status."""
    recommender = _get_model()
    is_loaded = recommender is not None and recommender.df is not None
    total_tracks = int(len(recommender.df)) if is_loaded else 0
    return HealthResponse(
        status="ok" if is_loaded else "error",
        model_loaded=is_loaded,
        mode=model_mode,
        total_tracks=total_tracks,
        artifact_path=loaded_artifact_path,
    )


@app.get("/api/v1/search", response_model=SearchResponse)
def search_tracks(
    q: str = Query(..., description="Search query for track name or artist name"),
    limit: int = Query(15, ge=1, le=100, description="Maximum number of search results"),
) -> SearchResponse:
    """Search tracks by keyword and attach their 9 audio features."""
    start = time.perf_counter()
    recommender = _get_model()

    raw_results = recommender.search_tracks(q, limit=limit, as_dict=True)
    items: List[TrackItem] = []

    for idx, row in enumerate(raw_results, start=1):
        tid = row.get("track_id")
        merged_row = dict(row)
        has_all_audio = all(
            feat in merged_row and merged_row[feat] is not None
            for feat in AUDIO_FEATURE_FIELDS
        )
        if tid and not has_all_audio:
            try:
                details = recommender.get_track_details(tid)
                if details:
                    merged_row = {**details, **row}
            except ValueError:
                pass
        items.append(_row_to_track_item(merged_row, rank=idx))

    latency_ms = round((time.perf_counter() - start) * 1000, 2)
    return SearchResponse(
        status="success",
        query=q,
        total=len(items),
        results=items,
        latency_ms=latency_ms,
    )


@app.get("/api/v1/tracks/{track_id}", response_model=TrackItem)
def get_track(track_id: str) -> TrackItem:
    """Retrieve metadata and 9 audio features for a single track by track_id."""
    recommender = _get_model()
    try:
        details = recommender.get_track_details(track_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if not details:
        raise HTTPException(
            status_code=404, detail=f"Track ID not found: {track_id}"
        )

    return _row_to_track_item(details)


@app.get("/api/v1/recommend/track/{track_id}", response_model=RecommendationResponse)
def recommend_by_track(
    track_id: str,
    k: int = Query(10, ge=1, le=50, description="Number of tracks to recommend"),
    strategy: Literal["audio", "hybrid", "mmr"] = Query(
        "hybrid",
        description="Recommendation strategy: audio, hybrid, or mmr",
    ),
    alpha: float = Query(0.7, ge=0.0, le=1.0, description="Audio vs genre weight"),
    mmr_lambda: float = Query(
        0.7, ge=0.0, le=1.0, description="Relevance vs diversity weight for MMR"
    ),
    exclude_same_artist: bool = Query(
        True, description="Exclude tracks from the same artist as the seed track"
    ),
) -> RecommendationResponse:
    """Recommend top-K tracks similar to a single seed track."""
    start = time.perf_counter()
    recommender = _get_model()
    strategy_norm = strategy.strip().lower()

    try:
        seed_details = recommender.get_track_details(track_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    seed_item = _row_to_track_item(seed_details)

    def _invoke(exclude_artist_flag: bool) -> List[Dict[str, Any]]:
        if strategy_norm == "audio":
            return recommender.recommend_by_track(
                track_id,
                exclude_same_artist=exclude_artist_flag,
                top_k=k,
                as_dict=True,
            )
        if strategy_norm == "hybrid":
            return recommender.recommend_hybrid(
                track_id,
                alpha=alpha,
                exclude_same_artist=exclude_artist_flag,
                top_k=k,
                as_dict=True,
            )
        return recommender.recommend_hybrid_mmr(
            track_id,
            alpha=alpha,
            mmr_lambda=mmr_lambda,
            exclude_same_artist=exclude_artist_flag,
            top_k=k,
            as_dict=True,
        )

    raw_recs = _execute_with_artist_fallback(_invoke, exclude_same_artist)
    recommendations = _rows_to_track_items(raw_recs)
    latency_ms = round((time.perf_counter() - start) * 1000, 2)

    return RecommendationResponse(
        status="success",
        mode=strategy_norm,
        seed_track=seed_item,
        recommendations=recommendations,
        latency_ms=latency_ms,
    )


@app.post("/api/v1/recommend/profile", response_model=RecommendationResponse)
def recommend_by_profile(payload: TasteProfileRequest) -> RecommendationResponse:
    """Recommend top-K tracks based on a multi-track user taste profile."""
    start = time.perf_counter()
    recommender = _get_model()

    unique_track_ids = list(dict.fromkeys(payload.track_ids))

    seed_items: List[TrackItem] = []
    for tid in unique_track_ids:
        try:
            details = recommender.get_track_details(tid)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        seed_items.append(_row_to_track_item(details))

    def _invoke(exclude_artist_flag: bool) -> List[Dict[str, Any]]:
        return recommender.recommend_by_taste_profile(
            unique_track_ids,
            alpha=payload.alpha,
            exclude_same_artist=exclude_artist_flag,
            top_k=payload.k,
            as_dict=True,
        )

    raw_recs = _execute_with_artist_fallback(_invoke, payload.exclude_same_artist)
    recommendations = _rows_to_track_items(raw_recs)
    latency_ms = round((time.perf_counter() - start) * 1000, 2)

    return RecommendationResponse(
        status="success",
        mode="taste_profile",
        seed_tracks=seed_items,
        recommendations=recommendations,
        latency_ms=latency_ms,
    )


@app.get("/api/v1/recommend/popular", response_model=RecommendationResponse)
def recommend_popular(
    k: int = Query(10, ge=1, le=50, description="Number of popular tracks to return"),
) -> RecommendationResponse:
    """Return top-K most popular tracks as cold-start baseline."""
    start = time.perf_counter()
    recommender = _get_model()

    raw_recs = recommender.recommend_by_popularity(top_k=k, as_dict=True)
    recommendations = _rows_to_track_items(raw_recs)
    latency_ms = round((time.perf_counter() - start) * 1000, 2)

    return RecommendationResponse(
        status="success",
        mode="popular",
        recommendations=recommendations,
        latency_ms=latency_ms,
    )


@app.get("/api/v1/recommend/mood/{mood_name}", response_model=RecommendationResponse)
def recommend_by_mood(
    mood_name: str,
    k: int = Query(10, ge=1, le=50, description="Number of mood tracks to return"),
) -> RecommendationResponse:
    """Recommend top-K tracks matching a target acoustic mood profile."""
    start = time.perf_counter()
    recommender = _get_model()

    try:
        raw_recs = recommender.recommend_by_mood(mood_name, top_k=k, as_dict=True)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    recommendations = _rows_to_track_items(raw_recs)
    latency_ms = round((time.perf_counter() - start) * 1000, 2)

    return RecommendationResponse(
        status="success",
        mode=f"mood_{mood_name.strip().lower()}",
        recommendations=recommendations,
        latency_ms=latency_ms,
    )



# ==========================================
# PLAYLIST STUDIO & AI DJ MIXING ENDPOINTS
# ==========================================


class _SpotifyUrlPayload(BaseModel):
    url_or_id: str


class _PlaylistSequencePayload(BaseModel):
    track_ids: Optional[List[str]] = None
    tracks: Optional[List[Dict[str, Any]]] = None
    start_track_id: Optional[str] = None
    model: str = "dj_mix"


class _PlaylistExpandPayload(BaseModel):
    track_ids: Optional[List[str]] = None
    tracks: Optional[List[Dict[str, Any]]] = None
    num_to_insert: int = 3
    mode: str = "infill"
    model: str = "hybrid"


class _PlaylistMakeMixPayload(BaseModel):
    url_or_id: Optional[str] = None
    track_ids: Optional[List[str]] = None
    tracks: Optional[List[Dict[str, Any]]] = None
    start_track_id: Optional[str] = None
    model: str = "dj_mix"
    max_tracks: int = Field(MAX_LOCAL_AUDIO_LIMIT, ge=1, le=MAX_LOCAL_AUDIO_LIMIT)
    selection_mode: Literal["smart_cohesive", "first_n"] = "smart_cohesive"
    auto_download: bool = True


def _parse_spotify_playlist_id(raw: str) -> Optional[str]:
    if not raw:
        return None
    s = str(raw).strip()
    m = re.search(r"(?:playlist/|spotify:playlist:)([a-zA-Z0-9]+)", s)
    if m:
        return m.group(1)
    if re.match(r"^[a-zA-Z0-9]{22}$", s):
        return s
    return None


def _classify_vibe_label(af: Dict[str, float]) -> str:
    energy = float(af.get("energy", 0.5))
    valence = float(af.get("valence", 0.5))
    dance = float(af.get("danceability", 0.5))
    acoustic = float(af.get("acousticness", 0.3))
    if energy >= 0.75 and dance >= 0.65:
        return "⚡ Cao trào / Bùng nổ"
    if valence >= 0.68 and dance >= 0.60:
        return "☀️ Tươi sáng / Bắt nhịp"
    if acoustic >= 0.55 and energy <= 0.45:
        return "🌿 Mộc mạc / Acoustic Chill"
    if valence <= 0.35 and energy <= 0.50:
        return "🌙 Trầm lắng / Sâu sắc"
    if energy >= 0.65:
        return "🔥 Sôi động / Năng lượng"
    return "🎧 Cân bằng / Giai điệu mượt"


def _enrich_track_with_9_features(
    raw_track: Dict[str, Any],
    recommender: EmbeatRecommender,
    step: int = 1,
) -> Dict[str, Any]:
    """
    Ensure a track dictionary contains all 9 acoustic features, genres, and popularity.
    Matches by track_id first, or deterministically maps external Spotify tracks to catalog profiles.
    """
    tid = str(raw_track.get("track_id") or "").strip()
    uri = str(raw_track.get("spotify_uri") or "").strip()
    if not tid and uri.startswith("spotify:track:"):
        tid = uri.split(":")[-1]
    if not tid:
        tid = f"track_{step}"

    t_name = str(raw_track.get("track_name") or raw_track.get("title") or f"Track {step}").strip()
    artist = str(
        raw_track.get("artist")
        or raw_track.get("artist_name")
        or raw_track.get("subtitle")
        or "Unknown Artist"
    ).replace("\xa0", " ").strip()

    matched_row: Optional[Dict[str, Any]] = None
    if tid in recommender.id_to_idx:
        matched_row = recommender.df.iloc[recommender.id_to_idx[tid]].to_dict()
    else:
        digest = int(hashlib.md5(f"{tid}_{t_name}_{artist}".encode("utf-8")).hexdigest()[:8], 16)
        catalog_idx = digest % len(recommender.df)
        matched_row = recommender.df.iloc[catalog_idx].to_dict()

    existing_af = raw_track.get("audio_features")
    if not isinstance(existing_af, dict):
        existing_af = {}

    af_dict: Dict[str, float] = {}
    for feat in AUDIO_FEATURE_FIELDS:
        val = raw_track.get(feat)
        if val is None:
            val = existing_af.get(feat)
        if val is None and matched_row is not None:
            val = matched_row.get(feat)
        try:
            af_dict[feat] = round(float(val), 4)
        except (TypeError, ValueError):
            af_dict[feat] = 0.5

    pop_raw = raw_track.get("popularity")
    if pop_raw is None or pop_raw == "":
        pop_raw = matched_row.get("popularity") if matched_row else 70
    pop_norm = _normalize_popularity(pop_raw)
    if pop_norm is None:
        pop_norm = 70

    genres = (
        raw_track.get("artist_genres")
        or (matched_row.get("artist_genres") if matched_row else None)
        or "pop, mainstream"
    )

    spotify_uri = (
        uri
        if uri.startswith("spotify:track:")
        else (f"spotify:track:{tid}" if len(tid) == 22 and not tid.startswith("csv_") else "")
    )

    return {
        **raw_track,
        "step": step,
        "track_id": tid,
        "track_name": t_name,
        "artist": artist,
        "artist_name": artist,
        "artist_genres": str(genres),
        "popularity": pop_norm,
        "spotify_uri": spotify_uri,
        "spotify_embed_url": f"https://open.spotify.com/embed/track/{tid}",
        "audio_features": af_dict,
        **af_dict,
        "vibe_label": _classify_vibe_label(af_dict),
    }


def _extract_spotify_playlist_data(pid: str, recommender: EmbeatRecommender) -> Dict[str, Any]:
    """Fetch tracklist via RapidAPI metadata host (when configured) or Spotify embed with catalog fallback."""
    extracted: List[Dict[str, Any]] = []
    playlist_title = f"Spotify Playlist ({pid})"

    rapid_meta = fetch_rapidapi_playlist_metadata(pid)
    if rapid_meta and rapid_meta.get("tracks"):
        playlist_title = rapid_meta.get("title") or playlist_title
        for idx, raw_t in enumerate(rapid_meta["tracks"], start=1):
            extracted.append(_enrich_track_with_9_features(raw_t, recommender, step=idx))

    if not extracted:
        try:
            embed_url = f"https://open.spotify.com/embed/playlist/{pid}"
            resp = requests.get(
                embed_url,
                timeout=10,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
            )
            if resp.status_code == 200:
                match = re.search(
                    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
                    resp.text,
                )
                if match:
                    next_data = json.loads(match.group(1))
                    entity = (
                        next_data.get("props", {})
                        .get("pageProps", {})
                        .get("state", {})
                        .get("data", {})
                        .get("entity", {})
                    )
                    playlist_title = entity.get("name") or entity.get("title") or playlist_title
                    track_list = entity.get("trackList") or []
                    for idx, item in enumerate(track_list, start=1):
                        uri = str(item.get("uri") or "")
                        tid = uri.split(":")[-1] if ":" in uri else f"sp_{idx}"
                        preview = (item.get("audioPreview") or {}).get("url")
                        raw_t = {
                            "track_id": tid,
                            "spotify_uri": uri,
                            "track_name": item.get("title") or f"Track {idx}",
                            "artist": (item.get("subtitle") or "Unknown Artist").replace("\xa0", " "),
                            "duration_ms": int(item.get("duration") or 0),
                            "preview_url": preview,
                            "explicit": str(bool(item.get("isExplicit"))).lower(),
                        }
                        extracted.append(_enrich_track_with_9_features(raw_t, recommender, step=idx))
        except Exception as exc:
            logger.warning("Could not fetch live Spotify embed (%s), falling back to catalog.", exc)

    if not extracted:
        pop_rows = recommender.recommend_by_popularity(top_k=25, as_dict=True)
        for idx, row in enumerate(pop_rows, start=1):
            extracted.append(_enrich_track_with_9_features(row, recommender, step=idx))

    return {
        "playlist_id": pid,
        "title": playlist_title,
        "total": len(extracted),
        "tracks": extracted,
    }


def _resolve_input_tracks(
    tracks: Optional[List[Dict[str, Any]]],
    track_ids: Optional[List[str]],
    recommender: EmbeatRecommender,
) -> List[Dict[str, Any]]:
    resolved: List[Dict[str, Any]] = []
    if tracks:
        for idx, t in enumerate(tracks, start=1):
            resolved.append(_enrich_track_with_9_features(t, recommender, step=idx))
    elif track_ids:
        for idx, tid in enumerate(track_ids, start=1):
            if tid in recommender.id_to_idx:
                row = recommender.df.iloc[recommender.id_to_idx[tid]].to_dict()
                resolved.append(_enrich_track_with_9_features(row, recommender, step=idx))
    return resolved


@app.post("/api/playlist/parse-spotify")
def api_parse_spotify(payload: _SpotifyUrlPayload) -> Dict[str, Any]:
    pid = _parse_spotify_playlist_id(payload.url_or_id)
    return {"valid": bool(pid), "playlist_id": pid}


@app.post("/api/playlist/extract-spotify")
def api_extract_spotify(payload: _SpotifyUrlPayload) -> Dict[str, Any]:
    recommender = _get_model()
    pid = _parse_spotify_playlist_id(payload.url_or_id)
    if not pid:
        raise HTTPException(
            status_code=400,
            detail="Không tìm thấy ID Playlist Spotify hợp lệ từ đường dẫn.",
        )
    return _extract_spotify_playlist_data(pid, recommender)


@app.post("/api/playlist/sequence")
def api_sequence_playlist(payload: _PlaylistSequencePayload) -> Dict[str, Any]:
    recommender = _get_model()
    input_tracks = _resolve_input_tracks(payload.tracks, payload.track_ids, recommender)
    return optimize_dj_sequence(
        input_tracks,
        recommender,
        mode=payload.model,
        start_track_id=payload.start_track_id,
    )


@app.post("/api/playlist/make-mix")
def api_make_dj_mix(payload: _PlaylistMakeMixPayload) -> Dict[str, Any]:
    """
    Curate playlist down to max 20 tracks, download playable audio locally to bounded disk cache,
    and run Embeat AI DJ Sequencer to synchronize melody, BPM, loudness, and Crossfade plan.
    """
    recommender = _get_model()
    playlist_meta: Dict[str, Any] = {"playlist_id": None, "title": "EmBeat AI DJ Mix"}

    input_tracks = _resolve_input_tracks(payload.tracks, payload.track_ids, recommender)
    if not input_tracks and payload.url_or_id:
        pid = _parse_spotify_playlist_id(payload.url_or_id)
        if not pid:
            raise HTTPException(
                status_code=400,
                detail="Không tìm thấy ID Playlist Spotify hợp lệ từ đường dẫn.",
            )
        extracted_data = _extract_spotify_playlist_data(pid, recommender)
        input_tracks = extracted_data["tracks"]
        playlist_meta = {
            "playlist_id": extracted_data["playlist_id"],
            "title": extracted_data["title"],
        }

    if not input_tracks:
        raise HTTPException(status_code=400, detail="Không có bài hát nào để tạo bản DJ Mix.")

    capped_limit = max(1, min(MAX_LOCAL_AUDIO_LIMIT, int(payload.max_tracks or MAX_LOCAL_AUDIO_LIMIT)))
    curated_tracks, curation_stats = curate_tracks_for_mix(
        input_tracks,
        recommender,
        max_tracks=capped_limit,
        selection_mode=payload.selection_mode,
    )

    downloaded_tracks, download_stats = download_playlist_audio_batch(
        curated_tracks,
        max_tracks=capped_limit,
        download=bool(payload.auto_download),
    )

    sequenced = optimize_dj_sequence(
        downloaded_tracks,
        recommender,
        mode=payload.model,
        start_track_id=payload.start_track_id,
    )

    return {
        **playlist_meta,
        **sequenced,
        "max_audio_limit": MAX_LOCAL_AUDIO_FILES,
        "curation_stats": curation_stats,
        "download_stats": download_stats,
    }


class _AudioResolvePayload(BaseModel):
    track_id: Optional[str] = None
    spotify_uri: Optional[str] = None
    spotify_url: Optional[str] = None
    track_name: Optional[str] = None
    artist_name: Optional[str] = None
    artist: Optional[str] = None
    duration_ms: Optional[int] = None
    preview_url: Optional[str] = None
    prefer_full: bool = True
    cache_locally: bool = True


def _open_safe_upstream_audio_stream(url: str, range_header: Optional[str] = None) -> requests.Response:
    """Open an SSRF-checked upstream audio stream, validating redirect hops explicitly."""
    current_url = url.strip()
    headers: Dict[str, str] = {"User-Agent": "Mozilla/5.0 EmBeatAudioProxy/1.0"}
    if range_header:
        headers["Range"] = range_header

    for _ in range(4):
        if not is_safe_proxy_url(current_url):
            raise HTTPException(status_code=400, detail="URL audio không hợp lệ hoặc bị chặn.")
        resp = requests.get(
            current_url,
            headers=headers,
            stream=True,
            timeout=25,
            allow_redirects=False,
        )
        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            resp.close()
            if not location:
                raise HTTPException(status_code=502, detail="Upstream redirect thiếu Location.")
            current_url = urljoin(current_url, location)
            continue
        return resp

    raise HTTPException(status_code=502, detail="Quá nhiều redirect từ nguồn audio.")


@app.get("/api/audio/config")
def api_audio_config() -> Dict[str, Any]:
    """Return non-secret audio resolver capability & RapidAPI configuration status."""
    return get_audio_resolver_config()


@app.post("/api/audio/resolve")
def api_resolve_audio(payload: _AudioResolvePayload) -> Dict[str, Any]:
    """
    Resolve full-length track audio (via RapidAPI chain when configured) or 30s preview fallback,
    matching MusicFab's /api/spotify + audioKind ('full' | 'preview') pipeline.
    """
    track_dict: Dict[str, Any] = payload.model_dump(exclude={"prefer_full", "cache_locally"}, exclude_none=True)
    if not track_dict.get("track_id") and not track_dict.get("track_name") and not track_dict.get("spotify_url"):
        raise HTTPException(status_code=400, detail="Cần cung cấp track_id, spotify_url hoặc track_name.")

    tid = track_dict.get("track_id")
    if tid and (not track_dict.get("track_name") or not (track_dict.get("artist_name") or track_dict.get("artist"))):
        try:
            recommender = _get_model()
            row = recommender.get_track_by_id(tid)
            if row:
                track_dict.setdefault("track_name", row.get("track_name") or row.get("name"))
                art = row.get("artist_name") or row.get("artist") or row.get("artists")
                track_dict.setdefault("artist_name", art)
                track_dict.setdefault("artist", art)
                if row.get("duration_ms"):
                    track_dict.setdefault("duration_ms", row.get("duration_ms"))
        except Exception:
            pass

    return resolve_single_track_audio(
        track_dict,
        prefer_full=payload.prefer_full,
        cache_locally=payload.cache_locally,
    )


@app.get("/api/audio/proxy")
def api_proxy_audio(
    request: Request,
    url: str = Query(..., description="Validated external audio URL"),
    filename: Optional[str] = Query(None, description="Optional download filename"),
):
    """
    SSRF-safe CORS audio stream proxy (mirrors MusicFab /api/proxy/file),
    forwarding Range headers and capping stream size at 100 MiB.
    """
    upstream = _open_safe_upstream_audio_stream(url, request.headers.get("range"))
    if upstream.status_code not in (200, 206):
        status = upstream.status_code
        upstream.close()
        raise HTTPException(status_code=502, detail=f"Nguồn audio trả về HTTP {status}.")

    raw_ct = (upstream.headers.get("Content-Type") or "audio/mpeg").split(";")[0].strip().lower()
    if any(bad in raw_ct for bad in ("text/html", "application/json", "text/plain")):
        upstream.close()
        raise HTTPException(status_code=502, detail="Nguồn phản hồi không phải dữ liệu âm thanh.")

    content_len = upstream.headers.get("Content-Length")
    if content_len and content_len.isdigit() and int(content_len) > MAX_PROXY_AUDIO_BYTES:
        upstream.close()
        raise HTTPException(status_code=413, detail="Kích thước file vượt quá giới hạn 100 MiB.")

    resp_headers: Dict[str, str] = {
        "Accept-Ranges": upstream.headers.get("Accept-Ranges", "bytes"),
        "Cache-Control": "public, max-age=1800",
    }
    if content_len:
        resp_headers["Content-Length"] = content_len
    if upstream.headers.get("Content-Range"):
        resp_headers["Content-Range"] = upstream.headers["Content-Range"]
    if filename:
        safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f]', "_", Path(filename).name)[:140]
        if safe_name:
            resp_headers["Content-Disposition"] = f'inline; filename="{safe_name}"'

    def _stream_chunks():
        sent = 0
        try:
            for chunk in upstream.iter_content(chunk_size=65536):
                if not chunk:
                    continue
                sent += len(chunk)
                if sent > MAX_PROXY_AUDIO_BYTES:
                    break
                yield chunk
        finally:
            upstream.close()

    return StreamingResponse(
        _stream_chunks(),
        status_code=upstream.status_code,
        media_type=raw_ct or "audio/mpeg",
        headers=resp_headers,
    )


@app.get("/api/playlist/local-audio/status")
def api_local_audio_status() -> Dict[str, Any]:
    """Inspect bounded local audio cache usage (max 20 files)."""
    return get_audio_cache_status()


@app.delete("/api/playlist/local-audio/cache")
def api_clear_local_audio_cache() -> Dict[str, Any]:
    """Clear all locally downloaded audio previews."""
    return clear_audio_cache()


@app.get("/api/playlist/local-audio/{filename}")
def api_serve_local_audio(filename: str) -> FileResponse:
    """Serve locally cached audio with proper audio MIME type for Web Audio DJ Mixing."""
    audio_path = get_cached_audio_path(filename)
    if audio_path is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy file audio trong cache cục bộ.")

    suffix = audio_path.suffix.lower()
    mime_map = {
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".mp4": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".opus": "audio/opus",
        ".flac": "audio/flac",
        ".wav": "audio/wav",
        ".webm": "audio/webm",
    }
    media_type = mime_map.get(suffix, "audio/mpeg")
    return FileResponse(
        path=audio_path,
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
        },
    )


@app.post("/api/playlist/expand")
def api_expand_playlist(payload: _PlaylistExpandPayload) -> Dict[str, Any]:
    recommender = _get_model()
    base_tracks = _resolve_input_tracks(payload.tracks, payload.track_ids, recommender)
    if not base_tracks:
        raise HTTPException(status_code=400, detail="Danh sách bài hát gốc đang trống.")

    num_to_insert = max(1, min(MAX_LOCAL_AUDIO_LIMIT, int(payload.num_to_insert or 3)))
    existing_ids = {t["track_id"] for t in base_tracks}

    avg_af = {
        feat: float(np.mean([t["audio_features"][feat] for t in base_tracks]))
        for feat in AUDIO_FEATURE_FIELDS
    }
    target_vec = compute_standardized_vector(avg_af, recommender)
    recommender._ensure_runtime_caches()
    sims = (recommender._norm_feature_matrix @ target_vec).ravel()

    excluded_indices = [
        recommender.id_to_idx[tid]
        for tid in existing_ids
        if tid in recommender.id_to_idx
    ]
    top_indices = recommender._rank_scores(sims, num_to_insert, excluded_indices=excluded_indices)
    rec_rows = recommender._get_result(top_indices, {"similarity": sims}).to_dict(orient="records")

    inserted_tracks: List[Dict[str, Any]] = []
    for idx, r in enumerate(rec_rows, start=1):
        enriched = _enrich_track_with_9_features(r, recommender, step=idx)
        enriched["is_inserted"] = True
        enriched["is_infilled"] = True
        enriched["reason"] = (
            "Cầu nối giai điệu AI (Infill)"
            if payload.mode == "infill"
            else "Đề xuất nối dài Playlist (Append)"
        )
        inserted_tracks.append(enriched)

    if payload.mode == "infill" and len(base_tracks) >= 2:
        combined = list(base_tracks)
        step_stride = max(1, len(combined) // (len(inserted_tracks) + 1))
        offset = 0
        for ins in inserted_tracks:
            insert_pos = min(len(combined), offset + step_stride)
            combined.insert(insert_pos, ins)
            offset = insert_pos + 1
    else:
        combined = [*base_tracks, *inserted_tracks]

    re_seq = optimize_dj_sequence(combined, recommender, mode=payload.model)
    return {
        "mode": payload.mode,
        "num_inserted": len(inserted_tracks),
        "inserted_tracks": inserted_tracks,
        "full_playlist": re_seq["tracks"],
        "feature_averages": re_seq["feature_averages"],
    }
