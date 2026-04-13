# Brain Pi Setup

This setup assumes:

- the webcam is plugged into the Brain Pi
- camera video stays on the Brain Pi
- speech-to-text runs on your PC and sends transcript text to the Brain Pi
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

Check transcript relay:

```bash
curl http://localhost:3000/api/transcript \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello Triage, tell me about this place.","source":"manual-test"}'
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

## 11. PC transcript sender test

From your PC:

```bash
python pc/send_transcript.py --pi http://TRIAGE_PI_IP:3000 "Hello Triage, what can I see here?"
```

The Brain Pi dashboard should:

- switch to `Thinking...`
- send the text to local `/api/ask`
- show the answer on screen
- speak the answer on the Pi speakers

## 12. Full end-to-end test

1. Reboot the Brain Pi.
2. Wait for Chromium to open `http://localhost:3000/dashboard`.
3. Confirm live video appears.
4. From your PC, send a test transcript to the Pi.
5. Confirm the transcript appears in the dashboard.
6. Confirm Gemma 4 returns an answer.
7. Confirm the browser speaks the answer through the Pi audio output.
8. Test robot controls and `End Trip`.

## 13. Logs if something fails

```bash
journalctl -u triage-camera-brain -n 100 --no-pager
journalctl -u triage-dashboard-server -n 100 --no-pager
journalctl -u triage-dashboard-kiosk -n 100 --no-pager
journalctl -u triage-brain -n 100 --no-pager
```

## Notes

- `camera.py` runs on the Brain Pi for lowest possible dashboard latency.
- `/api/ask` and `/api/transcript` are served locally by `serve_dashboard.py`.
- Your PC can use any STT tool you like as long as it sends plain text to `POST /api/transcript`.
- See [PC_STT_SETUP.md](/C:/Users/roben/Downloads/TRIAGE/PC_STT_SETUP.md) for the always-listening Windows/PC microphone relay setup.
