#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-$HOME/whisper.cpp}"
MODEL_NAME="${WHISPER_MODEL_NAME:-base.en}"

echo "Installing whisper.cpp into: $INSTALL_DIR"
echo "Model: $MODEL_NAME"

sudo apt update
sudo apt install -y git cmake build-essential ffmpeg libopenblas-dev

if [ ! -d "$INSTALL_DIR" ]; then
  git clone https://github.com/ggml-org/whisper.cpp.git "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi

cd "$INSTALL_DIR"
cmake -B build -DGGML_BLAS=1
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh "$MODEL_NAME"

echo
echo "Installed whisper.cpp successfully."
echo "Binary: $INSTALL_DIR/build/bin/whisper-cli"
echo "Model:  $INSTALL_DIR/models/ggml-$MODEL_NAME.bin"
