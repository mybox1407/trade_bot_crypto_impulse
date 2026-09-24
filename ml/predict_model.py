from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict, List

import joblib
import numpy as np


BASE_DIR = Path(__file__).resolve().parent
MODEL_FILE = BASE_DIR / "trade_model.joblib"


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


def number(
    data: Dict,
    key: str,
) -> float:
    value = data.get(key)

    if value is None:
        raise ValueError(
            f"Missing field: {key}"
        )

    result = float(value)

    if not np.isfinite(result):
        raise ValueError(
            f"Field {key} is not finite: {value}"
        )

    return result


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
            "Feature vector contains NaN or Infinity"
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

    data = json.loads(input_text)
    artifact = joblib.load(MODEL_FILE)

    expected_features = artifact.get(
        "feature_names"
    )

    if expected_features != FEATURE_NAMES:
        raise RuntimeError(
            "Feature names/order mismatch. "
            f"Model expects: {expected_features}; "
            f"predictor provides: {FEATURE_NAMES}"
        )

    features = build_features(data)
    model = artifact["model"]

    X = np.asarray(
        [features],
        dtype=float,
    )

    probability = float(
        model.predict_proba(X)[0, 1]
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
        "passed": probability >= threshold,
        "trained_at": artifact.get(
            "trained_at"
        ),
        "training_rows": artifact.get(
            "training_rows"
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
