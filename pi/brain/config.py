"""
TRIAGE Robot — Brain Pi Configuration

All tunable parameters in one place.
"""

# ── Serial ──────────────────────────────────────────────────
ARDUINO_PORT = "/dev/ttyUSB0"
ARDUINO_BAUD = 115200

# ── Camera (Face Pi LAN stream) ────────────────────────────
FACE_PI_CAMERA_URL = "http://localhost:8085/frame"
CAMERA_FRAME_WIDTH = 640
CAMERA_FRAME_HEIGHT = 480

# ── Vercel API ──────────────────────────────────────────────
VERCEL_BASE_URL = "https://triage-ashy.vercel.app"
VERCEL_CAMERA_FEED_URL = f"{VERCEL_BASE_URL}/api/camera-feed"
VERCEL_ROBOT_STATE_URL = f"{VERCEL_BASE_URL}/api/robot-state"
VERCEL_ROBOT_COMMAND_URL = f"{VERCEL_BASE_URL}/api/robot-command"
VERCEL_ASK_URL = f"{VERCEL_BASE_URL}/api/ask"

# ── Navigation PID ──────────────────────────────────────────
NAV_KP = 0.5       # Proportional gain
NAV_KI = 0.0       # Integral gain
NAV_KD = 0.1       # Derivative gain
NAV_BASE_SPEED = 180
NAV_MAX_SPEED = 255

# ── Target Following PID ───────────────────────────────────
FOLLOW_KP = 0.4
FOLLOW_KI = 0.0
FOLLOW_KD = 0.15
FOLLOW_BASE_SPEED = 150
FOLLOW_TARGET_AREA = 0.08  # Target bounding box area as fraction of frame
FOLLOW_DEADZONE = 30       # Pixels from center before steering correction

# ── Telemetry ──────────────────────────────────────────────
TELEMETRY_PUSH_INTERVAL = 0.5    # seconds, push state to Vercel
COMMAND_POLL_INTERVAL = 0.5      # seconds, poll commands from Vercel
HEARTBEAT_TIMEOUT = 3.0          # seconds, Arduino watchdog

# ── ArUco POI Map ──────────────────────────────────────────
# marker_id → { name, prompt } — extend as needed
POI_MAP = {
    0: {
        "name": "Welcome Point",
        "prompt": "You are at the welcome entrance. Greet the tourist warmly and describe what they will see on this tour of Albania.",
    },
    1: {
        "name": "Historical Landmark",
        "prompt": "Describe this Albanian historical landmark for a tourist. Be engaging and informative, under 3 sentences.",
    },
    2: {
        "name": "Cultural Site",
        "prompt": "Describe this Albanian cultural site for a tourist. Highlight what makes it unique, under 3 sentences.",
    },
}

# ── Collision Avoidance ────────────────────────────────────
COLLISION_DANGER_THRESHOLD = 0.55     # bbox height ratio → EMERGENCY STOP
COLLISION_CAUTION_THRESHOLD = 0.35    # bbox height ratio → SLOW DOWN 50%
COLLISION_PATH_WIDTH = 0.4            # center 40% of frame is "in path"
COLLISION_MIN_CONFIDENCE = 0.4

# ── Phone Link (AirTag-like beacon) ───────────────────────
PHONE_LINK_POLL_INTERVAL = 3.0       # seconds, poll Vercel for phone status
PHONE_LOST_TIMEOUT = 15.0            # seconds without heartbeat → pause robot

# ── BLE Proximity (optional, requires bleak) ──────────────
BLE_ENABLED = False                   # Set True when bleak is installed on Pi
BLE_SCAN_INTERVAL = 2.0
BLE_SCAN_DURATION = 1.5
