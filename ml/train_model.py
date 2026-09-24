from __future__ import annotations

import csv
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import joblib
import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


BASE_DIR = Path(__file__).resolve().parent

TRAIN_FILE = BASE_DIR / "trade_log_analyzed.csv"
MODEL_FILE = BASE_DIR / "trade_model.joblib"

N_ESTIMATORS = 250
LEARNING_RATE = 0.025
MAX_DEPTH = 4
MIN_SAMPLES_LEAF = 15
SUBSAMPLE = 0.85

USE_CONFIG_WEIGHTING = True
CONFIG_WEIGHT = 3.0

MODEL_THRESHOLD = 0.50


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


def parse_timestamp(value: str) -> float:
    number = float(str(value).strip())
    absolute = abs(number)

    if absolute >= 1e14:
        return number / 1_000_000

    if absolute >= 1e11:
        return number / 1_000

    return number


def get_entry_datetime(row: Dict[str, str]) -> datetime:
    value = row.get("openedAt") or row.get("timestamp") or ""
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
                value.replace("Z", "+00:00")
            )

            if parsed.tzinfo is None:
                parsed = parsed.replace(
                    tzinfo=timezone.utc
                )

            return parsed.astimezone(timezone.utc)
        except ValueError:
            return datetime(
                1970,
                1,
                1,
                tzinfo=timezone.utc,
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


def check_config(row: Dict[str, str]) -> bool:
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

        ema20 = to_float(row, "ema20")
        ema50 = to_float(row, "ema50")
        ema200 = to_float(row, "ema200")
        entry = to_float(row, "entryPrice")

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


def extract_features(
    row: Dict[str, str],
) -> Dict[str, float]:
    entry = to_float(row, "entryPrice")
    ema20 = to_float(row, "ema20")
    ema50 = to_float(row, "ema50")
    ema200 = to_float(row, "ema200")

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

    volatility_at_entry = (
        last_atr / abs(entry)
        if abs(entry) > 0.000001 and last_atr > 0
        else atr
    )

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
            / max(abs(ema50), 0.001)
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


def vector(row: Dict[str, str]) -> List[float]:
    features = extract_features(row)

    return [
        features[name]
        for name in FEATURE_NAMES
    ]


def main() -> None:
    if not TRAIN_FILE.exists():
        raise FileNotFoundError(
            f"Training file not found: {TRAIN_FILE}"
        )

    all_rows = read_csv(TRAIN_FILE)

    train_rows = [
        row
        for row in all_rows
        if row.get(
            "res",
            "",
        ).strip().upper() in {"TP", "SL"}
        and valid_pnl(row)
    ]

    if not train_rows:
        raise RuntimeError(
            "No rows with res=TP/SL and valid netPnL."
        )

    X_train = np.asarray(
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
            "Training data must contain both TP and SL."
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
    else:
        sample_weights = np.ones(
            len(train_rows),
            dtype=float,
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
        X_train,
        y_train,
        classifier__sample_weight=sample_weights,
    )

    artifact = {
        "model": model,
        "feature_names": FEATURE_NAMES,
        "threshold": MODEL_THRESHOLD,
        "version": 1,
    }

    joblib.dump(
        artifact,
        MODEL_FILE,
        compress=3,
    )

    classifier = model.named_steps[
        "classifier"
    ]

    print("")
    print("==================== MODEL ====================")
    print(f"Rows: {len(train_rows)}")
    print(f"TP: {int(np.sum(y_train == 1))}")
    print(f"SL: {int(np.sum(y_train == 0))}")
    print(
        "Config weighted rows: "
        f"{int(np.sum(sample_weights > 1.0))}"
    )
    print(f"Features: {len(FEATURE_NAMES)}")
    print(f"Threshold: {MODEL_THRESHOLD}")
    print(f"Model saved: {MODEL_FILE}")

    print("")
    print("Feature importance:")

    for name, importance in sorted(
        zip(
            FEATURE_NAMES,
            classifier.feature_importances_,
        ),
        key=lambda item: item[1],
        reverse=True,
    ):
        print(
            f"{name:<28} "
            f"{importance:.6f}"
        )


if __name__ == "__main__":
    main()
