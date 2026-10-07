#!/usr/bin/env bash
# Install the runtime a -min desktop package uses for the hands: a venv with
# `nanomuse[hands]` from this tree (or from PyPI with --from-pypi), then point
# the desktop at it with NANOMUSE_PY. For 2-CPU / 4 GB machines this avoids the
# ~150 MB bundled PyInstaller runtime inside the .deb.
#
#   scripts/install-runtime-linux.sh                       # from this tree
#   scripts/install-runtime-linux.sh --from-pypi            # no tree needed
#   NANOMUSE_PY=~/.local/share/nanomuse/runtime-venv/bin/nanomuse nanomuse-desktop
set -euo pipefail

FROM_PYPI=0
[ "${1:-}" = "--from-pypi" ] && FROM_PYPI=1
VENV="${NANOMUSE_RUNTIME_VENV:-$HOME/.local/share/nanomuse/runtime-venv}"

python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
if [ $FROM_PYPI = 1 ]; then
  "$VENV/bin/python" -m pip install "nanomuse[hands]"
else
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  "$VENV/bin/python" -m pip install -e "$ROOT[hands]"
fi

echo "runtime: $VENV/bin/nanomuse"
echo "run the desktop with: NANOMUSE_PY=$VENV/bin/nanomuse nanomuse-desktop"
