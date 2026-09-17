#!/usr/bin/env bash
# setup-whisper.sh - Build whisper-cli and download ggml-medium.bin
# Usage: bash scripts/setup-whisper.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$PROJECT_ROOT/src-tauri/vendor"
MODELS_DIR="$VENDOR_DIR/models"
WHISPER_BIN="$VENDOR_DIR/whisper-cli"
MODEL_FILE="$MODELS_DIR/ggml-medium.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
WHISPER_REPO="https://github.com/ggerganov/whisper.cpp.git"
BUILD_DIR="$(mktemp -d /tmp/whisper-cpp-build-XXXXXX)"

ARCH="$(uname -m)"

echo "[setup-whisper] Architecture : $ARCH"
echo "[setup-whisper] Dossier vendor : $VENDOR_DIR"

mkdir -p "$MODELS_DIR"

# ── 1. Build whisper-cli ─────────────────────────────────────────────────────

if [ -f "$WHISPER_BIN" ]; then
    echo "[setup-whisper] whisper-cli déjà présent - build ignoré."
else
    echo "[setup-whisper] Clonage de whisper.cpp dans $BUILD_DIR …"
    git clone --depth 1 "$WHISPER_REPO" "$BUILD_DIR"

    echo "[setup-whisper] Configuration cmake …"
    BUILD_OUT="$BUILD_DIR/build"
    mkdir -p "$BUILD_OUT"

    CMAKE_EXTRA_FLAGS=""
    if [ "$ARCH" = "arm64" ]; then
        CMAKE_EXTRA_FLAGS="-DWHISPER_METAL=ON"
        echo "[setup-whisper] Apple Silicon détecté - activation Metal."
    else
        echo "[setup-whisper] Intel x86_64 - flags cmake standards."
    fi

    cmake -S "$BUILD_DIR" -B "$BUILD_OUT" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        $CMAKE_EXTRA_FLAGS

    echo "[setup-whisper] Compilation …"
    cmake --build "$BUILD_OUT" --config Release --target whisper-cli -j"$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"

    # Le binaire peut s'appeler whisper-cli ou main selon la version.
    if [ -f "$BUILD_OUT/bin/whisper-cli" ]; then
        BUILT_BIN="$BUILD_OUT/bin/whisper-cli"
    elif [ -f "$BUILD_OUT/whisper-cli" ]; then
        BUILT_BIN="$BUILD_OUT/whisper-cli"
    elif [ -f "$BUILD_OUT/bin/main" ]; then
        BUILT_BIN="$BUILD_OUT/bin/main"
    elif [ -f "$BUILD_OUT/main" ]; then
        BUILT_BIN="$BUILD_OUT/main"
    else
        echo "[setup-whisper] ERREUR : binaire whisper-cli introuvable après build." >&2
        echo "  Contenu de $BUILD_OUT :" >&2
        ls -la "$BUILD_OUT" >&2
        exit 1
    fi

    cp "$BUILT_BIN" "$WHISPER_BIN"
    chmod +x "$WHISPER_BIN"
    echo "[setup-whisper] whisper-cli copié → $WHISPER_BIN"

    # Nettoyage du répertoire de build temporaire.
    rm -rf "$BUILD_DIR"
fi

# ── 2. Téléchargement du modèle ──────────────────────────────────────────────

if [ -f "$MODEL_FILE" ]; then
    echo "[setup-whisper] ggml-medium.bin déjà présent - téléchargement ignoré."
else
    echo "[setup-whisper] Téléchargement du modèle ggml-medium.bin (~1,5 Go) …"
    echo "  URL : $MODEL_URL"
    if command -v curl &>/dev/null; then
        curl -L --progress-bar -o "$MODEL_FILE" "$MODEL_URL"
    elif command -v wget &>/dev/null; then
        wget -q --show-progress -O "$MODEL_FILE" "$MODEL_URL"
    else
        echo "[setup-whisper] ERREUR : curl ou wget requis pour télécharger le modèle." >&2
        exit 1
    fi
    echo "[setup-whisper] Modèle téléchargé → $MODEL_FILE"
fi

# ── 3. ffmpeg ────────────────────────────────────────────────────────────────
FFMPEG_BIN_DEST="$VENDOR_DIR/ffmpeg"

if [ -f "$FFMPEG_BIN_DEST" ]; then
    echo "[setup-whisper] ffmpeg déjà présent - ignoré."
else
    # Check if ffmpeg is in PATH (e.g., installed via brew)
    if command -v ffmpeg &>/dev/null; then
        echo "[setup-whisper] ffmpeg trouvé dans PATH : $(command -v ffmpeg)"
        cp "$(command -v ffmpeg)" "$FFMPEG_BIN_DEST"
        chmod +x "$FFMPEG_BIN_DEST"
    elif command -v brew &>/dev/null; then
        echo "[setup-whisper] Installation de ffmpeg via Homebrew..."
        brew install ffmpeg
        cp "$(command -v ffmpeg)" "$FFMPEG_BIN_DEST"
        chmod +x "$FFMPEG_BIN_DEST"
    else
        echo "[setup-whisper] ERREUR: ffmpeg introuvable et brew non disponible."
        echo "  Installe ffmpeg manuellement (brew install ffmpeg) puis relance ce script."
        exit 1
    fi
    echo "[setup-whisper] ffmpeg copié → $FFMPEG_BIN_DEST"
fi

# ── Résumé ───────────────────────────────────────────────────────────────────

echo ""
echo "[setup-whisper] Configuration terminée."
echo "  Binaire whisper : $WHISPER_BIN"
echo "  Modèle          : $MODEL_FILE"
echo "  ffmpeg          : $FFMPEG_BIN_DEST"
echo ""
echo "Lance 'cargo tauri dev' (ou build) pour compiler l'application."
