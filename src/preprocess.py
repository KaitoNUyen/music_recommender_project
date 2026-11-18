"""Data preprocessing and validation utilities for the Embeat Recommender."""

from typing import List, Tuple
import pandas as pd
from sklearn.preprocessing import StandardScaler


AUDIO_FEATURES: List[str] = [
    "danceability",
    "energy",
    "valence",
    "tempo",
    "acousticness",
    "instrumentalness",
    "speechiness",
    "liveness",
    "loudness",
]

CORE_AUDIO_FEATURES: List[str] = AUDIO_FEATURES


def validate_and_clean_batch(
    df: pd.DataFrame,
    deduplicate: bool = True,
    min_popularity: int = 0,
) -> pd.DataFrame:
    """
    Validate and clean a track DataFrame or incoming batch.

    Keeps original metadata columns while ensuring all required
    AUDIO_FEATURES are numeric, finite, and have valid positive tempo.
    """
    if not isinstance(df, pd.DataFrame):
        raise TypeError("df must be a pandas DataFrame.")

    missing_features = [col for col in AUDIO_FEATURES if col not in df.columns]
    if missing_features:
        raise ValueError(f"Missing audio features: {missing_features}")

    cleaned = df.copy()

    if deduplicate and "track_id" in cleaned.columns:
        cleaned = cleaned.drop_duplicates(subset="track_id")

    for col in AUDIO_FEATURES:
        cleaned[col] = pd.to_numeric(cleaned[col], errors="coerce")

    cleaned = cleaned.dropna(subset=AUDIO_FEATURES)
    cleaned = cleaned[cleaned["tempo"] > 0]

    if min_popularity > 0:
        if "popularity" not in cleaned.columns:
            raise ValueError("Missing required column: popularity")
        cleaned["popularity"] = pd.to_numeric(cleaned["popularity"], errors="coerce")
        cleaned = cleaned.dropna(subset=["popularity"])
        cleaned = cleaned[cleaned["popularity"] >= min_popularity]

    return cleaned.reset_index(drop=True)


def clean_tracks(df: pd.DataFrame) -> pd.DataFrame:
    """Clean music metadata and audio features (delegates to unified cleaner)."""
    return validate_and_clean_batch(df, deduplicate=True, min_popularity=0)


def fit_scaler(df: pd.DataFrame) -> Tuple[StandardScaler, pd.DataFrame]:
    """Fit StandardScaler on audio features and return (scaler, scaled_matrix)."""
    scaler = StandardScaler()
    scaled_features = scaler.fit_transform(df[AUDIO_FEATURES])
    return scaler, scaled_features


def transform_features(df: pd.DataFrame, scaler: StandardScaler):
    """Transform audio features using a fitted StandardScaler."""
    return scaler.transform(df[AUDIO_FEATURES])
