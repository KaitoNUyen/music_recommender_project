"""Core Content-Based, Hybrid, MMR, Mood, and Taste Profile Recommender Engine."""

from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple, Union

import joblib
import numpy as np
import pandas as pd
from scipy.sparse import csr_matrix
from sklearn.metrics.pairwise import cosine_similarity
from sklearn.preprocessing import MultiLabelBinarizer, normalize

from src.preprocess import AUDIO_FEATURES, clean_tracks, fit_scaler

METADATA_COLUMNS: Tuple[str, ...] = (
    "track_id",
    "track_name",
    "artist_id",
    "artist_name",
    "album_id",
    "album_name",
    "isrc",
    "artist_genres",
    "popularity",
    "explicit",
    "release_year",
    "duration",
    *AUDIO_FEATURES,
)

SEARCH_DICT_COLUMNS: Tuple[str, ...] = (
    "track_id",
    "track_name",
    "artist_name",
    "artist_genres",
    "popularity",
    *AUDIO_FEATURES,
)

SEARCH_DF_COLUMNS: List[str] = [
    "track_id",
    "track_name",
    "artist_name",
    "artist_genres",
    "popularity",
]

MOOD_PROFILES: Dict[str, Dict[str, float]] = {
    "happy": {
        "danceability": 0.80,
        "energy": 0.80,
        "valence": 0.85,
        "tempo": 120.0,
        "acousticness": 0.15,
        "instrumentalness": 0.05,
        "speechiness": 0.08,
        "liveness": 0.15,
        "loudness": -5.0,
    },
    "sad": {
        "danceability": 0.40,
        "energy": 0.25,
        "valence": 0.20,
        "tempo": 75.0,
        "acousticness": 0.65,
        "instrumentalness": 0.10,
        "speechiness": 0.05,
        "liveness": 0.15,
        "loudness": -18.0,
    },
    "calm": {
        "danceability": 0.35,
        "energy": 0.25,
        "valence": 0.45,
        "tempo": 85.0,
        "acousticness": 0.80,
        "instrumentalness": 0.35,
        "speechiness": 0.04,
        "liveness": 0.12,
        "loudness": -18.0,
    },
    "chill": {
        "danceability": 0.35,
        "energy": 0.25,
        "valence": 0.45,
        "tempo": 85.0,
        "acousticness": 0.80,
        "instrumentalness": 0.35,
        "speechiness": 0.04,
        "liveness": 0.12,
        "loudness": -18.0,
    },
    "energetic": {
        "danceability": 0.75,
        "energy": 0.90,
        "valence": 0.65,
        "tempo": 140.0,
        "acousticness": 0.10,
        "instrumentalness": 0.05,
        "speechiness": 0.08,
        "liveness": 0.20,
        "loudness": -5.0,
    },
    "focus": {
        "danceability": 0.30,
        "energy": 0.30,
        "valence": 0.25,
        "tempo": 95.0,
        "acousticness": 0.55,
        "instrumentalness": 0.85,
        "speechiness": 0.03,
        "liveness": 0.12,
        "loudness": -17.0,
    },
}


def build_sparse_genre_matrix(df: pd.DataFrame) -> Tuple[csr_matrix, MultiLabelBinarizer]:
    """Convert comma-separated artist_genres column into a sparse CSR multi-hot matrix."""
    genre_list = (
        df["artist_genres"]
        .fillna("")
        .apply(
            lambda x: [
                genre.strip().lower()
                for genre in str(x).split(",")
                if genre.strip()
            ]
        )
    )
    mlb = MultiLabelBinarizer(sparse_output=True)
    genre_matrix = csr_matrix(mlb.fit_transform(genre_list))
    return genre_matrix, mlb


class EmbeatRecommender:
    """
    Embeat Music Recommendation Model.

    Supported methods:
    - Audio-only Recommendation
    - Hybrid Recommendation
    - Hybrid + MMR Recommendation
    - Taste Profile Recommendation
    - Mood-based Recommendation
    - Popularity-based Recommendation
    """

    def __init__(self) -> None:
        self.df: Optional[pd.DataFrame] = None
        self.scaler = None
        self.feature_matrix: Optional[np.ndarray] = None
        self.id_to_idx: Dict[str, int] = {}
        self.genre_matrix: Optional[csr_matrix] = None
        self._pending_batches: List[pd.DataFrame] = []

        # Ephemeral runtime acceleration caches (rebuilt automatically if missing/stale)
        self._InvalidateCaches()

    def _InvalidateCaches(self) -> None:
        """Reset ephemeral runtime caches."""
        self._cached_df_id: Optional[int] = None
        self._cached_feature_id: Optional[int] = None
        self._cached_genre_id: Optional[int] = None
        self._norm_feature_matrix: Optional[np.ndarray] = None
        self._norm_genre_matrix: Optional[csr_matrix] = None
        self._artist_to_indices: Optional[Dict[Any, np.ndarray]] = None
        self._popularity_scores: Optional[np.ndarray] = None

    def _ensure_runtime_caches(self) -> None:
        """
        Lazily initialize L2-normalized feature/genre matrices and inverted artist indices.
        Compatible with previously pickled joblib artifacts where __init__ was not re-run.
        """
        if self.df is not None and getattr(self, "_cached_df_id", None) != id(self.df):
            if "artist_id" in self.df.columns:
                artist_groups: Dict[Any, List[int]] = {}
                for idx, aid in enumerate(self.df["artist_id"].to_numpy()):
                    if pd.notna(aid):
                        artist_groups.setdefault(aid, []).append(idx)
                self._artist_to_indices = {
                    k: np.asarray(v, dtype=np.int64) for k, v in artist_groups.items()
                }
            else:
                self._artist_to_indices = None

            if "popularity" in self.df.columns:
                self._popularity_scores = (
                    pd.to_numeric(self.df["popularity"], errors="coerce")
                    .fillna(-np.inf)
                    .to_numpy(dtype=float)
                )
            else:
                self._popularity_scores = None

            self._cached_df_id = id(self.df)

        if (
            self.feature_matrix is not None
            and getattr(self, "_cached_feature_id", None) != id(self.feature_matrix)
        ):
            self._norm_feature_matrix = normalize(
                np.asarray(self.feature_matrix, dtype=np.float64),
                norm="l2",
                axis=1,
                copy=True,
            )
            self._cached_feature_id = id(self.feature_matrix)

        if (
            self.genre_matrix is not None
            and getattr(self, "_cached_genre_id", None) != id(self.genre_matrix)
        ):
            self._norm_genre_matrix = normalize(
                self.genre_matrix.astype(np.float64),
                norm="l2",
                axis=1,
                copy=True,
            )
            self._cached_genre_id = id(self.genre_matrix)

    # ==========================================
    # 1. MODEL TRAINING
    # ==========================================

    def fit(self, df: pd.DataFrame) -> "EmbeatRecommender":
        """Clean data, fit the audio feature scaler, and build genre matrix."""
        self.df = clean_tracks(df)
        self.scaler, self.feature_matrix = fit_scaler(self.df)
        self.id_to_idx = {
            track_id: idx for idx, track_id in enumerate(self.df["track_id"])
        }

        if "artist_genres" in self.df.columns:
            self.genre_matrix, _ = build_sparse_genre_matrix(self.df)
        else:
            self.genre_matrix = None

        self._pending_batches = []
        self._InvalidateCaches()
        self._ensure_runtime_caches()
        return self

    def fit_incremental(
        self,
        df: pd.DataFrame,
        is_first_batch: bool = False,
    ) -> None:
        """
        Accumulate incoming data batches.
        Actual model training is performed by finalize_incremental_training().
        """
        if not isinstance(df, pd.DataFrame):
            raise TypeError("df must be a pandas DataFrame.")
        if not isinstance(is_first_batch, bool):
            raise TypeError("is_first_batch must be a boolean.")

        if is_first_batch:
            self._pending_batches = []

        if df.empty:
            return None

        required_columns = ["track_id", *AUDIO_FEATURES]
        missing_columns = [col for col in required_columns if col not in df.columns]
        if missing_columns:
            raise ValueError(f"Missing required columns: {missing_columns}")

        self._pending_batches.append(df.copy())
        return None

    def finalize_incremental_training(self) -> "EmbeatRecommender":
        """Combine all accumulated batches and train once."""
        if not self._pending_batches:
            raise ValueError("No pending batches. Call fit_incremental() first.")

        combined_df = pd.concat(self._pending_batches, ignore_index=True)

        print("=== FINALIZING BATCH TRAINING ===")
        print("Received batches:", len(self._pending_batches))
        print("Total input tracks:", len(combined_df))

        self.fit(combined_df)

        print("Cleaned tracks:", len(self.df))
        print("Audio matrix:", self.feature_matrix.shape)
        print("BATCH TRAINING COMPLETED")
        return self

    def set_genre_matrix(
        self,
        genre_matrix: Any,
        track_ids: Optional[Sequence[str]] = None,
    ) -> "EmbeatRecommender":
        """Attach preprocessed genre matrix to the model."""
        if self.df is None:
            raise ValueError("Model has not been fitted.")
        if genre_matrix.shape[0] != len(self.df):
            raise ValueError("Genre matrix and track data have different row counts.")

        if track_ids is not None:
            if list(track_ids) != self.df["track_id"].tolist():
                raise ValueError("Genre matrix Track ID order does not match model data.")

        self.genre_matrix = csr_matrix(genre_matrix)
        self._cached_genre_id = None
        self._ensure_runtime_caches()
        return self

    # ==========================================
    # 2. INTERNAL HELPERS
    # ==========================================

    def _validate_model(
        self,
        require_genre: bool = False,
        require_artist: bool = False,
    ) -> None:
        if self.df is None:
            raise ValueError("Model has not been fitted.")
        if self.feature_matrix is None:
            raise ValueError("Audio feature matrix is missing.")
        if require_genre and self.genre_matrix is None:
            raise ValueError("Genre matrix has not been set.")
        if require_artist and "artist_id" not in self.df.columns:
            raise ValueError(
                "Missing required column 'artist_id'. "
                "It is needed when exclude_same_artist=True."
            )

    @staticmethod
    def _resolve_top_n(top_n: int, top_k: Optional[int]) -> int:
        resolved = top_k if top_k is not None else top_n
        if (
            not isinstance(resolved, (int, np.integer))
            or isinstance(resolved, bool)
            or resolved < 1
        ):
            raise ValueError("top_n/top_k must be a positive integer.")
        return int(resolved)

    @staticmethod
    def _validate_unit_weight(value: float, name: str = "Alpha") -> float:
        if not 0 <= value <= 1:
            raise ValueError(f"{name} must be between 0 and 1.")
        return float(value)

    def _get_track_index(self, track_id: str) -> int:
        if track_id not in self.id_to_idx:
            raise ValueError(f"Track ID not found: {track_id}")
        return self.id_to_idx[track_id]

    def _compute_audio_similarity(self, query_idx: int) -> np.ndarray:
        """Fast L2-normalized dot product equivalent to cosine_similarity."""
        self._ensure_runtime_caches()
        query_vec = self._norm_feature_matrix[query_idx]
        return (self._norm_feature_matrix @ query_vec).ravel()

    def _compute_genre_similarity(self, query_idx: int) -> np.ndarray:
        """Fast sparse L2-normalized dot product equivalent to cosine_similarity."""
        self._ensure_runtime_caches()
        query_row = self._norm_genre_matrix[query_idx]
        return (self._norm_genre_matrix @ query_row.T).toarray().ravel()

    def _compute_hybrid_scores(
        self,
        query_idx: int,
        alpha: float,
    ) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
        audio_sim = self._compute_audio_similarity(query_idx)
        genre_sim = self._compute_genre_similarity(query_idx)
        hybrid_sim = alpha * audio_sim + (1.0 - alpha) * genre_sim
        return audio_sim, genre_sim, hybrid_sim

    def _get_excluded_indices(
        self,
        seed_indices: Sequence[int],
        exclude_same_artist: bool,
    ) -> List[int]:
        self._ensure_runtime_caches()
        excluded: List[int] = list(seed_indices)
        if not exclude_same_artist:
            return excluded

        artist_map = getattr(self, "_artist_to_indices", None)
        if artist_map is not None:
            seed_artists = {
                self.df.iloc[idx]["artist_id"]
                for idx in seed_indices
                if pd.notna(self.df.iloc[idx]["artist_id"])
            }
            for artist_id in seed_artists:
                if artist_id in artist_map:
                    excluded.extend(artist_map[artist_id].tolist())
        else:
            seed_artists = self.df.iloc[list(seed_indices)]["artist_id"].unique()
            same_artist = np.where(
                self.df["artist_id"].isin(seed_artists).to_numpy()
            )[0]
            excluded.extend(same_artist.tolist())

        return excluded

    def _get_result(
        self,
        indices: Sequence[int],
        scores: Optional[Dict[str, np.ndarray]] = None,
    ) -> pd.DataFrame:
        """Build recommendation DataFrame with available metadata and score columns."""
        available_columns = [
            col for col in METADATA_COLUMNS if col in self.df.columns
        ]
        result = self.df.iloc[list(indices)][available_columns].copy()

        if scores is not None:
            for column, values in scores.items():
                result[column] = values[indices]

        return result.reset_index(drop=True)

    @staticmethod
    def _format_output(
        result: pd.DataFrame,
        as_dict: bool,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        return result.to_dict(orient="records") if as_dict else result

    def _rank_scores(
        self,
        scores: np.ndarray,
        top_n: int,
        excluded_indices: Optional[Sequence[int]] = None,
    ) -> List[int]:
        scores_arr = np.asarray(scores, dtype=float)
        valid_mask = np.isfinite(scores_arr)

        if excluded_indices:
            valid_mask[list(excluded_indices)] = False

        valid_indices = np.flatnonzero(valid_mask)
        if len(valid_indices) == 0:
            return []

        valid_scores = scores_arr[valid_indices]
        ranked_order = np.argsort(valid_scores)[::-1][:top_n]
        return valid_indices[ranked_order].tolist()

    # ==========================================
    # 3. TRACK SEARCH AND DETAILS
    # ==========================================

    def search_tracks(
        self,
        query: str,
        limit: int = 20,
        *,
        as_dict: bool = False,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        """Search tracks by track name or artist name."""
        self._validate_model()

        if not isinstance(query, str):
            raise TypeError("Query must be a string.")
        if limit < 1:
            raise ValueError("Limit must be positive.")

        clean_query = query.strip()
        if not clean_query:
            return [] if as_dict else pd.DataFrame()

        track_match = (
            self.df["track_name"]
            .fillna("")
            .str.contains(clean_query, case=False, regex=False)
        )
        artist_match = (
            self.df["artist_name"]
            .fillna("")
            .str.contains(clean_query, case=False, regex=False)
        )

        matched_df = self.df[track_match | artist_match].head(limit)

        if as_dict:
            cols = [c for c in SEARCH_DICT_COLUMNS if c in self.df.columns]
            return matched_df[cols].reset_index(drop=True).to_dict(orient="records")

        return matched_df[SEARCH_DF_COLUMNS].reset_index(drop=True)

    def get_track_details(self, track_id: str) -> Dict[str, Any]:
        """Retrieve metadata and audio features of a single track."""
        self._validate_model()
        idx = self._get_track_index(track_id)
        return self.df.iloc[idx].to_dict()

    # ==========================================
    # 4. AUDIO-ONLY RECOMMENDATION
    # ==========================================

    def recommend_by_track(
        self,
        track_id: str,
        top_n: int = 10,
        exclude_same_artist: bool = False,
        *,
        top_k: Optional[int] = None,
        as_dict: bool = False,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        """Recommend tracks using 9D audio feature cosine similarity."""
        self._validate_model(require_artist=exclude_same_artist)
        resolved_top_n = self._resolve_top_n(top_n, top_k)
        query_idx = self._get_track_index(track_id)

        similarities = self._compute_audio_similarity(query_idx)
        excluded = self._get_excluded_indices([query_idx], exclude_same_artist)
        top_indices = self._rank_scores(similarities, resolved_top_n, excluded)

        result = self._get_result(top_indices, {"similarity": similarities})
        return self._format_output(result, as_dict)

    # ==========================================
    # 5. HYBRID RECOMMENDATION
    # ==========================================

    def recommend_hybrid(
        self,
        track_id: str,
        top_n: int = 10,
        alpha: float = 0.7,
        exclude_same_artist: bool = True,
        *,
        top_k: Optional[int] = None,
        as_dict: bool = False,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        """Combine audio and genre similarities weighted by alpha."""
        self._validate_model(require_genre=True, require_artist=exclude_same_artist)
        resolved_top_n = self._resolve_top_n(top_n, top_k)
        alpha = self._validate_unit_weight(alpha, "Alpha")
        query_idx = self._get_track_index(track_id)

        audio_sim, genre_sim, hybrid_sim = self._compute_hybrid_scores(query_idx, alpha)
        excluded = self._get_excluded_indices([query_idx], exclude_same_artist)
        top_indices = self._rank_scores(hybrid_sim, resolved_top_n, excluded)

        result = self._get_result(
            top_indices,
            {
                "audio_similarity": audio_sim,
                "genre_similarity": genre_sim,
                "hybrid_similarity": hybrid_sim,
            },
        )
        return self._format_output(result, as_dict)

    # ==========================================
    # 6. HYBRID + MMR RECOMMENDATION
    # ==========================================

    def recommend_hybrid_mmr(
        self,
        track_id: str,
        top_n: int = 10,
        alpha: float = 0.7,
        mmr_lambda: float = 0.7,
        candidate_pool: int = 50,
        exclude_same_artist: bool = True,
        *,
        top_k: Optional[int] = None,
        as_dict: bool = False,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        """Hybrid recommendation diversified via vectorized Maximal Marginal Relevance."""
        self._validate_model(require_genre=True, require_artist=exclude_same_artist)
        resolved_top_n = self._resolve_top_n(top_n, top_k)
        if (
            not isinstance(candidate_pool, (int, np.integer))
            or isinstance(candidate_pool, bool)
            or candidate_pool < 1
        ):
            raise ValueError("candidate_pool must be a positive integer.")

        alpha = self._validate_unit_weight(alpha, "Alpha")
        mmr_lambda = self._validate_unit_weight(mmr_lambda, "MMR lambda")
        query_idx = self._get_track_index(track_id)

        audio_sim, genre_sim, hybrid_sim = self._compute_hybrid_scores(query_idx, alpha)
        excluded = self._get_excluded_indices([query_idx], exclude_same_artist)
        candidates = self._rank_scores(hybrid_sim, int(candidate_pool), excluded)

        if not candidates:
            return [] if as_dict else pd.DataFrame()

        # Pairwise similarity within candidate pool using pre-normalized matrices
        cand_audio = self._norm_feature_matrix[candidates]
        audio_pairwise = cand_audio @ cand_audio.T

        cand_genre = self._norm_genre_matrix[candidates]
        genre_pairwise = (cand_genre @ cand_genre.T).toarray()

        pairwise_sim = alpha * audio_pairwise + (1.0 - alpha) * genre_pairwise
        cand_relevance = hybrid_sim[candidates]

        # Vectorized greedy MMR selection
        num_cands = len(candidates)
        target_k = min(resolved_top_n, num_cands)
        selected_positions: List[int] = []
        selected_scores: List[float] = []

        available_mask = np.ones(num_cands, dtype=bool)
        max_redundancy = np.zeros(num_cands, dtype=np.float64)

        for step in range(target_k):
            if step == 0:
                mmr_scores = mmr_lambda * cand_relevance
            else:
                mmr_scores = (
                    mmr_lambda * cand_relevance
                    - (1.0 - mmr_lambda) * max_redundancy
                )

            masked_scores = np.where(available_mask, mmr_scores, -np.inf)
            best_pos = int(np.argmax(masked_scores))
            best_score = float(masked_scores[best_pos])

            selected_positions.append(best_pos)
            selected_scores.append(best_score)
            available_mask[best_pos] = False

            # Update running max redundancy in O(C) vectorized step
            np.maximum(max_redundancy, pairwise_sim[:, best_pos], out=max_redundancy)

        selected_indices = [candidates[pos] for pos in selected_positions]
        result = self._get_result(
            selected_indices,
            {
                "audio_similarity": audio_sim,
                "genre_similarity": genre_sim,
                "hybrid_similarity": hybrid_sim,
            },
        )
        result["mmr_score"] = selected_scores
        return self._format_output(result, as_dict)

    # ==========================================
    # 7. TASTE PROFILE RECOMMENDATION
    # ==========================================

    def recommend_by_taste_profile(
        self,
        track_ids: Union[str, Iterable[str]],
        top_n: int = 10,
        alpha: float = 0.7,
        exclude_same_artist: bool = False,
        *,
        top_k: Optional[int] = None,
        as_dict: bool = False,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        """Recommend tracks based on a multi-track user taste profile centroid."""
        self._validate_model(require_genre=True, require_artist=exclude_same_artist)
        resolved_top_n = self._resolve_top_n(top_n, top_k)

        if isinstance(track_ids, str):
            track_id_list = [track_ids]
        else:
            track_id_list = list(track_ids)

        if not track_id_list:
            raise ValueError("At least one track ID is required.")

        alpha = self._validate_unit_weight(alpha, "Alpha")
        seed_indices = list(
            dict.fromkeys(self._get_track_index(tid) for tid in track_id_list)
        )

        self._ensure_runtime_caches()

        audio_profile = np.asarray(
            self.feature_matrix[seed_indices].mean(axis=0)
        ).reshape(1, -1)
        audio_profile_norm = normalize(audio_profile, norm="l2", axis=1)
        audio_sim = (self._norm_feature_matrix @ audio_profile_norm.T).ravel()

        genre_profile = csr_matrix(self.genre_matrix[seed_indices].mean(axis=0))
        genre_profile_norm = normalize(genre_profile, norm="l2", axis=1)
        genre_sim = (self._norm_genre_matrix @ genre_profile_norm.T).toarray().ravel()

        hybrid_sim = alpha * audio_sim + (1.0 - alpha) * genre_sim

        excluded = self._get_excluded_indices(seed_indices, exclude_same_artist)
        top_indices = self._rank_scores(hybrid_sim, resolved_top_n, excluded)

        result = self._get_result(
            top_indices,
            {
                "audio_similarity": audio_sim,
                "genre_similarity": genre_sim,
                "hybrid_similarity": hybrid_sim,
            },
        )
        return self._format_output(result, as_dict)

    # ==========================================
    # 8. MOOD-BASED RECOMMENDATION
    # ==========================================

    def recommend_by_mood(
        self,
        mood: str,
        top_n: int = 10,
        *,
        top_k: Optional[int] = None,
        as_dict: bool = False,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        """Recommend tracks matching a predefined acoustic mood profile."""
        self._validate_model()
        resolved_top_n = self._resolve_top_n(top_n, top_k)

        if not isinstance(mood, str):
            raise TypeError("Mood must be a string.")

        clean_mood = mood.strip().lower()
        if clean_mood not in MOOD_PROFILES:
            supported = ", ".join(MOOD_PROFILES.keys())
            raise ValueError(
                f"Unsupported mood: '{clean_mood}'. Supported moods: {supported}"
            )

        target_df = pd.DataFrame([MOOD_PROFILES[clean_mood]], columns=AUDIO_FEATURES)
        target_vector = self.scaler.transform(target_df)
        target_norm = normalize(target_vector, norm="l2", axis=1)

        self._ensure_runtime_caches()
        similarities = (self._norm_feature_matrix @ target_norm.T).ravel()
        top_indices = self._rank_scores(similarities, resolved_top_n)

        result = self._get_result(top_indices, {"mood_similarity": similarities})
        return self._format_output(result, as_dict)

    # ==========================================
    # 9. POPULARITY-BASED BASELINE
    # ==========================================

    def recommend_by_popularity(
        self,
        top_n: int = 10,
        exclude_track_ids: Optional[Union[str, Iterable[str]]] = None,
        *,
        top_k: Optional[int] = None,
        as_dict: bool = False,
    ) -> Union[pd.DataFrame, List[Dict[str, Any]]]:
        """Popularity-based cold-start baseline."""
        self._validate_model()
        resolved_top_n = self._resolve_top_n(top_n, top_k)

        if isinstance(exclude_track_ids, str):
            exclude_list = [exclude_track_ids]
        else:
            exclude_list = list(exclude_track_ids or [])

        excluded_indices = [
            self.id_to_idx[tid] for tid in exclude_list if tid in self.id_to_idx
        ]

        self._ensure_runtime_caches()
        popularity_scores = getattr(self, "_popularity_scores", None)
        if popularity_scores is None:
            popularity_scores = (
                pd.to_numeric(self.df["popularity"], errors="coerce")
                .fillna(-np.inf)
                .to_numpy(dtype=float)
            )

        top_indices = self._rank_scores(
            popularity_scores,
            resolved_top_n,
            excluded_indices=excluded_indices,
        )

        result = self._get_result(top_indices)
        return self._format_output(result, as_dict)

    # ==========================================
    # 10. MODEL SERIALIZATION
    # ==========================================

    def save_artifact(self, path: Union[str, Path]) -> Path:
        """Save the trained model artifact without redundant runtime cache bloat."""
        self._validate_model(require_genre=True)
        out_path = Path(path)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        # Strip ephemeral caches prior to pickling to keep artifact compact
        self._InvalidateCaches()

        artifact = {
            "version": 1,
            "model": self,
        }
        joblib.dump(artifact, out_path, compress=3)
        self._ensure_runtime_caches()

        print(f"Model saved successfully: {out_path}")
        return out_path

    @classmethod
    def load_artifact(cls, path: Union[str, Path]) -> "EmbeatRecommender":
        """Load a previously saved model artifact and warm up runtime caches."""
        in_path = Path(path)
        if not in_path.exists():
            raise FileNotFoundError(f"Artifact not found: {in_path}")

        artifact = joblib.load(in_path)
        if artifact.get("version") != 1:
            raise ValueError("Unsupported model artifact version.")

        model = artifact.get("model")
        if not isinstance(model, cls):
            raise TypeError("Invalid model artifact.")

        model._validate_model(require_genre=True)
        model._InvalidateCaches()
        model._ensure_runtime_caches()
        return model
