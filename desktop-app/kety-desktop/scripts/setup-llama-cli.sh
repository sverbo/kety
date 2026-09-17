#!/usr/bin/env bash
# Build llama-cli (llama.cpp) into src-tauri/vendor/llama-cli - macOS Phase A.
# Usage: bash scripts/setup-llama-cli.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$PROJECT_ROOT/src-tauri/vendor"
OUT_BIN="$VENDOR_DIR/llama-cli"
BUILD_DIR="$(mktemp -d /tmp/llama-cpp-build-XXXXXX)"
ARCH="$(uname -m)"

echo "[setup-llama-cli] Architecture: $ARCH"
echo "[setup-llama-cli] Output: $OUT_BIN"

mkdir -p "$VENDOR_DIR"

METAL_FLAG="-DGGML_METAL=OFF"
if [[ "$ARCH" == "arm64" ]]; then
  METAL_FLAG="-DGGML_METAL=ON"
  echo "[setup-llama-cli] Apple Silicon: GGML_METAL=ON"
fi

echo "[setup-llama-cli] Cloning llama.cpp (shallow) …"
git clone --depth 1 https://github.com/ggerganov/llama.cpp.git "$BUILD_DIR"

echo "[setup-llama-cli] CMake configure …"
# BUILD_SHARED_LIBS=OFF: single self-contained binary for vendor/ (no libllama.0.dylib next to it).
# Without this, dyld looks for @rpath/libllama.0.dylib from the old CMake build dir → SIGABRT.
cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_TESTS=OFF \
  -DLLAMA_BUILD_EXAMPLES=ON \
  -DLLAMA_BUILD_SERVER=OFF \
  -DLLAMA_CURL=OFF \
  $METAL_FLAG

NPROC="$(sysctl -n hw.logicalcpu 2>/dev/null || echo 4)"
OUT_EMBED="$VENDOR_DIR/llama-embedding"

echo "[setup-llama-cli] Build inference CLI …"
if cmake --build "$BUILD_DIR/build" --config Release --target llama-cli -j"$NPROC"; then
  true
else
  echo "[setup-llama-cli] Target llama-cli missing, trying llama-completion …"
  cmake --build "$BUILD_DIR/build" --config Release --target llama-completion -j"$NPROC"
fi

echo "[setup-llama-cli] Build embedding binary …"
cmake --build "$BUILD_DIR/build" --config Release --target llama-embedding -j"$NPROC" || true

BUILT=""
for cand in \
  "$BUILD_DIR/build/bin/llama-cli" \
  "$BUILD_DIR/build/llama-cli" \
  "$BUILD_DIR/build/bin/Release/llama-cli" \
  "$BUILD_DIR/build/bin/llama-completion" \
  "$BUILD_DIR/build/llama-completion" \
  "$BUILD_DIR/build/bin/Release/llama-completion"; do
  if [[ -f "$cand" ]]; then
    BUILT="$cand"
    break
  fi
done

if [[ -z "$BUILT" ]]; then
  echo "[setup-llama-cli] ERROR: llama-cli / llama-completion binary not found under $BUILD_DIR/build" >&2
  find "$BUILD_DIR/build" -maxdepth 5 -type f -perm +111 2>/dev/null | head -40 >&2 || true
  rm -rf "$BUILD_DIR"
  exit 1
fi

cp "$BUILT" "$OUT_BIN"
chmod +x "$OUT_BIN"

BUILT_EMBED=""
for cand in \
  "$BUILD_DIR/build/bin/llama-embedding" \
  "$BUILD_DIR/build/llama-embedding" \
  "$BUILD_DIR/build/bin/Release/llama-embedding"; do
  if [[ -f "$cand" ]]; then
    BUILT_EMBED="$cand"
    break
  fi
done

if [[ -n "$BUILT_EMBED" ]]; then
  cp "$BUILT_EMBED" "$OUT_EMBED"
  chmod +x "$OUT_EMBED"
  echo "[setup-llama-cli] Embedding binary: $OUT_EMBED"
else
  echo "[setup-llama-cli] WARNING: llama-embedding not found, local embed will fail" >&2
fi

if command -v otool >/dev/null 2>&1; then
  if otool -L "$OUT_BIN" 2>/dev/null | grep -q 'libllama\.[0-9]*\.dylib'; then
    echo "[setup-llama-cli] WARNING: $OUT_BIN still links libllama dynamically." >&2
    echo "[setup-llama-cli] Try a newer llama.cpp or report an issue; expected mostly static link." >&2
  else
    echo "[setup-llama-cli] otool: no libllama dylib dependency (good for bundling)."
  fi
fi

rm -rf "$BUILD_DIR"
echo "[setup-llama-cli] Done: $OUT_BIN"
