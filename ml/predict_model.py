from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import joblib
import numpy as np


BASE_DIR = Path(__file__).resolve().parent
MODEL_FILE = BASE_DIR / "trade_model.joblib"


TIMESTAMP_UNIT = "auto"


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


def number(
    data: Dict,
    key: str,
) -> float:
    value = data.get(key)

    if value is None:
        raise ValueError(
            f"Missing field: {key}"
        )

    result = float(
        str(value)
        .strip()
        .replace(",", ".")
    )

    if not np.isfinite(result):
        raise ValueError(
            f"Field {key} is not finite: {value}"
        )

    return result


def parse_timestamp(
    value: str,
) -> float:
    value = str(value).strip()
    result = float(value)

    if TIMESTAMP_UNIT == "seconds":
        return result

    if TIMESTAMP_UNIT == "milliseconds":
        return result / 1_000

    if TIMESTAMP_UNIT == "microseconds":
        return result / 1_000_000

    absolute = abs(result)

    if absolute >= 1e14:
        return result / 1_000_000

    if absolute >= 1e11:
        return result / 1_000

    return result


def get_entry_datetime(
    data: Dict,
) -> datetime:
    value = (
        data.get("openedAt")
        or data.get("timestamp")
        or ""
    )

    value = str(value).strip()

    if not value:
        raise ValueError(
            "Missing field: openedAt or timestamp"
        )

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

        except ValueError as error:
            raise ValueError(
                f"Invalid timestamp: {value}"
            ) from error


def build_features(
    data: Dict,
) -> List[float]:
    entry = number(
        data,
        "entryPrice",
    )

    ema20 = number(
        data,
        "ema20",
    )

    ema50 = number(
        data,
        "ema50",
    )

    ema200 = number(
        data,
        "ema200",
    )

    rsi = number(
        data,
        "lastRsi",
    )

    adx = number(
        data,
        "adx",
    )

    bb = number(
        data,
        "bbWidth",
    )

    atr = number(
        data,
        "atrPct",
    )

    last_atr = number(
        data,
        "lastAtr",
    )

    distance = number(
        data,
        "entryDistanceFromEma20Atr",
    )

    side = str(
        data.get(
            "side",
            "",
        )
    ).strip().lower()

    if side not in {
        "long",
        "short",
    }:
        raise ValueError(
            f"Invalid side: {side}"
        )

    if entry <= 0:
        raise ValueError(
            f"Invalid entryPrice: {entry}"
        )

    if ema20 <= 0:
        raise ValueError(
            f"Invalid ema20: {ema20}"
        )

    if ema50 <= 0:
        raise ValueError(
            f"Invalid ema50: {ema50}"
        )

    if ema200 <= 0:
        raise ValueError(
            f"Invalid ema200: {ema200}"
        )

    entry_datetime = get_entry_datetime(
        data
    )

    hour = entry_datetime.hour

    if (
        last_atr > 0
        and abs(entry) > 0.000001
    ):
        volatility_at_entry = (
            last_atr / abs(entry)
        )
    else:
        volatility_at_entry = atr

    values = {
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

    features = [
        values[name]
        for name in FEATURE_NAMES
    ]

    feature_array = np.asarray(
        features,
        dtype=float,
    )

    if not np.all(
        np.isfinite(feature_array)
    ):
        raise ValueError(
            "Feature vector contains "
            "NaN or Infinity"
        )

    return features


def main() -> None:
    if not MODEL_FILE.exists():
        raise FileNotFoundError(
            f"Model not found: {MODEL_FILE}"
        )

    input_text = sys.stdin.read().strip()

    if not input_text:
        raise ValueError(
            "Empty stdin input"
        )

    try:
        data = json.loads(input_text)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"Invalid JSON input: {error}"
        ) from error

    if not isinstance(data, dict):
        raise ValueError(
            "Input JSON must be an object"
        )

    artifact = joblib.load(
        MODEL_FILE
    )

    if not isinstance(artifact, dict):
        raise RuntimeError(
            "Invalid model artifact"
        )

    expected_features = artifact.get(
        "feature_names"
    )

    if expected_features != FEATURE_NAMES:
        raise RuntimeError(
            "Feature names/order mismatch. "
            f"Model expects: {expected_features}; "
            f"Predictor provides: {FEATURE_NAMES}"
        )

    features = build_features(
        data
    )

    model = artifact.get(
        "model"
    )

    if model is None:
        raise RuntimeError(
            "Model object is missing "
            "inside artifact"
        )

    X = np.asarray(
        [features],
        dtype=float,
    )

    probabilities = model.predict_proba(
        X
    )

    model_classes = getattr(
        model,
        "classes_",
        None,
    )

    if model_classes is None:
        classifier = getattr(
            model,
            "named_steps",
            {},
        ).get("classifier")

        if classifier is None:
            classifier = getattr(
                model,
                "named_steps",
                {},
            ).get("clf")

        model_classes = getattr(
            classifier,
            "classes_",
            None,
        )

    if model_classes is None:
        raise RuntimeError(
            "Cannot determine model classes"
        )

    profit_class_indexes = np.where(
        np.asarray(model_classes) == 1
    )[0]

    if len(profit_class_indexes) != 1:
        raise RuntimeError(
            "Model does not contain "
            "class 1=PROFIT"
        )

    profit_index = int(
        profit_class_indexes[0]
    )

    probability = float(
        probabilities[0][profit_index]
    )

    threshold = float(
        artifact.get(
            "threshold",
            0.5,
        )
    )

    result = {
        "probability": probability,
        "threshold": threshold,
        "passed": bool(
            probability >= threshold
        ),
        "trained_at": artifact.get(
            "trained_at"
        ),
        "training_rows": artifact.get(
            "training_rows"
        ),
        "feature_count": len(
            FEATURE_NAMES
        ),
    }

    print(
        json.dumps(
            result,
            ensure_ascii=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    try:
        main()

    except Exception as error:
        print(
            json.dumps(
                {
                    "error": str(error),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )

        sys.exit(1)
