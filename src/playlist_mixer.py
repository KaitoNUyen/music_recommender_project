"""AI DJ Playlist Curator, Harmonic Sequencer, and Mixing Parameter Engine."""

from typing import Any, Dict, List, Optional, Tuple
import numpy as np
import pandas as pd

from src.preprocess import AUDIO_FEATURES
from src.recommender import EmbeatRecommender

MAX_LOCAL_AUDIO_LIMIT = 20
TARGET_LOUDNESS_DB = -8.5
DEFAULT_CROSSFADE_SEC = 5.0
ALLOWED_PLAYBACK_NUDGE = 0.045  # ±4.5% max BPM nudge to preserve natural pitch

AUDIO_FEATURE_FIELDS: Tuple[str, ...] = tuple(AUDIO_FEATURES)


def compute_standardized_vector(
    af_dict: Dict[str, float],
    recommender: EmbeatRecommender,
) -> np.ndarray:
    """Project a track's 9 raw acoustic features into L2-normalized scaler space."""
    vec = np.array([float(af_dict.get(f, 0.5)) for f in AUDIO_FEATURES], dtype=np.float64)
    scaler = recommender.scaler
    if hasattr(scaler, "mean_") and hasattr(scaler, "scale_"):
        scale = np.where(np.abs(scaler.scale_) > 1e-12, scaler.scale_, 1.0)
        scaled = (vec - scaler.mean_) / scale
    else:
        scaled = scaler.transform(pd.DataFrame([af_dict], columns=AUDIO_FEATURES)).ravel()
    norm = float(np.linalg.norm(scaled))
    return scaled / norm if norm > 1e-9 else scaled


def compute_bpm_continuity_penalty(bpm_a: float, bpm_b: float) -> Tuple[float, float, float]:
    """
    Evaluate DJ tempo compatibility between two tracks (half/double-time aware).

    Returns:
        (penalty_0_to_1, bpm_match_percent_0_to_100, incoming_playback_rate_for_sync)
    """
    a = max(45.0, min(220.0, float(bpm_a or 120.0)))
    b = max(45.0, min(220.0, float(bpm_b or 120.0)))

    # Consider direct BPM, half-time (0.5x), and double-time (2.0x)
    candidates = [
        (abs(a - b) / max(a, 60.0), a / b),
        (abs(a - 2.0 * b) / max(a, 60.0), a / (2.0 * b)),
        (abs(2.0 * a - b) / max(2.0 * a, 60.0), (2.0 * a) / b),
    ]
    best_rel_diff, raw_ratio = min(candidates, key=lambda item: item[0])

    # Exponential decay beyond ±6% beatmatch comfort zone
    penalty = min(1.0, (best_rel_diff / 0.25) ** 1.35)
    match_pct = max(25.0, min(99.9, (1.0 - min(best_rel_diff, 0.75)) * 100.0))

    clamped_rate = max(1.0 - ALLOWED_PLAYBACK_NUDGE, min(1.0 + ALLOWED_PLAYBACK_NUDGE, raw_ratio))
    return float(penalty), round(float(match_pct), 1), round(float(clamped_rate), 4)


def compute_loudness_gain(loudness_db: float) -> Tuple[float, float]:
    """
    Compute ReplayGain-style dB trim and linear gain multiplier toward TARGET_LOUDNESS_DB.
    Clamped safely within [-5.5 dB, +5.5 dB].
    """
    loud = float(loudness_db if loudness_db is not None else TARGET_LOUDNESS_DB)
    loud = max(-35.0, min(0.0, loud))
    delta_db = max(-5.5, min(5.5, TARGET_LOUDNESS_DB - loud))
    linear_gain = float(10.0 ** (delta_db / 20.0))
    return round(delta_db, 2), round(linear_gain, 4)


def _compute_genre_similarity_matrix(
    tracks: List[Dict[str, Any]],
) -> np.ndarray:
    """Compute pairwise Jaccard genre similarity between candidate tracks."""
    n = len(tracks)
    genre_sets: List[set] = []
    for t in tracks:
        raw = str(t.get("artist_genres") or "").lower()
        tokens = {g.strip() for g in raw.split(",") if g.strip() and g.strip() != "unknown"}
        genre_sets.append(tokens)

    mat = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        mat[i, i] = 1.0
        for j in range(i + 1, n):
            gi, gj = genre_sets[i], genre_sets[j]
            if not gi or not gj:
                sim = 0.5
            else:
                union = gi | gj
                sim = len(gi & gj) / len(union) if union else 0.0
            mat[i, j] = sim
            mat[j, i] = sim
    return mat


def curate_tracks_for_mix(
    tracks: List[Dict[str, Any]],
    recommender: EmbeatRecommender,
    max_tracks: int = MAX_LOCAL_AUDIO_LIMIT,
    selection_mode: str = "smart_cohesive",
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Select at most `max_tracks` (hard-capped at MAX_LOCAL_AUDIO_LIMIT=20) from the playlist
    so audio downloading & DJ playback stay fast, focused, and controllable.
    """
    capped_limit = max(1, min(MAX_LOCAL_AUDIO_LIMIT, int(max_tracks or MAX_LOCAL_AUDIO_LIMIT)))
    total_input = len(tracks)

    if total_input <= capped_limit:
        return list(tracks), {
            "total_input_tracks": total_input,
            "selected_tracks": total_input,
            "limit_applied": capped_limit,
            "selection_mode": selection_mode,
        }

    if selection_mode == "first_n":
        chosen = list(tracks[:capped_limit])
        return chosen, {
            "total_input_tracks": total_input,
            "selected_tracks": len(chosen),
            "limit_applied": capped_limit,
            "selection_mode": "first_n",
        }

    # Smart cohesive curation using EmbeatRecommender 9D centroid + playability + energy balance
    vecs = np.array(
        [compute_standardized_vector(t["audio_features"], recommender) for t in tracks],
        dtype=np.float64,
    )
    centroid = vecs.mean(axis=0)
    c_norm = float(np.linalg.norm(centroid))
    if c_norm > 1e-9:
        centroid = centroid / c_norm

    cohesion_scores = (vecs @ centroid).ravel()
    genre_mat = _compute_genre_similarity_matrix(tracks)
    avg_genre_sim = genre_mat.mean(axis=1)

    composite = np.zeros(total_input, dtype=np.float64)
    for i, t in enumerate(tracks):
        preview_bonus = 0.25 if t.get("preview_url") or t.get("local_audio_url") else 0.0
        pop_norm = float(t.get("popularity") or 70) / 100.0
        composite[i] = (
            0.50 * float(cohesion_scores[i])
            + 0.20 * float(avg_genre_sim[i])
            + 0.15 * pop_norm
            + preview_bonus
        )

    top_indices = np.argsort(composite)[::-1][:capped_limit]
    # Keep deterministic relative order prior to sequencing
    top_indices_sorted = sorted(top_indices.tolist())
    chosen = [tracks[i] for i in top_indices_sorted]

    return chosen, {
        "total_input_tracks": total_input,
        "selected_tracks": len(chosen),
        "limit_applied": capped_limit,
        "selection_mode": "smart_cohesive",
    }


def build_transition_cost_matrix(
    tracks: List[Dict[str, Any]],
    recommender: EmbeatRecommender,
    mode: str = "dj_mix",
) -> np.ndarray:
    """
    Build an (N x N) DJ transition cost matrix combining:
    - 9D standardized acoustic cosine distance
    - Half/double-time-aware BPM continuity penalty
    - Energy & valence arc continuity
    - Genre bridging score
    """
    n = len(tracks)
    vecs = np.array(
        [compute_standardized_vector(t["audio_features"], recommender) for t in tracks],
        dtype=np.float64,
    )
    cosine_mat = np.clip(vecs @ vecs.T, -1.0, 1.0)
    audio_dist = np.maximum(0.0, 1.0 - cosine_mat)
    genre_sim = _compute_genre_similarity_matrix(tracks)

    cost = np.zeros((n, n), dtype=np.float64)
    for i in range(n):
        af_i = tracks[i]["audio_features"]
        bpm_i = float(af_i.get("tempo", 120.0))
        e_i = float(af_i.get("energy", 0.5))
        v_i = float(af_i.get("valence", 0.5))

        for j in range(n):
            if i == j:
                cost[i, j] = 999.0
                continue
            af_j = tracks[j]["audio_features"]
            bpm_j = float(af_j.get("tempo", 120.0))
            e_j = float(af_j.get("energy", 0.5))
            v_j = float(af_j.get("valence", 0.5))

            bpm_pen, _, _ = compute_bpm_continuity_penalty(bpm_i, bpm_j)
            energy_jump = abs(e_j - e_i)
            valence_jump = abs(v_j - v_i)
            genre_dist = 1.0 - float(genre_sim[i, j])

            if mode == "audio":
                c = float(audio_dist[i, j])
            elif mode == "hybrid":
                c = 0.70 * float(audio_dist[i, j]) + 0.30 * genre_dist
            elif mode == "vibe_smooth":
                # Smooth groove progression with gentle upward-or-level energy bias
                downward_cliff = max(0.0, e_i - e_j - 0.12) * 0.65
                c = (
                    0.48 * float(audio_dist[i, j])
                    + 0.27 * bpm_pen
                    + 0.15 * (energy_jump + 0.5 * valence_jump)
                    + 0.10 * genre_dist
                    + downward_cliff
                )
            else:
                # "dj_mix": Full DJ harmonic blend optimization
                c = (
                    0.45 * float(audio_dist[i, j])
                    + 0.28 * bpm_pen
                    + 0.17 * (0.7 * energy_jump + 0.3 * valence_jump)
                    + 0.10 * genre_dist
                )
            cost[i, j] = max(0.0, float(c))

    return cost


def _two_opt_improve(order: List[int], cost_matrix: np.ndarray) -> List[int]:
    """Run deterministic 2-opt local path search to eliminate choppy transitions."""
    n = len(order)
    if n < 4:
        return order

    best = list(order)

    def path_cost(seq: List[int]) -> float:
        return sum(float(cost_matrix[seq[k], seq[k + 1]]) for k in range(len(seq) - 1))

    best_cost = path_cost(best)
    improved = True
    iterations = 0
    while improved and iterations < 40:
        improved = False
        iterations += 1
        for i in range(1, n - 1):
            for j in range(i + 1, n):
                candidate = best[:i] + best[i : j + 1][::-1] + best[j + 1 :]
                cand_cost = path_cost(candidate)
                if cand_cost + 1e-6 < best_cost:
                    best = candidate
                    best_cost = cand_cost
                    improved = True
    return best


def _build_dj_mix_plan(
    cur_track: Dict[str, Any],
    next_track: Dict[str, Any],
    vec_cur: np.ndarray,
    vec_next: np.ndarray,
) -> Dict[str, Any]:
    """Compute per-transition DJ mixing parameters used by the Web Audio Crossfade engine."""
    af_cur = cur_track["audio_features"]
    af_next = next_track["audio_features"]

    cos_sim = float(np.dot(vec_cur, vec_next))
    audio_match = max(0.05, min(0.99, (cos_sim + 1.0) / 2.0))

    bpm_cur = float(af_cur.get("tempo", 120.0))
    bpm_next = float(af_next.get("tempo", 120.0))
    bpm_pen, bpm_match_pct, tempo_sync_rate = compute_bpm_continuity_penalty(bpm_cur, bpm_next)

    composite_smoothness = max(
        0.10,
        min(0.99, 0.65 * audio_match + 0.35 * (bpm_match_pct / 100.0)),
    )

    # Higher acoustic + BPM affinity supports a longer seamless Spotify/DJ crossfade blend
    rec_crossfade = round(max(3.0, min(9.5, 3.0 + composite_smoothness * 6.0)), 1)

    energy_diff = float(af_next.get("energy", 0.5)) - float(af_cur.get("energy", 0.5))
    acoustic_next = float(af_next.get("acousticness", 0.3))

    if bpm_match_pct >= 90.0 and audio_match >= 0.72:
        mix_style = "Harmonic Beatmatch"
    elif energy_diff >= 0.12:
        mix_style = "Energy Lift Fade"
    elif acoustic_next >= 0.55:
        mix_style = "Smooth Acoustic Bridge"
    else:
        mix_style = "Melodic Cosine Blend"

    bpm_delta = round(bpm_next - bpm_cur, 1)
    bpm_delta_str = f"+{bpm_delta}" if bpm_delta > 0 else f"{bpm_delta}"
    dj_note = (
        f"{mix_style}: Khớp {composite_smoothness * 100:.0f}% · "
        f"BPM {bpm_cur:.0f}→{bpm_next:.0f} ({bpm_delta_str}) · "
        f"Crossfade {rec_crossfade}s"
    )

    return {
        "recommended_crossfade_sec": rec_crossfade,
        "bpm_from": round(bpm_cur, 1),
        "bpm_to": round(bpm_next, 1),
        "bpm_delta": bpm_delta,
        "bpm_match_percent": bpm_match_pct,
        "tempo_sync_ratio": tempo_sync_rate,
        "smoothness_score": round(composite_smoothness, 4),
        "mix_style": mix_style,
        "eq_bass_swap": bpm_match_pct >= 80.0,
        "dj_note": dj_note,
    }


def optimize_dj_sequence(
    tracks: List[Dict[str, Any]],
    recommender: EmbeatRecommender,
    mode: str = "dj_mix",
    start_track_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Reorder tracks to synchronize melody, BPM, energy arc, and cosine cohesion,
    and attach per-track loudness trim + per-transition DJ mix plans.
    """
    n = len(tracks)
    mode_norm = (mode or "dj_mix").strip().lower()

    if n == 0:
        return {
            "model": mode_norm,
            "tracks": [],
            "original_transition_cost": 0.0,
            "optimized_transition_cost": 0.0,
            "cost_reduction_percent": 0.0,
            "avg_smoothness_percent": 0.0,
            "avg_bpm_jump": 0.0,
            "feature_averages": {},
        }

    vecs = np.array(
        [compute_standardized_vector(t["audio_features"], recommender) for t in tracks],
        dtype=np.float64,
    )
    cost_matrix = build_transition_cost_matrix(tracks, recommender, mode=mode_norm)

    orig_cost = sum(float(cost_matrix[i, i + 1]) for i in range(n - 1)) if n > 1 else 0.0

    # Determine starting track
    start_idx = 0
    if start_track_id:
        for idx, t in enumerate(tracks):
            if str(t.get("track_id")) == str(start_track_id):
                start_idx = idx
                break
    elif mode_norm in ("dj_mix", "vibe_smooth") and n >= 3:
        # Start with a balanced warm-up track (moderate energy, good popularity)
        start_idx = int(
            min(
                range(n),
                key=lambda i: abs(float(tracks[i]["audio_features"].get("energy", 0.5)) - 0.52)
                - 0.002 * float(tracks[i].get("popularity") or 60),
            )
        )
    else:
        start_idx = int(np.argmax([t.get("popularity") or 0 for t in tracks]))

    if mode_norm == "popular":
        order = sorted(range(n), key=lambda i: -(tracks[i].get("popularity") or 0))
    else:
        # Nearest-neighbor initial trajectory + 2-opt harmonic smoothing
        visited = {start_idx}
        order = [start_idx]
        cur = start_idx
        while len(order) < n:
            best_next = min(
                (j for j in range(n) if j not in visited),
                key=lambda j: float(cost_matrix[cur, j]),
            )
            visited.add(best_next)
            order.append(best_next)
            cur = best_next

        if mode_norm != "popular":
            order = _two_opt_improve(order, cost_matrix)

    opt_cost = sum(float(cost_matrix[order[i], order[i + 1]]) for i in range(n - 1)) if n > 1 else 0.0
    if opt_cost > orig_cost and n > 1 and mode_norm != "popular":
        # Safeguard non-popular acoustic modes against sub-optimal transitions
        order = list(range(n))
        opt_cost = orig_cost

    if orig_cost > 1e-6:
        reduction_pct = max(0.0, round(((orig_cost - opt_cost) / orig_cost) * 100.0, 1))
    else:
        reduction_pct = 0.0

    sequenced_tracks: List[Dict[str, Any]] = []
    smoothness_scores: List[float] = []
    bpm_jumps: List[float] = []

    for step_idx, orig_i in enumerate(order):
        item = dict(tracks[orig_i])
        item["step"] = step_idx + 1
        item["original_step"] = orig_i + 1

        gain_db, gain_linear = compute_loudness_gain(item["audio_features"].get("loudness", -8.5))
        item["loudness_trim_db"] = gain_db
        item["recommended_gain"] = gain_linear

        if step_idx < n - 1:
            next_i = order[step_idx + 1]
            mix_plan = _build_dj_mix_plan(
                item,
                tracks[next_i],
                vecs[orig_i],
                vecs[next_i],
            )
            item["mix_plan"] = mix_plan
            item["transition_similarity_to_next"] = mix_plan["smoothness_score"]
            smoothness_scores.append(mix_plan["smoothness_score"] * 100.0)
            bpm_jumps.append(abs(mix_plan["bpm_delta"]))

            cur_af = item["audio_features"]
            next_af = tracks[next_i]["audio_features"]
            item["deltas_to_next"] = {
                feat: round(float(next_af[feat]) - float(cur_af[feat]), 4)
                for feat in AUDIO_FEATURE_FIELDS
            }
        else:
            item["mix_plan"] = None
            item["transition_similarity_to_next"] = None
            item["deltas_to_next"] = None

        sequenced_tracks.append(item)

    feature_averages = {
        feat: round(
            float(np.mean([t["audio_features"][feat] for t in sequenced_tracks])),
            4,
        )
        for feat in AUDIO_FEATURE_FIELDS
    }

    avg_smoothness = round(float(np.mean(smoothness_scores)), 1) if smoothness_scores else 100.0
    avg_bpm_jump = round(float(np.mean(bpm_jumps)), 1) if bpm_jumps else 0.0

    return {
        "model": mode_norm,
        "tracks": sequenced_tracks,
        "original_transition_cost": round(float(orig_cost), 4),
        "optimized_transition_cost": round(float(opt_cost), 4),
        "cost_reduction_percent": reduction_pct,
        "avg_smoothness_percent": avg_smoothness,
        "avg_bpm_jump": avg_bpm_jump,
        "feature_averages": feature_averages,
    }
