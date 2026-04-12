"""
TRIAGE Robot — Arduino Serial Bridge

Communicates with the Arduino over USB serial (/dev/ttyACM0).
Sends JSON commands, receives telemetry and acknowledgments.

Usage:
    from bridge import ArduinoBridge

    bridge = ArduinoBridge()
    bridge.connect()
    bridge.set_command_mode()       # Switch from line-follow to Pi control
    bridge.move(200, 200)           # Both motors forward at speed 200
    bridge.stop()                   # Emergency stop
    telemetry = bridge.read_telemetry()  # {"ir_l": 0, "ir_r": 1, "mode": "COMMAND"}
    bridge.set_line_follow_mode()   # Hand control back to line-follower
    bridge.disconnect()
"""

import json
import time
import threading
import logging
from typing import Optional, Callable

import serial

logger = logging.getLogger(__name__)

DEFAULT_PORT = "/dev/ttyACM0"
DEFAULT_BAUD = 115200
RECONNECT_DELAY = 2.0
HEARTBEAT_INTERVAL = 1.0
HEARTBEAT_TIMEOUT = 3.0


class ArduinoBridge:
    """Thread-safe serial bridge to the TRIAGE Arduino firmware."""

    def __init__(
        self,
        port: str = DEFAULT_PORT,
        baud: int = DEFAULT_BAUD,
        on_telemetry: Optional[Callable[[dict], None]] = None,
    ):
        self.port = port
        self.baud = baud
        self.on_telemetry = on_telemetry

        self._serial: Optional[serial.Serial] = None
        self._lock = threading.Lock()
        self._reader_thread: Optional[threading.Thread] = None
        self._running = False
        self._last_telemetry: dict = {}
        self._last_heartbeat: float = 0.0
        self._connected = False

    # ── Connection ──────────────────────────────────────────

    def connect(self, timeout: float = 5.0) -> bool:
        """Open serial port and start the reader thread."""
        try:
            self._serial = serial.Serial(
                port=self.port,
                baudrate=self.baud,
                timeout=1.0,
                write_timeout=1.0,
            )
            # Wait for Arduino reset after serial open
            time.sleep(2.0)
            self._serial.reset_input_buffer()

            self._running = True
            self._connected = True
            self._reader_thread = threading.Thread(
                target=self._reader_loop, daemon=True, name="arduino-reader"
            )
            self._reader_thread.start()

            # Read the boot message
            time.sleep(0.5)
            logger.info("Connected to Arduino on %s @ %d baud", self.port, self.baud)
            return True

        except serial.SerialException as e:
            logger.error("Failed to connect to Arduino: %s", e)
            self._connected = False
            return False

    def disconnect(self):
        """Stop reader thread and close serial port."""
        self._running = False
        if self._reader_thread and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=2.0)
        if self._serial and self._serial.is_open:
            try:
                self._send_json({"cmd": "STOP"})
            except Exception:
                pass
            self._serial.close()
        self._connected = False
        logger.info("Disconnected from Arduino")

    @property
    def is_connected(self) -> bool:
        return self._connected and self._serial is not None and self._serial.is_open

    # ── Commands ────────────────────────────────────────────

    def set_command_mode(self) -> bool:
        """Switch Arduino to COMMAND mode (Pi controls motors)."""
        return self._send_json({"cmd": "MODE", "mode": "COMMAND"})

    def set_line_follow_mode(self) -> bool:
        """Switch Arduino back to LINE_FOLLOW mode."""
        return self._send_json({"cmd": "MODE", "mode": "LINE"})

    def move(self, left: int, right: int) -> bool:
        """
        Set motor speeds.
        left/right: -255 to 255. Positive = forward, negative = reverse.
        """
        left = max(-255, min(255, int(left)))
        right = max(-255, min(255, int(right)))
        return self._send_json({"cmd": "MOVE", "L": left, "R": right})

    def stop(self) -> bool:
        """Emergency stop — kills both motors immediately."""
        return self._send_json({"cmd": "STOP"})

    def ping(self) -> bool:
        """Send heartbeat ping. Arduino replies with PONG."""
        return self._send_json({"cmd": "PING"})

    def request_sensors(self) -> bool:
        """Request an immediate sensor telemetry reading."""
        return self._send_json({"cmd": "SENSOR"})

    # ── Telemetry ───────────────────────────────────────────

    @property
    def telemetry(self) -> dict:
        """Latest telemetry from Arduino."""
        return self._last_telemetry.copy()

    def read_telemetry(self) -> dict:
        """Alias for telemetry property."""
        return self.telemetry

    # ── Internal ────────────────────────────────────────────

    def _send_json(self, obj: dict) -> bool:
        """Send a JSON command to Arduino. Thread-safe."""
        if not self.is_connected:
            logger.warning("Cannot send — not connected")
            return False

        line = json.dumps(obj, separators=(",", ":")) + "\n"
        with self._lock:
            try:
                self._serial.write(line.encode("utf-8"))
                self._serial.flush()
                return True
            except serial.SerialException as e:
                logger.error("Serial write error: %s", e)
                self._connected = False
                return False

    def _reader_loop(self):
        """Background thread: reads lines from Arduino, parses JSON."""
        while self._running:
            if not self._serial or not self._serial.is_open:
                time.sleep(RECONNECT_DELAY)
                continue

            try:
                raw = self._serial.readline()
                if not raw:
                    continue

                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("Non-JSON from Arduino: %s", line)
                    continue

                # Update telemetry if it contains sensor data
                if "ir_l" in data:
                    self._last_telemetry = data
                    self._last_heartbeat = time.time()
                    if self.on_telemetry:
                        try:
                            self.on_telemetry(data)
                        except Exception as e:
                            logger.error("Telemetry callback error: %s", e)

                # Log acks and errors
                if "ack" in data:
                    logger.debug("Arduino ACK: %s", data["ack"])
                    self._last_heartbeat = time.time()
                if "error" in data:
                    logger.warning("Arduino error: %s", data)
                if "status" in data:
                    logger.info("Arduino status: %s", data)
                    self._last_heartbeat = time.time()

            except serial.SerialException as e:
                logger.error("Serial read error: %s", e)
                self._connected = False
                time.sleep(RECONNECT_DELAY)
            except Exception as e:
                logger.error("Reader loop error: %s", e)
                time.sleep(0.1)

    def check_heartbeat(self) -> bool:
        """Returns True if Arduino responded within HEARTBEAT_TIMEOUT."""
        if self._last_heartbeat == 0:
            return False
        return (time.time() - self._last_heartbeat) < HEARTBEAT_TIMEOUT


# ── Standalone test ─────────────────────────────────────────
if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(levelname)s %(message)s")

    def on_telem(data):
        print(f"  Telemetry: {data}")

    bridge = ArduinoBridge(on_telemetry=on_telem)

    if not bridge.connect():
        print("ERROR: Could not connect. Check cable and port.")
        exit(1)

    print("\n--- Switching to COMMAND mode ---")
    bridge.set_command_mode()
    time.sleep(1)

    print("--- Requesting sensors ---")
    bridge.request_sensors()
    time.sleep(0.5)

    print("--- Ping ---")
    bridge.ping()
    time.sleep(0.5)

    print(f"--- Latest telemetry: {bridge.telemetry} ---")

    print("--- Moving forward (speed 150) for 2 seconds ---")
    bridge.move(150, 150)
    time.sleep(2)

    print("--- Stopping ---")
    bridge.stop()
    time.sleep(0.5)

    print("--- Switching back to LINE_FOLLOW mode ---")
    bridge.set_line_follow_mode()
    time.sleep(0.5)

    bridge.disconnect()
    print("Done.")
