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


# ==================== ПУТИ ====================

BASE_DIR = Path(__file__).resolve().parent

TRAIN_FILE = BASE_DIR / "trade_log_analyzed.csv"
MODEL_FILE = BASE_DIR / "trade_model.joblib"
MODEL_META_FILE = BASE_DIR / "trade_model_meta.json"


# ==================== НАСТРОЙКИ ====================

# Поле PnL, по которому формируется целевая переменная:
# pnl > 0  -> PROFIT
# pnl <= 0 -> LOSS
TRAIN_PNL_FIELD = "pnl"

# Используется только для информационной проверки.
# В обучении поле res не используется.
RES_FIELD = "res"

# Применять ли фильтр конфигурации к обучающим данным.
TRAIN_USE_CONFIG_FILTER = False

# Повышать вес сделок, которые соответствуют конфигурации стратегии.
USE_CONFIG_WEIGHTING = True
CONFIG_WEIGHT = 2.0

# Вероятность PROFIT, с которой бот допускает сделку.
ML_PROB_THRESHOLD = 0.7

# Параметры модели.
N_ESTIMATORS = 340
LEARNING_RATE = 0.009
MAX_DEPTH = 4
MIN_SAMPLES_LEAF = 25
SUBSAMPLE = 0.78
RANDOM_STATE = 42

# Единица времени в openedAt/timestamp:
# auto, seconds, milliseconds, microseconds
TIMESTAMP_UNIT = "auto"


# ==================== ПРИЗНАКИ ====================

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
    "hour_sin",
    "hour_cos",
    "hour_utc_norm",
    "volatility_at_entry",
]


# ==================== CSV ====================

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


def valid_number(
    row: Dict[str, str],
    field: str,
) -> bool:
    raw_value = row.get(field, "")

    if raw_value is None or str(raw_value).strip() == "":
        return False

    try:
        return bool(
            np.isfinite(
                to_float(row, field)
            )
        )
    except (
        TypeError,
        ValueError,
    ):
        return False


# ==================== КОНФИГУРАЦИЯ СТРАТЕГИИ ====================

def check_config(
    row: Dict[str, str],
) -> bool:
    try:
        side = row.get(
            "side",
            "",
        ).strip().lower()

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

        atr = to_float(
            row,
            "atrPct",
            0.01,
        )

        bb = to_float(
            row,
            "bbWidth",
            0.05,
        )

        distance = to_float(
            row,
            "entryDistanceFromEma20Atr",
            1.0,
        )

        extended = (
            row.get(
                "entryTooExtended",
                "false",
            )
            .strip()
            .lower()
            == "true"
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

        entry = to_float(
            row,
            "entryPrice",
        )

    except (
        TypeError,
        ValueError,
    ):
        return False

    if side == "long":
        return (
            51 <= rsi <= 64
            and 29.5 <= adx <= 40
            and 0.005 <= atr <= 0.0195
            and 0.053 <= bb <= 0.090
            and 0.9 <= distance <= 1.5
            and not extended
            and ema20 > ema50 > ema200
            and entry > ema200
        )

    if side == "short":
        return (
            39 <= rsi <= 42
            and 25 <= adx <= 40
            and 0.005 <= atr <= 0.025
            and bb >= 0.05
            and distance >= 0.9
            and not extended
            and ema20 < ema50 < ema200
            and entry < ema200
        )

    return False


# ==================== ВРЕМЯ ====================

def parse_timestamp(
    value: str,
) -> float:
    value = str(value).strip()
    number = float(value)

    if TIMESTAMP_UNIT == "seconds":
        return number

    if TIMESTAMP_UNIT == "milliseconds":
        return number / 1_000

    if TIMESTAMP_UNIT == "microseconds":
        return number / 1_000_000

    # Автоматическое определение.
    absolute = abs(number)

    if absolute >= 1e14:
        return number / 1_000_000

    if absolute >= 1e11:
        return number / 1_000

    return number


def get_entry_datetime(
    row: Dict[str, str],
) -> datetime:
    value = (
        row.get("openedAt")
        or row.get("timestamp")
        or ""
    )

    value = str(value).strip()

    try:
        return datetime.fromtimestamp(
            parse_timestamp(value),
            tz=timezone.utc,
        )

    except (
        TypeError,
        ValueError,
        OverflowError,
        OSError,
    ):
        try:
            parsed = datetime.fromisoformat(
                value.replace(
                    "Z",
                    "+00:00",
                )
            )

            if parsed.tzinfo is None:
                parsed = parsed.replace(
                    tzinfo=timezone.utc
                )

            return parsed.astimezone(
                timezone.utc
            )

        except ValueError:
            return datetime(
                1970,
                1,
                1,
                tzinfo=timezone.utc,
            )


# ==================== ПРИЗНАКИ ====================

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

        last_atr = to_float(
            row,
            "lastAtr",
            0.0,
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

        hour = get_entry_datetime(row).hour

        if (
            abs(entry) > 0.000001
            and last_atr > 0
        ):
            volatility_at_entry = (
                last_atr / abs(entry)
            )
        else:
            volatility_at_entry = atr

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

            "hour_sin": math.sin(
                2 * math.pi * hour / 24
            ),

            "hour_cos": math.cos(
                2 * math.pi * hour / 24
            ),

            "hour_utc_norm": hour / 23.0,

            "volatility_at_entry": (
                volatility_at_entry
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


# ==================== СОХРАНЕНИЕ ====================

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
    metadata: dict,
    destination: Path,
) -> None:
    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".json.tmp",
            dir=destination.parent,
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


# ==================== TRAIN METRICS ====================

def print_training_metrics(
    model: Pipeline,
    x_train: np.ndarray,
    y_train: np.ndarray,
) -> None:
    probabilities = model.predict_proba(
        x_train
    )[:, 1]

    predictions = (
        probabilities >= 0.5
    ).astype(int)

    print(
        "\n==================== "
        "TRAIN METRICS ===================="
    )

    print(
        "Метрики рассчитаны на обучающих данных."
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


# ==================== MAIN ====================

def main() -> None:
    if not TRAIN_FILE.exists():
        raise FileNotFoundError(
            f"Training file not found: {TRAIN_FILE}"
        )

    all_rows = read_csv(
        TRAIN_FILE
    )

    if TRAIN_USE_CONFIG_FILTER:
        source_rows = [
            row
            for row in all_rows
            if check_config(row)
        ]
    else:
        source_rows = all_rows

    # Обучение строго по TRAIN_PNL_FIELD.
    train_rows = [
        row
        for row in source_rows
        if valid_number(
            row,
            TRAIN_PNL_FIELD,
        )
    ]

    if not train_rows:
        raise RuntimeError(
            f"No rows with valid "
            f"{TRAIN_PNL_FIELD}."
        )

    x_train = np.asarray(
        [
            vector(row)
            for row in train_rows
        ],
        dtype=float,
    )

    # PROFIT: PnL > 0.
    # LOSS: PnL <= 0.
    y_train = np.asarray(
        [
            1
            if to_float(
                row,
                TRAIN_PNL_FIELD,
            ) > 0
            else 0
            for row in train_rows
        ],
        dtype=int,
    )

    if len(np.unique(y_train)) < 2:
        raise RuntimeError(
            "Training data must contain "
            "both PROFIT and LOSS."
        )

    profit_rows = int(
        np.sum(y_train == 1)
    )

    loss_rows = int(
        np.sum(y_train == 0)
    )

    if USE_CONFIG_WEIGHTING:
        sample_weights = np.asarray(
            [
                CONFIG_WEIGHT
                if check_config(row)
                else 1.0
                for row in train_rows
            ],
            dtype=float,
        )

        config_weighted_rows = int(
            np.sum(sample_weights > 1.0)
        )
    else:
        sample_weights = np.ones(
            len(train_rows),
            dtype=float,
        )

        config_weighted_rows = 0

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
        f"Profit rows: {profit_rows}"
    )

    print(
        f"Loss rows: {loss_rows}"
    )

    print(
        f"Target field: {TRAIN_PNL_FIELD}"
    )

    print(
        "Target rule: "
        f"{TRAIN_PNL_FIELD} > 0 => PROFIT"
    )

    print(
        f"Config filter: "
        f"{TRAIN_USE_CONFIG_FILTER}"
    )

    print(
        f"Config weighted rows: "
        f"{config_weighted_rows}"
    )

    print(
        f"Config weight: "
        f"{CONFIG_WEIGHT if USE_CONFIG_WEIGHTING else 1.0}"
    )

    print(
        "Test: disabled"
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
                    random_state=RANDOM_STATE,
                ),
            ),
        ]
    )

    model.fit(
        x_train,
        y_train,
        classifier__sample_weight=sample_weights,
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
        "version": 2,
        "trained_at": trained_at,
        "training_rows": len(train_rows),
        "profit_rows": profit_rows,
        "loss_rows": loss_rows,
        "train_pnl_field": TRAIN_PNL_FIELD,
        "target_rule": (
            f"{TRAIN_PNL_FIELD} > 0 => PROFIT"
        ),
        "config_filter": TRAIN_USE_CONFIG_FILTER,
        "config_weighting": USE_CONFIG_WEIGHTING,
        "config_weight": (
            CONFIG_WEIGHT
            if USE_CONFIG_WEIGHTING
            else 1.0
        ),
        "timestamp_unit": TIMESTAMP_UNIT,
    }

    save_artifact_atomically(
        artifact,
        MODEL_FILE,
    )

    metadata = {
        "trained_at": trained_at,
        "training_rows": len(train_rows),
        "profit_rows": profit_rows,
        "loss_rows": loss_rows,
        "feature_count": len(FEATURE_NAMES),
        "feature_names": FEATURE_NAMES,
        "threshold": ML_PROB_THRESHOLD,
        "train_pnl_field": TRAIN_PNL_FIELD,
        "target_rule": (
            f"{TRAIN_PNL_FIELD} > 0 => PROFIT"
        ),
        "config_filter": TRAIN_USE_CONFIG_FILTER,
        "config_weighting": USE_CONFIG_WEIGHTING,
        "config_weight": (
            CONFIG_WEIGHT
            if USE_CONFIG_WEIGHTING
            else 1.0
        ),
        "n_estimators": N_ESTIMATORS,
        "learning_rate": LEARNING_RATE,
        "max_depth": MAX_DEPTH,
        "min_samples_leaf": MIN_SAMPLES_LEAF,
        "subsample": SUBSAMPLE,
        "random_state": RANDOM_STATE,
        "timestamp_unit": TIMESTAMP_UNIT,
        "test_enabled": False,
    }

    save_meta_file(
        metadata,
        MODEL_META_FILE,
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
