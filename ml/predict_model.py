from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Dict, List


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

    return float(value)


def build_features(
    data: Dict,
) -> List[float]:
    entry = number(data, "entryPrice")
    ema20 = number(data, "ema20")
    ema50 = number(data, "ema50")
    ema200 = number(data, "ema200")

    rsi = number(data, "lastRsi")
    adx = number(data, "adx")
    bb = number(data, "bbWidth")
    atr = number(data, "atrPct")
    last_atr = number(data, "lastAtr")

    distance = number(
        data,
        "entryDistanceFromEma20Atr",
    )

    side = str(
        data.get("side", "")
    ).strip().lower()

    hour = int(
        number(data, "hourUtc")
    )

    if side not in {"long", "short"}:
        raise ValueError(
            f"Invalid side: {side}"
        )

    if not 0 <= hour <= 23:
        raise ValueError(
            f"Invalid hourUtc: {hour}"
        )

    volatility_at_entry = (
        last_atr / abs(entry)
        if abs(entry) > 0.000001 and last_atr > 0
        else atr
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

        "side": float(side == "long"),

        "rsi_overbought": float(rsi > 70),
        "rsi_oversold": float(rsi < 30),
        "adx_strong": float(adx > 30),
        "bb_wide": float(bb > 0.08),

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

        "long_side": float(side == "long"),
        "short_side": float(side == "short"),

        "hour_sin": math.sin(
            2 * math.pi * hour / 24
        ),

        "hour_cos": math.cos(
            2 * math.pi * hour / 24
        ),

        "hour_utc_norm": hour / 23.0,

        "volatility_at_entry": volatility_at_entry,
    }

    return [
        values[name]
        for name in FEATURE_NAMES
    ]


def main() -> None:
    import joblib
    import numpy as np

    if not MODEL_FILE.exists():
        raise FileNotFoundError(
            f"Model not found: {MODEL_FILE}"
        )

    input_text = sys.stdin.read().strip()

    if not input_text:
        raise ValueError(
            "Empty stdin input."
        )

    data = json.loads(input_text)
    features = build_features(data)

    artifact = joblib.load(MODEL_FILE)

    model = artifact["model"]
    threshold = float(
        artifact.get("threshold", 0.5)
    )

    expected_features = artifact.get(
        "feature_names"
    )

    if expected_features != FEATURE_NAMES:
        raise RuntimeError(
            "Feature names/order mismatch "
            "between model and predictor."
        )

    X = np.asarray(
        [features],
        dtype=float,
    )

    probability = float(
        model.predict_proba(X)[0, 1]
    )

    result = {
        "probability": probability,
        "threshold": threshold,
        "passed": probability >= threshold,
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
