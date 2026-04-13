# Brain Pi Setup

This setup assumes:

- the webcam is plugged into the Brain Pi
- camera video stays on the Brain Pi
- speech-to-text runs locally on the Brain Pi microphone
- the dashboard opens automatically on boot
- the local dashboard server handles `POST /api/ask` for Gemma 4 or Ollama
- the local dashboard server handles `GET/POST /api/transcript` for transcript relay

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
sudo apt install -y python3 python3-venv python3-pip nodejs npm chromium espeak-ng alsa-utils
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

The dashboard server now prefers `piper` for a more natural offline English voice and falls back to `espeak-ng` if Piper is unavailable. The default Piper voice is `en_US-lessac-medium`.

For a more human-sounding English voice, TRIAGE can also use Kokoro. The preferred Kokoro voice is `af_sarah`.

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

Optional microphone device override if your webcam mic is not auto-detected:

```env
TRIAGE_MIC_DEVICE=plughw:CARD=Camera,DEV=0
```

## 7. Install systemd services

```bash
cd ~/TRIAGE
sudo cp pi/systemd/triage-camera-brain.service /etc/systemd/system/
sudo cp pi/systemd/triage-dashboard-server.service /etc/systemd/system/
sudo cp pi/systemd/triage-mic-brain.service /etc/systemd/system/
sudo cp pi/systemd/triage-brain.service /etc/systemd/system/
sudo cp pi/systemd/triage-dashboard-kiosk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable triage-camera-brain
sudo systemctl enable triage-dashboard-server
sudo systemctl enable triage-mic-brain
sudo systemctl enable triage-brain
sudo systemctl enable triage-dashboard-kiosk
```

## 8. Start services

```bash
sudo systemctl restart triage-camera-brain
sudo systemctl restart triage-dashboard-server
sudo systemctl restart triage-mic-brain
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

Check local TTS:

```bash
curl http://localhost:3000/api/speak \
  -H "Content-Type: application/json" \
  -d '{"text":"This is a Triage speaker test."}'
```

Optional: install Kokoro for a more natural English voice:

```bash
cd ~/TRIAGE/pi/brain
source venv/bin/activate
pip install kokoro-onnx soundfile
deactivate
mkdir -p ~/kokoro-tts
cd ~/kokoro-tts
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -LO https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

Optional Kokoro overrides in `~/TRIAGE/.env.local`:

```env
TRIAGE_TTS_ENGINE=kokoro
TRIAGE_KOKORO_MODEL=/home/admin/kokoro-tts/kokoro-v1.0.onnx
TRIAGE_KOKORO_VOICES=/home/admin/kokoro-tts/voices-v1.0.bin
TRIAGE_KOKORO_VOICE=af_sarah
TRIAGE_KOKORO_LANG=en-us
TRIAGE_KOKORO_SPEED=1.0
```

Download the latest generated response WAV:

```bash
curl http://localhost:3000/api/last-tts.wav -o /tmp/triage-last-response.wav
```

Check local microphone transcriber:

```bash
sudo systemctl status triage-mic-brain --no-pager
journalctl -u triage-mic-brain -n 40 --no-pager
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

## 10. Chromium permissions

On first launch in Chromium:

- allow camera

If needed, test in Chromium at:

- `http://localhost:3000/dashboard`

## 11. Full end-to-end test

1. Reboot the Brain Pi.
2. Wait for Chromium to open `http://localhost:3000/dashboard`.
3. Confirm live video appears.
4. Speak near the webcam microphone connected to the Brain Pi.
5. Confirm the transcript appears in the dashboard.
6. Confirm Gemma 4 returns an answer.
7. Confirm the browser speaks the answer through the Pi audio output.
8. Test robot controls and `End Trip`.

## 12. Logs if something fails

```bash
journalctl -u triage-camera-brain -n 100 --no-pager
journalctl -u triage-dashboard-server -n 100 --no-pager
journalctl -u triage-mic-brain -n 100 --no-pager
journalctl -u triage-dashboard-kiosk -n 100 --no-pager
journalctl -u triage-brain -n 100 --no-pager
```

## Notes

- `camera.py` runs on the Brain Pi for lowest possible dashboard latency.
- `/api/ask`, `/api/speak`, and `/api/transcript` are served locally by `serve_dashboard.py`.
- `mic_transcriber.py` captures the Brain Pi microphone with ALSA, transcribes locally, and posts the final text to `/api/transcript`.
