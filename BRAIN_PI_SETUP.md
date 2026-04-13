# Brain Pi Setup

This setup assumes:

- the webcam is plugged into the Brain Pi
- Chromium on the Brain Pi uses the webcam microphone directly for capture
- the dashboard opens automatically on boot
- the local dashboard server handles `POST /api/ask` for Gemma 4 or Ollama
- the local dashboard server handles `POST /api/stt` for offline speech-to-text

## 1. Hardware

- Connect the Arduino Uno to the Brain Pi over USB.
- Connect the webcam to the Brain Pi over USB.
- Connect the Brain Pi display.
- Connect speakers or use the monitor audio output for browser speech synthesis.
- Use a stable power supply for the Pi.

## 2. Clone or update the repo

```bash
cd ~
git clone https://github.com/robenn044/TRIAGE.git
cd TRIAGE
git pull
```

## 3. Install system packages

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nodejs npm chromium
sudo apt install -y libcap-dev libjpeg-dev libopenjp2-7
sudo apt install -y libopenblas-dev
```

## 4. Install Node dependencies and build

```bash
cd ~/TRIAGE
npm install
npm run build
```

## 5. Create the Brain Pi Python environment

```bash
cd ~/TRIAGE/pi/brain
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip wheel
pip install -r requirements.txt
deactivate
```

## 6. Configure AI keys

Create `~/TRIAGE/.env.local`:

```env
GEMINI_API_KEY=your_google_ai_studio_key
GEMINI_MODEL=gemma-4-26b-a4b-it
```

Optional Ollama override:

```env
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma4
```

## 6b. Install Offline STT with whisper.cpp

Official upstream project:

- [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)

Install it with the helper script:

```bash
cd ~/TRIAGE/pi/brain
chmod +x install_whisper_cpp.sh
./install_whisper_cpp.sh
```

This follows the upstream quick-start flow:

- clone `whisper.cpp`
- build `whisper-cli`
- download `ggml-base.en.bin`

If you want a different model later:

```bash
WHISPER_MODEL_NAME=small.en ./install_whisper_cpp.sh
```

## 7. Install systemd services

```bash
cd ~/TRIAGE
sudo cp pi/systemd/triage-camera-brain.service /etc/systemd/system/
sudo cp pi/systemd/triage-dashboard-server.service /etc/systemd/system/
sudo cp pi/systemd/triage-brain.service /etc/systemd/system/
sudo cp pi/systemd/triage-dashboard-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable triage-camera-brain
sudo systemctl enable triage-dashboard-server
sudo systemctl enable triage-brain
sudo systemctl enable triage-dashboard-kiosk
```

## 8. Start services

```bash
sudo systemctl restart triage-camera-brain
sudo systemctl restart triage-dashboard-server
sudo systemctl restart triage-brain
sudo systemctl restart triage-dashboard-kiosk
```

## 9. Verify hardware

Check camera:

```bash
curl http://localhost:8085/health
```

Check dashboard server:

```bash
curl http://localhost:3000/api/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Say hello as Triage in one sentence."}'
```

Check local offline STT:

```bash
curl http://localhost:3000/api/stt \
  -H "Content-Type: application/json" \
  -d '{"audio":"BASE64_WAV_GOES_HERE"}'
```

Check Arduino:

```bash
ls /dev/ttyUSB*
sudo systemctl status triage-brain --no-pager
```

Check all services:

```bash
sudo systemctl status triage-camera-brain --no-pager
sudo systemctl status triage-dashboard-server --no-pager
sudo systemctl status triage-dashboard-kiosk --no-pager
sudo systemctl status triage-brain --no-pager
```

## 10. Chromium microphone and camera permissions

On first launch in Chromium:

- allow microphone
- allow camera
- confirm the webcam microphone is the active input device

If needed, test in Chromium at:

- `http://localhost:3000/dashboard`

## 11. Full end-to-end test

1. Reboot the Brain Pi.
2. Wait for Chromium to open `http://localhost:3000/dashboard`.
3. Confirm live video appears.
4. Speak clearly near the webcam microphone.
5. Confirm transcript appears in the dashboard.
6. Confirm Gemma 4 returns an answer.
7. Confirm the browser speaks the answer through the Pi audio output.
8. Test robot controls and `End Trip`.

## 12. Logs if something fails

```bash
journalctl -u triage-camera-brain -n 100 --no-pager
journalctl -u triage-dashboard-server -n 100 --no-pager
journalctl -u triage-dashboard-kiosk -n 100 --no-pager
journalctl -u triage-brain -n 100 --no-pager
```

## Notes

- Browser STT capture is hardware-direct and the transcription runs locally via `whisper.cpp`.
- `camera.py` runs on the Brain Pi for lowest possible dashboard latency.
- `/api/ask` and `/api/stt` are served locally by `serve_dashboard.py`.
