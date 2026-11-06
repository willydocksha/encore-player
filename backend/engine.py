"""encore ai engine: the detailed analysis (demucs, beat_this, basic pitch) in its own program.

the app stays small and runs the classic analysis itself; this engine is downloaded only when
someone asks for the ai result. the app talks to it over stdout, one json object per line.

usage: EncoreAI analyze <job folder> <title>
"""

from __future__ import annotations

import json
import multiprocessing
import os
import sys
from pathlib import Path


def emit(**msg) -> None:
    print(json.dumps(msg), flush=True)


def main() -> int:
    # https for the model downloads (see main.py); set by the app already, needed when run by hand
    try:
        import certifi

        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except ImportError:
        pass
    if len(sys.argv) >= 2 and sys.argv[1] == "check":
        # the app runs this once after installing, to be sure the engine starts on this computer
        import demucs
        import torch

        emit(ok=True, torch=torch.__version__, demucs=demucs.__version__)
        return 0
    if len(sys.argv) != 4 or sys.argv[1] != "analyze":
        print(__doc__, file=sys.stderr)
        return 2
    from pipeline import analyze

    result = analyze(Path(sys.argv[2]), sys.argv[3], lambda stage, p: emit(stage=stage, p=round(p, 3)), mode="ai")
    emit(result={k: result[k] for k in ("title", "duration", "key", "keys", "bpm", "version", "mode")})
    return 0


if __name__ == "__main__":
    # pyin runs in worker processes; the packaged engine must let them start
    multiprocessing.freeze_support()
    sys.exit(main())
