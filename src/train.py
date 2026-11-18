"""CLI and programmatic training pipelines for EmbeatRecommender."""

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional

import pandas as pd

from src.recommender import EmbeatRecommender, build_sparse_genre_matrix

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = PROJECT_ROOT / "data" / "processed" / "balanced_eda.csv"
DEFAULT_OUTPUT = PROJECT_ROOT / "artifacts" / "embeat_recommender.joblib"


def build_genre_matrix(df: pd.DataFrame):
    """Convert artist genres into sparse multi-hot encoding (delegates to core builder)."""
    return build_sparse_genre_matrix(df)


def _save_training_metadata(
    model: EmbeatRecommender,
    output_path: Path,
    training_method: str,
    extra_fields: Optional[Dict[str, Any]] = None,
) -> Path:
    """Persist standardized JSON training metadata next to the saved artifact."""
    total_genres = (
        int(model.genre_matrix.shape[1]) if model.genre_matrix is not None else 0
    )
    metadata: Dict[str, Any] = {
        "model_name": "EmbeatRecommender",
        "training_method": training_method,
        "total_tracks": len(model.df),
        "audio_features": int(model.feature_matrix.shape[1]),
        "total_genres": total_genres,
        "audio_matrix_shape": list(model.feature_matrix.shape),
        "genre_matrix_shape": (
            list(model.genre_matrix.shape) if model.genre_matrix is not None else [0, 0]
        ),
        "artifact_path": str(output_path.resolve()),
        "artifact_filename": output_path.name,
    }
    if extra_fields:
        metadata.update(extra_fields)

    metadata_path = output_path.with_name(f"{output_path.stem}_metadata.json")
    metadata_path.parent.mkdir(parents=True, exist_ok=True)

    with open(metadata_path, "w", encoding="utf-8") as file:
        json.dump(metadata, file, indent=4, ensure_ascii=False)

    print("Metadata saved:", metadata_path)
    return metadata_path


def train_model(input_path=DEFAULT_INPUT, output_path=DEFAULT_OUTPUT) -> EmbeatRecommender:
    """Train EmbeatRecommender from a local CSV file and persist artifact + metadata."""
    in_path = Path(input_path)
    out_path = Path(output_path)

    print("=" * 55)
    print("EMBEAT MODEL TRAINING")
    print("=" * 55)

    print("\n[1/5] Loading dataset...")
    if not in_path.exists():
        raise FileNotFoundError(f"Dataset not found: {in_path}")

    df = pd.read_csv(in_path)
    print("Original shape:", df.shape)

    print("\n[2/5] Training audio & genre model...")
    model = EmbeatRecommender()
    model.fit(df)

    print("Cleaned tracks:", len(model.df))
    print("Audio matrix:", model.feature_matrix.shape)

    print("\n[3/5] Validating genre matrix...")
    if model.genre_matrix is None:
        genre_matrix, _ = build_genre_matrix(model.df)
        model.set_genre_matrix(genre_matrix, track_ids=model.df["track_id"].tolist())

    print("Genre matrix:", model.genre_matrix.shape)
    print("Unique genres:", model.genre_matrix.shape[1])

    print("\n[4/5] Saving model artifact...")
    model.save_artifact(out_path)

    print("\n[5/5] Generating training metadata...")
    _save_training_metadata(model, out_path, training_method="csv")

    return model


def train_model_from_stream(
    output_path=DEFAULT_OUTPUT,
    hf_token=None,
    sample_ratio=0.5,
    max_row_groups_per_file=None,
    max_total_tracks=None,
    min_popularity=0,
    fallback_to_local=True,
) -> EmbeatRecommender:
    """Train the recommendation model from streamed batches."""
    from src.stream_embeat import stream_and_train_50pct

    out_path = Path(output_path)

    print("=" * 55)
    print("EMBEAT STREAMING BATCH TRAINING")
    print("=" * 55)

    model = EmbeatRecommender()

    print("\n[1/5] Receiving data batches...")
    stream_success = stream_and_train_50pct(
        hf_token=hf_token,
        callback_fn=model.fit_incremental,
        sample_ratio=sample_ratio,
        max_row_groups_per_file=max_row_groups_per_file,
        max_total_tracks=max_total_tracks,
        min_popularity=min_popularity,
        fallback_to_local=fallback_to_local,
    )

    if not stream_success:
        raise RuntimeError(
            "Streaming failed or returned no usable data. "
            "Model training was not finalized."
        )

    if not model._pending_batches:
        raise RuntimeError("Streaming completed without receiving any batches.")

    print("\n[2/5] Finalizing accumulated batches...")
    model.finalize_incremental_training()

    print("\n[3/5] Validating genre matrix...")
    if "artist_genres" not in model.df.columns:
        raise ValueError("Required column 'artist_genres' is missing.")

    if model.genre_matrix is None:
        genre_matrix, _ = build_genre_matrix(model.df)
        model.set_genre_matrix(genre_matrix, track_ids=model.df["track_id"].tolist())

    print("Genre matrix:", model.genre_matrix.shape)
    print("Unique genres:", model.genre_matrix.shape[1])

    print("\n[4/5] Saving model artifact...")
    model.save_artifact(out_path)

    print("\n[5/5] Generating training metadata...")
    _save_training_metadata(
        model,
        out_path,
        training_method="batch_accumulation",
        extra_fields={
            "sample_ratio": sample_ratio,
            "max_total_tracks": max_total_tracks,
        },
    )

    return model


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Train Embeat Music Recommendation Model"
    )
    parser.add_argument(
        "--mode",
        type=str,
        choices=["csv", "stream"],
        default="csv",
        help="Training mode: csv or stream",
    )
    parser.add_argument(
        "--input",
        type=str,
        default=str(DEFAULT_INPUT),
        help="Path to input CSV dataset (CSV mode)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=str(DEFAULT_OUTPUT),
        help="Path to save model artifact",
    )
    parser.add_argument(
        "--sample-ratio",
        type=float,
        default=0.5,
        help="Sampling ratio for streaming (1.0 = all data)",
    )
    parser.add_argument(
        "--max-row-groups-per-file",
        type=int,
        default=None,
        help="Maximum row groups to process per Parquet file",
    )
    parser.add_argument(
        "--max-total-tracks",
        type=int,
        default=None,
        help="Maximum number of tracks to receive",
    )
    parser.add_argument(
        "--min-popularity",
        type=int,
        default=0,
        help="Minimum popularity threshold",
    )
    parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="Disable fallback to local sample when streaming fails",
    )

    args = parser.parse_args()

    if not 0 < args.sample_ratio <= 1:
        parser.error("--sample-ratio must be greater than 0 and at most 1")
    if args.max_total_tracks is not None and args.max_total_tracks <= 0:
        parser.error("--max-total-tracks must be greater than 0")
    if (
        args.max_row_groups_per_file is not None
        and args.max_row_groups_per_file <= 0
    ):
        parser.error("--max-row-groups-per-file must be greater than 0")

    print("=" * 55)
    print("EMBEAT TRAINING CLI")
    print("=" * 55)
    print("Training mode:", args.mode)
    print("Output artifact:", args.output)

    if args.mode == "csv":
        print("\nStarting CSV training...")
        train_model(input_path=args.input, output_path=args.output)
    elif args.mode == "stream":
        print("\nStarting Streaming training...")
        train_model_from_stream(
            output_path=args.output,
            sample_ratio=args.sample_ratio,
            max_row_groups_per_file=args.max_row_groups_per_file,
            max_total_tracks=args.max_total_tracks,
            min_popularity=args.min_popularity,
            fallback_to_local=not args.no_fallback,
        )
