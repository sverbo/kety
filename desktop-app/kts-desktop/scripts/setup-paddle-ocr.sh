#!/usr/bin/env bash
# setup-paddle-ocr.sh - Installe PaddleOCR dans un virtualenv local pour l'OCR des captures.
# Usage: bash scripts/setup-paddle-ocr.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$PROJECT_ROOT/src-tauri/vendor"
VENV_DIR="$VENDOR_DIR/paddleocr-venv"
RUNNER_SCRIPT="$VENDOR_DIR/paddle-ocr-run.py"

ARCH="$(uname -m)"

echo "[setup-paddle-ocr] Architecture : $ARCH"
echo "[setup-paddle-ocr] Dossier vendor : $VENDOR_DIR"

mkdir -p "$VENDOR_DIR"

# ── 1. Vérification Python 3 ─────────────────────────────────────────────────

if ! command -v python3 &>/dev/null; then
    echo "[setup-paddle-ocr] ERREUR : python3 introuvable." >&2
    echo "  Installe Python 3.9+ (brew install python)" >&2
    exit 1
fi

PYTHON_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
echo "[setup-paddle-ocr] Python détecté : $PYTHON_VERSION"

# ── 2. Création du virtualenv ────────────────────────────────────────────────

if [ -d "$VENV_DIR" ]; then
    echo "[setup-paddle-ocr] virtualenv déjà présent - ignoré."
else
    echo "[setup-paddle-ocr] Création du virtualenv dans $VENV_DIR …"
    python3 -m venv "$VENV_DIR"
fi

VENV_PYTHON="$VENV_DIR/bin/python3"
VENV_PIP="$VENV_DIR/bin/pip"

# ── 3. Installation de PaddleOCR ─────────────────────────────────────────────

echo "[setup-paddle-ocr] Mise à jour de pip …"
"$VENV_PIP" install --upgrade pip --quiet

echo "[setup-paddle-ocr] Installation de paddlepaddle (CPU) …"
# Sur macOS Apple Silicon, paddlepaddle ne supporte pas CUDA ; la version CPU fonctionne.
"$VENV_PIP" install paddlepaddle --quiet

echo "[setup-paddle-ocr] Installation de paddleocr …"
# paddleocr télécharge les modèles PP-OCRv4 (~15 Mo) au premier lancement.
"$VENV_PIP" install "paddleocr>=2.7" --quiet

echo "[setup-paddle-ocr] Packages installés."

# ── 4. Script runner ─────────────────────────────────────────────────────────

cat > "$RUNNER_SCRIPT" << 'PYEOF'
#!/usr/bin/env python3
"""PaddleOCR runner - lit une image, imprime le texte extrait sur stdout (une ligne par détection)."""
import sys
import os
import logging
import warnings

# Suppress verbose PaddlePaddle / OpenCV logs
os.environ.setdefault("PADDLE_LOG_LEVEL", "WARNING")
os.environ.setdefault("FLAGS_use_cuda", "0")
logging.disable(logging.WARNING)
warnings.filterwarnings("ignore")

if len(sys.argv) < 2:
    print("Usage: paddle-ocr-run.py <image_path>", file=sys.stderr)
    sys.exit(1)

img_path = sys.argv[1]
if not os.path.isfile(img_path):
    print(f"Fichier introuvable : {img_path}", file=sys.stderr)
    sys.exit(1)

from paddleocr import PaddleOCR

# Compatibilité ancienne API (use_angle_cls) et nouvelle API (use_textline_orientation).
try:
    ocr = PaddleOCR(use_textline_orientation=True, lang='en')
except TypeError:
    ocr = PaddleOCR(use_angle_cls=True, lang='en', show_log=False)

# Lancement OCR - cls=True uniquement si supporté (ancienne API).
try:
    result = ocr.ocr(img_path)
except TypeError:
    result = ocr.ocr(img_path, cls=True)

if not result:
    sys.exit(0)

lines = []
for page in result:
    if not page:
        continue
    for item in page:
        if not item or len(item) < 2:
            continue
        label = item[1]
        # Ancienne API : label = ('texte', confiance)
        # Nouvelle API : label peut être un dict ou un tuple
        if isinstance(label, (list, tuple)) and len(label) >= 1:
            text = label[0]
        elif isinstance(label, dict):
            text = label.get('text', '')
        else:
            text = str(label)
        if isinstance(text, str) and text.strip():
            lines.append(text.strip())

print("\n".join(lines))
PYEOF

chmod +x "$RUNNER_SCRIPT"
echo "[setup-paddle-ocr] Script runner créé → $RUNNER_SCRIPT"

# ── Résumé ───────────────────────────────────────────────────────────────────

echo ""
echo "[setup-paddle-ocr] Configuration terminée."
echo "  Python venv  : $VENV_PYTHON"
echo "  Runner OCR   : $RUNNER_SCRIPT"
echo ""
echo "Note : les modèles PP-OCRv4 (~15 Mo) seront téléchargés automatiquement"
echo "       dans ~/.paddleocr/ lors du premier lancement OCR."
echo ""
echo "Lance 'cargo tauri dev' pour activer l'OCR automatique des captures (⌃B)."
