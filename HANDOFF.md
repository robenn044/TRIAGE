# TRIAGE Robot — Full Project Handoff Document

> **Generated:** 2026-04-12  
> **Repo:** https://github.com/robenn044/TRIAGE  
> **Deployed:** https://triage-ashy.vercel.app  

---

## 1. PROJECT OVERVIEW

TRIAGE is an Arduino-based line-follower robot being upgraded into an autonomous AI-powered tourist guide for Albania. The system uses:

- **2× Raspberry Pi 5** (one for the robot face display + camera, one for the dashboard + AI processing)
- **Arduino Uno** with L298N motor driver and 2 IR sensors
- **USB webcam** on the Face Pi
- **2× screens** (one per Pi)
- **React + Vite + Tailwind** web app deployed on Vercel

---

## 2. HARDWARE ARCHITECTURE

### Face Pi (4GB RAM)
- **Username:** `admin`
- **Hostname:** `triageface`
- **Role:** Robot face kiosk display + USB camera capture + MJPEG streaming
- **Screen:** Shows the robot face in Chromium kiosk mode (https://triage-ashy.vercel.app/)
- **Camera:** USB webcam, streams via MJPEG at 30fps on port 8085
- **Status:** ✅ FULLY SET UP AND RUNNING

### Brain Pi (8GB RAM)
- **Username:** `admin`
- **Hostname:** `triagedashboard`
- **Role:** Dashboard display + Arduino serial control + all AI/vision processing
- **Screen:** Shows the dashboard in Chromium kiosk mode (http://localhost:3000/dashboard)
- **Arduino:** Connected via USB at `/dev/ttyUSB0` (115200 baud)
- **Status:** 🔧 IN PROGRESS — repo cloned, Arduino connected, needs deps + services

### Arduino Uno
- **Serial:** 115200 baud, USB connection to Brain Pi
- **Motor Driver (L298N):** enA=5(PWM), in1=4, in2=7 (left); enB=6(PWM), in3=8, in4=11 (right)
- **IR Sensors:** L_S=12, R_S=13 (LOW=white/line, HIGH=black/no line)
- **Ultrasonic:** TRIG=9, ECHO=10 (DEFINED BUT NOT CONNECTED — returns 999)
- **Power:** Powered from L298N 5V output (NOT from Pi USB — causes undervoltage)
- **Firmware:** Dual-mode (LINE_FOLLOW default + COMMAND mode), flashed and confirmed working
- **Status:** ✅ FLASHED AND WORKING (PING returns `{"pong":true,"mode":"LINE"}`)

### Communication Flow
```
[USB Camera] → [Face Pi] --MJPEG over LAN--> [Brain Pi] --USB Serial--> [Arduino]
                  |                               |
                  |                               |
            [Face Screen]                   [Dashboard Screen]
                  |                               |
                  +------- Vercel APIs -----------+
                           (fallback)
```

---

## 3. COMPLETE FILE INVENTORY

### Arduino Firmware
| File | Purpose |
|------|---------|
| `arduino/command_interpreter/command_interpreter.ino` | Dual-mode firmware: LINE_FOLLOW (autonomous) + COMMAND (AI-controlled). JSON serial protocol. |

### Face Pi Scripts (`pi/face/`)
| File | Purpose |
|------|---------|
| `camera.py` | MJPEG streaming server: `/stream` (30fps), `/frame` (snapshot JPEG), `/health`. Also uploads to Vercel at 2fps as fallback. Port 8085. |
| `requirements.txt` | `opencv-python-headless==4.10.0.84`, `httpx>=0.28.0`, `numpy>=1.26.0` |

### Brain Pi Scripts (`pi/brain/`)
| File | Purpose |
|------|---------|
| `robot_brain.py` | Main daemon. Phone-gated mode switching. Boots in LINE_FOLLOW, switches to COMMAND when phone pairs. Orchestrates all subsystems. |
| `bridge.py` | Thread-safe ArduinoBridge class for serial communication. |
| `navigation.py` | Vision-based navigation: OpenCV path detection + ArUco marker recognition + PID steering. |
| `tracker.py` | YOLOv8n + ByteTrack person following. PID controller to keep target centered. |
| `collision.py` | Vision-based collision avoidance using YOLOv8 bbox height as distance proxy. DANGER >55% → stop, CAUTION >35% → slow. |
| `state_machine.py` | FSM: IDLE → TOURING → AT_POI → FOLLOWING → END_TRIP |
| `ble_scanner.py` | Optional BLE proximity scanner (bleak). Disabled by default. |
| `config.py` | All tunable parameters. **ARDUINO_PORT="/dev/ttyUSB0"**, **FACE_PI_CAMERA_URL="http://triageface.local:8085/frame"** |
| `serve_dashboard.py` | Local HTTP server for Brain Pi. Serves built Vite app on port 3000, proxies `/api/*` to Vercel, injects camera URL into index.html. |
| `requirements.txt` | pyserial, opencv-python-headless, httpx, numpy, ultralytics, transitions, piper-tts, etc. |

### Systemd Services (`pi/systemd/`)
| File | Runs On | Purpose |
|------|---------|---------|
| `triage-camera.service` | Face Pi | Auto-starts camera.py |
| `triage-face-kiosk.service` | Face Pi | Chromium kiosk → robot face |
| `triage-brain.service` | Brain Pi | Auto-starts robot_brain.py |
| `triage-dashboard-server.service` | Brain Pi | Auto-starts serve_dashboard.py (port 3000) |
| `triage-dashboard-kiosk.service` | Brain Pi | Chromium kiosk → localhost:3000/dashboard |

### Vercel Serverless APIs (`api/`)
| File | Endpoint | Purpose |
|------|----------|---------|
| `ask.ts` | POST `/api/ask` | Dual-provider AI: PC Ollama (primary) + Google AI Studio (fallback). Gemma 4 model. |
| `camera-feed.ts` | GET/POST `/api/camera-feed` | Camera frame relay. POST from Face Pi, GET from dashboard. Fallback for remote access. |
| `robot-command.ts` | GET/POST `/api/robot-command` | Command queue. Dashboard POSTs commands, Brain Pi GETs them. |
| `robot-state.ts` | GET/POST `/api/robot-state` | Robot state relay. Includes mode, safety status, phone_paired fields. |
| `phone-link.ts` | GET/POST `/api/phone-link` | Phone heartbeat/pairing. QR code pairing flow. |

### React Components (`src/components/`)
| File | Purpose |
|------|---------|
| `CameraAskAI.tsx` | **THE MAIN DASHBOARD COMPONENT** (~600 lines). Camera feed (MJPEG or Vercel), voice AI, speech synthesis, robot controls sidebar. |
| `RobotControls.tsx` | Sidebar: state badge, mode indicator, 4 direction buttons, QR phone pairing, "Connect Phone" button. |
| `EndTripButton.tsx` | Sends end_trip command → stops motors, disconnects tracking, resets to LINE_FOLLOW. |
| `CameraFeed.tsx` | Older camera component (may be unused, superseded by CameraAskAI). |
| `RobotStateBar.tsx` | FSM state display bar. |
| `ControlPanel.tsx` | Control buttons (may be superseded by RobotControls). |
| `QRPairing.tsx` | QR code display for phone pairing. |
| `RobotFace.tsx` | Animated robot face shown on Face Pi screen. |

### React Pages (`src/pages/`)
| File | Route | Purpose |
|------|-------|---------|
| `Index.tsx` | `/` | Landing page |
| `Itinerary.tsx` | `/itinerary` | Tour itinerary |
| `Maps.tsx` | `/maps` | Maps view |
| `PhoneLink.tsx` | `/link` | Phone companion page with heartbeat |
| `RobotDashboard.tsx` | UNUSED | Was `/robot`, removed per user request. **ALL robot controls are on /dashboard in CameraAskAI.tsx** |

---

## 4. KEY DESIGN DECISIONS

### Phone-Gated Mode Switching (CRITICAL)
- **Boot** → Arduino in LINE_FOLLOW mode (autonomous line following, no AI needed)
- **Phone pairs via QR** → `robot_brain.py` sends `MODE COMMAND` → full AI control enabled
- **Phone disconnects (>15s heartbeat timeout) or trip ends** → revert to LINE_FOLLOW
- Dashboard shows "Line Mode" badge and disables AI controls when no phone connected

### No Separate Robot Route
- **User explicitly demanded** all robot controls be on `/dashboard`, NOT a separate `/robot` route
- Everything is embedded in `CameraAskAI.tsx` with `RobotControls` in the sidebar
- The `/robot` route was removed from `App.tsx`

### MJPEG Streaming (LAN) + Vercel Fallback
- On LAN: `<img src="http://triageface.local:8085/stream">` → 30fps native browser rendering
- Remote: Polls `/api/camera-feed` from Vercel at ~5fps (slow but works anywhere)
- `serve_dashboard.py` injects `window.__TRIAGE_CAMERA_URL` into dist/index.html at runtime
- When using MJPEG, AI snapshot requests fetch `/frame` endpoint for base64

### AI Configuration
- **Dual provider:** PC running Ollama (primary, free) + Google AI Studio (fallback, free tier 15 RPM)
- **Model:** Gemma 4 (gemma4 on Ollama, gemma-4-26b-a4b-it on Google AI Studio)
- **Vercel env vars:** `GEMINI_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `GEMINI_MODEL`

### Collision Avoidance (No Ultrasonic)
- Uses YOLOv8 bounding box height/frame height ratio as distance proxy
- DANGER: >55% frame height → emergency stop
- CAUTION: >35% → speed reduced 50%
- Only considers objects in center 40% of frame ("in path")

---

## 5. CURRENT STATUS

### ✅ Completed
- Arduino firmware flashed and confirmed working (PING, LINE_FOLLOW mode)
- Face Pi fully set up:
  - camera.py running as systemd service (MJPEG 30fps on port 8085) ✅
  - Face kiosk Chromium running (shows robot face) ✅
  - Both auto-start on boot ✅
- Vercel deployment working (env vars set: GEMINI_API_KEY)
- All code committed and pushed to GitHub
- Dashboard shows camera feed (MJPEG on LAN, Vercel fallback)

### ✅ Brain Pi Setup — COMPLETE
- Node.js 20 installed
- Dashboard built (`npm run build`) — dist/ ready
- Python venv created, pyserial/httpx/opencv/numpy installed
- Arduino confirmed at `/dev/ttyUSB0`, PING returns `{"status":"ready","mode":"LINE","fw":"triage-1.0"}`
- All 3 systemd services installed, enabled, and running:
  - `triage-dashboard-server` — serves dashboard on port 3000 ✅
  - `triage-dashboard-kiosk` — Chromium kiosk on Brain Pi screen ✅
  - `triage-brain` — robot brain daemon ✅
- Dashboard showing on Brain Pi screen with camera feed from Face Pi ✅

**NOTE:** Arduino serial port is `/dev/ttyUSB0` (NOT `/dev/ttyACM0`). Already fixed in `config.py`.

**NOTE:** When writing Python test scripts on the Pi via terminal, use `printf` to create files — nano auto-indent and heredoc both cause IndentationError. Example:
```bash
printf 'import serial, json, time\ns = serial.Serial("/dev/ttyUSB0", 115200, timeout=2)\n...\n' > ~/test.py && python3 ~/test.py
```

### ⏳ Next — End-to-End Test
After both Pis reboot, verify auto-start works, then:
1. Open phone browser → scan QR code on dashboard → phone pairs
2. Robot switches from LINE_FOLLOW to COMMAND mode
3. Test AI: tap mic button, ask robot what it sees
4. Test motor controls from dashboard (F/B/L/R buttons)
5. Press "End Trip" → robot reverts to LINE_FOLLOW

---

## 6. ARDUINO SERIAL PROTOCOL

The Arduino accepts JSON commands over serial at 115200 baud:

```json
// Always works (any mode):
{"cmd":"PING"}                    → {"pong":true,"mode":"LINE"}
{"cmd":"SENSOR"}                  → {"left":0,"right":1,"dist":999}

// Switch modes:
{"cmd":"MODE","mode":"COMMAND"}   → {"status":"ready","mode":"COMMAND"}
{"cmd":"MODE","mode":"LINE"}      → {"status":"ready","mode":"LINE"}

// Only in COMMAND mode:
{"cmd":"MOVE","left":200,"right":200}  → {"ok":true}
{"cmd":"MOVE","left":-150,"right":150} → {"ok":true}  (negative = reverse)
{"cmd":"STOP"}                         → {"stopped":true}

// In LINE mode:
// Arduino autonomously follows line using IR sensors
// No MOVE/STOP commands accepted
```

**GOTCHA:** Arduino pins 0/1 are shared with USB serial. Disconnect any GPIO wires on pins 0/1 when uploading new sketches via Arduino IDE.

---

## 7. ENVIRONMENT VARIABLES

### Vercel (already set):
- `GEMINI_API_KEY` — Google AI Studio API key for Gemma 4

### Optional (not yet set):
- `OLLAMA_BASE_URL` — URL of PC running Ollama (e.g., `http://192.168.1.100:11434`)
- `OLLAMA_MODEL` — Ollama model name (default: `gemma4`)
- `GEMINI_MODEL` — Google AI Studio model (default: `gemma-4-26b-a4b-it`)

### Build-time (Vite):
- `VITE_CAMERA_STREAM_URL` — MJPEG stream URL (optional, `serve_dashboard.py` injects at runtime)

---

## 8. KNOWN GOTCHAS & ISSUES

1. **Brain Pi undervoltage** — `dmesg` shows undervoltage warnings. Use official 5V/5A supply. Arduino must be powered from L298N 5V, NOT from Pi USB.

2. **Serial port is `/dev/ttyUSB0`** not `/dev/ttyACM0` — already updated in `config.py`.

3. **Chromium binary is `chromium`** not `chromium-browser` on these Pis — already fixed in systemd services.

4. **graphical.target** not `graphical-session.target` — already fixed in systemd services.

5. **Vercel in-memory state resets on cold starts** — `robot-state.ts` and `robot-command.ts` use module-level variables that reset when Vercel spins down the function. Not critical (Brain Pi re-pushes state regularly).

6. **Mixed content blocking** — If dashboard is served from HTTPS (Vercel), it can't load HTTP MJPEG stream. That's why `serve_dashboard.py` serves locally on HTTP. When accessing from Vercel directly, falls back to polling `/api/camera-feed`.

7. **YOLOv8n on Pi 5** — Should be exported to NCNN format for ARM performance: `yolo export model=yolov8n.pt format=ncnn`

---

## 9. NETWORK TOPOLOGY

```
Home WiFi Network:
├── Face Pi (triageface.local)
│   ├── :8085/stream  — MJPEG camera feed
│   ├── :8085/frame   — Single JPEG snapshot
│   └── :8085/health  — Health check
│
├── Brain Pi (triagedashboard.local)
│   ├── :3000         — Local dashboard (serve_dashboard.py)
│   ├── USB /dev/ttyUSB0 → Arduino Uno
│   └── Proxies /api/* → triage-ashy.vercel.app
│
└── Vercel (triage-ashy.vercel.app)
    ├── /             — Robot face (loaded by Face Pi kiosk)
    ├── /dashboard    — Dashboard (fallback, also served locally)
    ├── /link         — Phone companion page
    ├── /api/ask      — AI endpoint
    ├── /api/camera-feed    — Camera frame relay (fallback)
    ├── /api/robot-state    — Robot state
    ├── /api/robot-command  — Command queue
    └── /api/phone-link     — Phone pairing
```

---

## 10. QUICK REFERENCE COMMANDS

### Face Pi (SSH: `ssh admin@triageface.local`)
```bash
# Check camera service
sudo systemctl status triage-camera.service
sudo journalctl -u triage-camera.service -f

# Check face kiosk
sudo systemctl status triage-face-kiosk.service

# Restart camera
sudo systemctl restart triage-camera.service

# Test camera in browser
# http://triageface.local:8085/stream
```

### Brain Pi (SSH: `ssh admin@triagedashboard.local`)
```bash
# Check all services
sudo systemctl status triage-brain.service
sudo systemctl status triage-dashboard-server.service
sudo systemctl status triage-dashboard-kiosk.service

# View brain logs
sudo journalctl -u triage-brain.service -f

# Test Arduino manually
cd ~/TRIAGE/pi/brain && source venv/bin/activate
python3 -c "import serial,json,time;s=serial.Serial('/dev/ttyUSB0',115200,timeout=2);time.sleep(2);s.write(json.dumps({'cmd':'PING'}).encode()+b'\\n');time.sleep(0.5);print(s.readline().decode().strip());s.close()"

# Rebuild dashboard after code changes
cd ~/TRIAGE && git pull && npm install && npm run build
sudo systemctl restart triage-dashboard-server.service
```

### Arduino (via Arduino IDE on PC)
```
Board: Arduino Uno
Port: (whatever shows up)
Sketch: arduino/command_interpreter/command_interpreter.ino
Baud: 115200
IMPORTANT: Disconnect GPIO wires from pins 0/1 before uploading
```
