"""Poll helpers with short intervals and hard timeouts."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import TypeVar

from weplay_df.constants import POLL_INTERVAL_S

T = TypeVar("T")


def poll_until(
    predicate: Callable[[], T | None],
    *,
    timeout_s: float,
    interval_s: float = POLL_INTERVAL_S,
) -> T | None:
    deadline = time.monotonic() + timeout_s
    last: T | None = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval_s)
    return last
