#!/usr/bin/env bash
# Fetch everything a clone needs that git does not carry.
#
# src-tauri/vendor/ holds four binaries. None of them is in the repository: they
# are build output, they are architecture-specific, and one of the toolchains
# involved is GPL, which has no business inside an Apache-2.0 tree. So they are
# produced here instead.
#
#   ocr-tool          compiled by build.rs from vendor-src/ocr.swift on the first
#                     cargo build. Nothing to do, it just needs Xcode CLT.
#   llama-cli         local text generation, from llama.cpp
#   llama-embedding   local embeddings, same build
#   whisper-cli       speech to text, from whisper.cpp, plus ~1.5 GB of weights
#
# Usage:
#   bash scripts/setup.sh            everything
#   bash scripts/setup.sh --no-whisper   skip the large download
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WITH_WHISPER=1

for arg in "$@"; do
  case "$arg" in
    --no-whisper) WITH_WHISPER=0 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Kety is macOS only, and these scripts build macOS binaries." >&2
  exit 1
fi

for tool in git cmake swiftc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Missing: $tool" >&2
    echo "cmake comes from Homebrew; git and swiftc come with the Xcode Command Line Tools." >&2
    exit 1
  fi
done

echo "==> llama.cpp (llama-cli and llama-embedding)"
bash "$SCRIPT_DIR/setup-llama-cli.sh"

if [[ "$WITH_WHISPER" -eq 1 ]]; then
  echo
  echo "==> whisper.cpp and the medium model, about 1.5 GB"
  bash "$SCRIPT_DIR/setup-whisper.sh"
else
  echo
  echo "==> skipping whisper. A packaged build will refuse to bundle without"
  echo "    src-tauri/vendor/whisper-cli; dev builds are fine."
fi

echo
echo "Done. ocr-tool is compiled by build.rs on the first cargo build."
echo "Next: npm run tauri dev"
