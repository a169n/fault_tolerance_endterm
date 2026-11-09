from __future__ import annotations

import os

from ...core.eventlog import ft_enabled

PER_ATTEMPT_S = int(os.environ.get("FT_TIMEOUT_MS", 800)) / 1000  # S2: one service call

DB_ACQUIRE_S = 1.0 if ft_enabled() else 60.0  # S8 fail-fast; baseline waits

HEALTH_PROBE_S = 0.5  # gateway -> /health/ready

HEALTH_DB_CHECK_S = 0.3  # must stay < HEALTH_PROBE_S
