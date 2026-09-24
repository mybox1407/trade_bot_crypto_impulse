from __future__ import annotations

import csv
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


BASE_DIR = Path(__file__).resolve().parent

TRAIN_FILE = BASE_DIR / "trade_log_analyzed.csv"
MODEL_FILE = BASE_DIR / "trade_model.joblib"
MODEL_META_FILE = BASE_DIR / "trade_model_meta.json"

N_ESTIMATORS = 350
LEARNING_RATE = 0.13
MAX_DEPTH = 4
MIN_SAMPLES_LEAF = 15
SUBSAMPLE = 0.85

ML_PROB_THRESHOLD = 0.5


FEATURE_NAMES = [
    "rsi",
    "adx",
    "bb_width",
    "atr_pct",
    "dist_ema200",
    "ema20_ema50_dist",
    "ema50_ema200_dist",
    "entry_dist_ema20_atr",
    "side",
    "rsi_overbought",
    "rsi_oversold",
    "adx_strong",
    "bb_wide",
    "ema20_above_ema50",
    "ema50_above_ema200",
    "price_above_ema20",
    "price_above_ema50",
    "long_side",
    "short_side",
]


def read_csv(path: Path) -> List[Dict[str, str]]:
    print(f"Loading: {path}")

    with path.open(
        "r",
        newline="",
        encoding="utf-8-sig",
    ) as file:
        rows = list(csv.DictReader(file))

    print(f"Rows loaded: {len(rows)}")
    return rows


def to_float(
    row: Dict[str, str],
    field: str,
    default: float = 0.0,
) -> float:
    value = row.get(field, "")

    if value is None or str(value).strip() == "":
        return default

    return float(
        str(value)
        .strip()
        .replace(",", ".")
    )


def valid_pnl(row: Dict[str, str]) -> bool:
    try:
        return bool(
            np.isfinite(
                to_float(row, "netPnL")
            )
        )
    except (
        TypeError,
        ValueError,
    ):
        return False


def extract_features(
    row: Dict[str, str],
) -> Dict[str, float]:
    try:
        entry = to_float(
            row,
            "entryPrice",
        )

        ema20 = to_float(
            row,
            "ema20",
        )

        ema50 = to_float(
            row,
            "ema50",
        )

        ema200 = to_float(
            row,
            "ema200",
        )

        rsi = to_float(
            row,
            "lastRsi",
            50.0,
        )

        adx = to_float(
            row,
            "adx",
            25.0,
        )

        bb = to_float(
            row,
            "bbWidth",
            0.05,
        )

        atr = to_float(
            row,
            "atrPct",
            0.01,
        )

        distance = to_float(
            row,
            "entryDistanceFromEma20Atr",
            1.0,
        )

        side = row.get(
            "side",
            "",
        ).strip().lower()

        return {
            "rsi": rsi,
            "adx": adx,
            "bb_width": bb,
            "atr_pct": atr,

            "dist_ema200": (
                abs(entry - ema200)
                / max(abs(ema200), 0.001)
            ),

            "ema20_ema50_dist": (
                abs(ema20 - ema50)
                / max(abs(ema20), 0.001)
            ),

            "ema50_ema200_dist": (
                abs(ema50 - ema200)
                / max(abs(ema200), 0.001)
            ),

            "entry_dist_ema20_atr": distance,

            "side": float(
                side == "long"
            ),

            "rsi_overbought": float(
                rsi > 70
            ),

            "rsi_oversold": float(
                rsi < 30
            ),

            "adx_strong": float(
                adx > 30
            ),

            "bb_wide": float(
                bb > 0.08
            ),

            "ema20_above_ema50": float(
                ema20 > ema50
            ),

            "ema50_above_ema200": float(
                ema50 > ema200
            ),

            "price_above_ema20": float(
                entry > ema20
            ),

            "price_above_ema50": float(
                entry > ema50
            ),

            "long_side": float(
                side == "long"
            ),

            "short_side": float(
                side == "short"
            ),
        }

    except (
        TypeError,
        ValueError,
        ZeroDivisionError,
    ):
        return {
            name: 0.0
            for name in FEATURE_NAMES
        }


def vector(
    row: Dict[str, str],
) -> List[float]:
    features = extract_features(row)

    return [
        features[name]
        for name in FEATURE_NAMES
    ]


def save_artifact_atomically(
    artifact: dict,
    destination: Path,
) -> None:
    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            suffix=".joblib.tmp",
            dir=destination.parent,
            delete=False,
        ) as temporary_file:
            temporary_path = Path(
                temporary_file.name
            )

            joblib.dump(
                artifact,
                temporary_file,
                compress=3,
            )

            temporary_file.flush()
            os.fsync(
                temporary_file.fileno()
            )

        os.replace(
            temporary_path,
            destination,
        )

    finally:
        if (
            temporary_path is not None
            and temporary_path.exists()
        ):
            temporary_path.unlink(
                missing_ok=True
            )


def save_meta_file(
    trained_at: str,
    training_rows: int,
    tp_rows: int,
    sl_rows: int,
) -> None:
    metadata = {
        "trained_at": trained_at,
        "training_rows": training_rows,
        "tp_rows": tp_rows,
        "sl_rows": sl_rows,
        "feature_count": len(FEATURE_NAMES),
        "threshold": ML_PROB_THRESHOLD,
        "n_estimators": N_ESTIMATORS,
        "learning_rate": LEARNING_RATE,
        "max_depth": MAX_DEPTH,
        "min_samples_leaf": MIN_SAMPLES_LEAF,
        "subsample": SUBSAMPLE,
    }

    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".json.tmp",
            dir=MODEL_META_FILE.parent,
            delete=False,
            encoding="utf-8",
        ) as temporary_file:
            temporary_path = Path(
                temporary_file.name
            )

            json.dump(
                metadata,
                temporary_file,
                ensure_ascii=False,
                indent=2,
            )

            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(
                temporary_file.fileno()
            )

        os.replace(
            temporary_path,
            MODEL_META_FILE,
        )

    finally:
        if (
            temporary_path is not None
            and temporary_path.exists()
        ):
            temporary_path.unlink(
                missing_ok=True
            )


def print_training_metrics(
    model: Pipeline,
    x_train: np.ndarray,
    y_train: np.ndarray,
) -> None:
    probabilities = model.predict_proba(
        x_train
    )[:, 1]

    predictions = (
        probabilities >= ML_PROB_THRESHOLD
    ).astype(int)

    print(
        "\n==================== "
        "TRAIN METRICS ===================="
    )

    print(
        "These metrics are calculated "
        "on the training data."
    )

    print(
        f"Accuracy: "
        f"{accuracy_score(y_train, predictions):.2%}"
    )

    print(
        f"Precision PROFIT: "
        f"{precision_score(y_train, predictions, zero_division=0):.2%}"
    )

    print(
        f"Recall PROFIT: "
        f"{recall_score(y_train, predictions, zero_division=0):.2%}"
    )

    if len(np.unique(y_train)) == 2:
        print(
            f"ROC-AUC: "
            f"{roc_auc_score(y_train, probabilities):.4f}"
        )

    print("Confusion matrix:")
    print(
        confusion_matrix(
            y_train,
            predictions,
        )
    )

    print("Classification report:")
    print(
        classification_report(
            y_train,
            predictions,
            target_names=[
                "LOSS",
                "PROFIT",
            ],
            zero_division=0,
        )
    )


def main() -> None:
    if not TRAIN_FILE.exists():
        raise FileNotFoundError(
            f"Training file not found: {TRAIN_FILE}"
        )

    all_rows = read_csv(
        TRAIN_FILE
    )

    train_rows = [
        row
        for row in all_rows
        if row.get(
            "res",
            "",
        ).strip().upper() in {
            "TP",
            "SL",
        }
        and valid_pnl(row)
    ]

    if not train_rows:
        raise RuntimeError(
            "No rows with res=TP/SL "
            "and valid netPnL."
        )

    x_train = np.asarray(
        [
            vector(row)
            for row in train_rows
        ],
        dtype=float,
    )

    y_train = np.asarray(
        [
            1
            if row.get(
                "res",
                "",
            ).strip().upper() == "TP"
            else 0
            for row in train_rows
        ],
        dtype=int,
    )

    if len(np.unique(y_train)) < 2:
        raise RuntimeError(
            "Training data must contain "
            "both TP and SL."
        )

    tp_rows = int(
        np.sum(y_train == 1)
    )

    sl_rows = int(
        np.sum(y_train == 0)
    )

    print(
        "\n==================== DATA ===================="
    )

    print(
        f"Training file: {TRAIN_FILE}"
    )

    print(
        f"Training rows: {len(train_rows)}"
    )

    print(
        f"TP rows: {tp_rows}"
    )

    print(
        f"SL rows: {sl_rows}"
    )

    print(
        "Test file: disabled"
    )

    print(
        "Configuration filters: disabled"
    )

    model = Pipeline(
        [
            (
                "scaler",
                StandardScaler(),
            ),
            (
                "classifier",
                GradientBoostingClassifier(
                    n_estimators=N_ESTIMATORS,
                    learning_rate=LEARNING_RATE,
                    max_depth=MAX_DEPTH,
                    min_samples_leaf=MIN_SAMPLES_LEAF,
                    subsample=SUBSAMPLE,
                    random_state=42,
                ),
            ),
        ]
    )

    model.fit(
        x_train,
        y_train,
    )

    print_training_metrics(
        model,
        x_train,
        y_train,
    )

    classifier = model.named_steps[
        "classifier"
    ]

    print(
        "\n==================== "
        "FEATURE IMPORTANCE ===================="
    )

    for name, importance in sorted(
        zip(
            FEATURE_NAMES,
            classifier.feature_importances_,
        ),
        key=lambda item: item[1],
        reverse=True,
    ):
        print(
            f"{name:<28}"
            f"{importance:.6f}"
        )

    trained_at = datetime.now(
        timezone.utc
    ).isoformat()

    artifact = {
        "model": model,
        "feature_names": FEATURE_NAMES,
        "threshold": ML_PROB_THRESHOLD,
        "version": 1,
        "trained_at": trained_at,
        "training_rows": len(train_rows),
        "tp_rows": tp_rows,
        "sl_rows": sl_rows,
    }

    save_artifact_atomically(
        artifact,
        MODEL_FILE,
    )

    save_meta_file(
        trained_at=trained_at,
        training_rows=len(train_rows),
        tp_rows=tp_rows,
        sl_rows=sl_rows,
    )

    print(
        "\n==================== SAVED ===================="
    )

    print(
        f"Model saved: {MODEL_FILE}"
    )

    print(
        f"Metadata saved: {MODEL_META_FILE}"
    )

    print(
        f"Trained at UTC: {trained_at}"
    )

    print(
        f"Threshold: {ML_PROB_THRESHOLD}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            f"Training failed: {error}"
        )
        raise
