"""fingerprint of what goes into the ai engine; prints it, or checks it with --check.

the engine is kept across app updates (backend/ai.py), so when its inputs change ENGINE_VERSION in
backend/version.py must be bumped and ENGINE_FINGERPRINT set to the new value. inputs: engine.py,
engine.spec, requirements.txt, and the modules pipeline.py imports (a new import may need a new
runtime; a change to the analysis code itself does not).
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def fingerprint() -> str:
    h = hashlib.sha256()
    # the engine program, its build recipe and the dependency list
    for name in ("engine.py", "engine.spec", "requirements.txt"):
        h.update((HERE / name).read_bytes().replace(b"\r\n", b"\n"))
    # only the import lines of the analysis code
    imports = re.findall(r"^\s*((?:from \S+ )?import .+?)\s*(?:#.*)?$", (HERE / "pipeline.py").read_text(), re.M)
    h.update("\n".join(sorted(set(imports))).encode())
    return h.hexdigest()[:16]


if __name__ == "__main__":
    fp = fingerprint()
    if "--check" not in sys.argv:
        print(fp)
        sys.exit(0)
    sys.path.insert(0, str(HERE))
    from version import ENGINE_FINGERPRINT, ENGINE_VERSION

    if fp != ENGINE_FINGERPRINT:
        print(f"the ai engine changed (fingerprint {fp}, version.py says {ENGINE_FINGERPRINT}): bump ENGINE_VERSION "
              f"(now {ENGINE_VERSION}) and set ENGINE_FINGERPRINT = \"{fp}\" in backend/version.py", file=sys.stderr)
        sys.exit(1)
    print(f"ai engine v{ENGINE_VERSION} ({fp})")
