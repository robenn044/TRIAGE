"""
TRIAGE Robot — Brain Daemon (Main Orchestrator)

This is the main process running on the Brain Pi (8GB).
It ties together:
  - ArduinoBridge (serial motor control)
  - NavigationEngine (vision-based path following)
  - TargetTracker (YOLOv8n person following)
  - RobotFSM (state machine)
  - Vercel API communication (state push, command poll, AI narration)

Usage:
    python robot_brain.py

Runs as a systemd service on the Brain Pi.
"""

import asyncio
import base64
import json
import logging
import signal
import sys
import time
from typing import Optional

import cv2
import httpx
import numpy as np

from bridge import ArduinoBridge
from config import (
    ARDUINO_PORT,
    ARDUINO_BAUD,
    FACE_PI_CAMERA_URL,
    VERCEL_ASK_URL,
    VERCEL_ROBOT_COMMAND_URL,
    VERCEL_ROBOT_STATE_URL,
    NAV_KP, NAV_KI, NAV_KD,
    NAV_BASE_SPEED, NAV_MAX_SPEED,
    FOLLOW_KP, FOLLOW_KI, FOLLOW_KD,
    FOLLOW_BASE_SPEED, FOLLOW_TARGET_AREA, FOLLOW_DEADZONE,
    TELEMETRY_PUSH_INTERVAL,
    COMMAND_POLL_INTERVAL,
    HEARTBEAT_TIMEOUT,
    POI_MAP,
    COLLISION_DANGER_THRESHOLD,
    COLLISION_CAUTION_THRESHOLD,
    COLLISION_PATH_WIDTH,
    COLLISION_MIN_CONFIDENCE,
    PHONE_LINK_POLL_INTERVAL,
    PHONE_LOST_TIMEOUT,
    BLE_ENABLED,
    BLE_SCAN_INTERVAL,
    BLE_SCAN_DURATION,
    VERCEL_BASE_URL,
)
from collision import CollisionGuard, SafetyLevel
from navigation import NavigationEngine
from state_machine import RobotFSM
from tracker import TargetTracker
from ble_scanner import BLEScanner

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [brain] %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


class RobotBrain:
    """Main orchestrator for the TRIAGE tourist guide robot."""

    def __init__(self):
        # Hardware
        self.bridge = ArduinoBridge(
            port=ARDUINO_PORT,
            baud=ARDUINO_BAUD,
            on_telemetry=self._on_telemetry,
        )

        # Vision
        self.nav = NavigationEngine(
            kp=NAV_KP, ki=NAV_KI, kd=NAV_KD,
            base_speed=NAV_BASE_SPEED, max_speed=NAV_MAX_SPEED,
        )

        # Tracker (lazy-loaded)
        self.tracker = TargetTracker(
            kp=FOLLOW_KP, ki=FOLLOW_KI, kd=FOLLOW_KD,
            target_area_fraction=FOLLOW_TARGET_AREA,
            deadzone_px=FOLLOW_DEADZONE,
        )

        # Collision avoidance (vision-based — replaces ultrasonic)
        self.collision = CollisionGuard(
            danger_threshold=COLLISION_DANGER_THRESHOLD,
            caution_threshold=COLLISION_CAUTION_THRESHOLD,
            path_width_fraction=COLLISION_PATH_WIDTH,
            min_confidence=COLLISION_MIN_CONFIDENCE,
        )

        # BLE proximity scanner (optional AirTag-like tracking)
        self.ble = BLEScanner(
            scan_interval=BLE_SCAN_INTERVAL,
            scan_duration=BLE_SCAN_DURATION,
        )

        # State machine
        self.fsm = RobotFSM()

        # Runtime state
        self._running = False
        self._latest_frame: Optional[np.ndarray] = None
        self._latest_narration: Optional[str] = None
        self._current_poi: Optional[str] = None
        self._last_poi_id: Optional[int] = None  # Avoid re-narrating same POI
        self._speed_l = 0
        self._speed_r = 0
        self._safety_level = "CLEAR"
        self._phone_paired = False
        self._phone_lost_since: Optional[float] = None
        self._ai_mode = False  # True = COMMAND mode, False = LINE_FOLLOW

    # ── Lifecycle ───────────────────────────────────────────

    async def start(self):
        """Start the robot brain."""
        logger.info("Starting TRIAGE Robot Brain...")

        # Connect to Arduino (stays in LINE_FOLLOW until phone pairs)
        if not self.bridge.connect():
            logger.error("Failed to connect to Arduino. Check USB cable.")
            sys.exit(1)

        # Keep Arduino in LINE_FOLLOW mode by default.
        # When a phone pairs, we switch to COMMAND mode for full AI control.
        self.bridge.set_line_follow_mode()
        self._ai_mode = False

        self._running = True
        logger.info("Brain started in LINE_FOLLOW mode. Waiting for phone to pair...")

        async with httpx.AsyncClient(timeout=10.0) as client:
            self._client = client

            # Run concurrent tasks
            tasks = [
                self._main_loop(),
                self._command_poll_loop(),
                self._state_push_loop(),
                self._heartbeat_loop(),
                self._phone_link_loop(),
            ]
            # Add BLE scanner if enabled
            if BLE_ENABLED:
                tasks.append(self.ble.start())
                logger.info("BLE proximity scanner enabled")

            await asyncio.gather(*tasks)

    async def stop(self):
        """Gracefully shut down."""
        logger.info("Shutting down brain...")
        self._running = False
        self.bridge.stop()
        self.bridge.set_line_follow_mode()
        self.bridge.disconnect()
        await self.ble.stop()

    # ── Main Loop ──────────────────────────────────────────

    async def _main_loop(self):
        """Core loop: fetch frame, process based on current state.
        Only active when phone is paired (AI/COMMAND mode)."""
        while self._running:
            try:
                # In LINE_FOLLOW mode, Arduino handles everything autonomously
                if not self._ai_mode:
                    await asyncio.sleep(0.5)
                    continue

                state = self.fsm.state

                if state == "IDLE":
                    await asyncio.sleep(0.5)
                    continue

                # Fetch frame from Face Pi
                frame = await self._fetch_frame()
                if frame is None:
                    await asyncio.sleep(0.1)
                    continue

                self._latest_frame = frame

                if state == "TOURING":
                    await self._handle_touring(frame)
                elif state == "AT_POI":
                    await self._handle_at_poi(frame)
                elif state == "FOLLOWING":
                    await self._handle_following(frame)
                elif state == "END_TRIP":
                    await self._handle_end_trip()

                # ~15 FPS processing rate
                await asyncio.sleep(0.066)

            except Exception as e:
                logger.error("Main loop error: %s", e, exc_info=True)
                self.bridge.stop()
                await asyncio.sleep(1.0)

    # ── State Handlers ─────────────────────────────────────

    async def _handle_touring(self, frame: np.ndarray):
        """Navigate along the path, detect POIs — with collision avoidance."""
        result = self.nav.process_frame(frame)

        # ── Collision check (runs on every frame) ──
        safety = self._check_collision_from_nav(frame)
        if safety == SafetyLevel.DANGER:
            self.bridge.stop()
            self._speed_l = 0
            self._speed_r = 0
            logger.warning("COLLISION DANGER — emergency stop during touring")
            return

        # Check for ArUco POI
        if result.aruco_id is not None and result.aruco_distance < 50:
            if result.aruco_id != self._last_poi_id:
                poi_info = POI_MAP.get(result.aruco_id)
                if poi_info:
                    self._current_poi = poi_info["name"]
                    self._last_poi_id = result.aruco_id
                    self.bridge.stop()
                    self.fsm.arrive_poi(poi_name=poi_info["name"])
                    return

        # Follow the path (with speed reduction if CAUTION)
        speed_mult = 0.5 if safety == SafetyLevel.CAUTION else 1.0

        if result.path_detected:
            left, right = self.nav.steering_to_motors(result.steering)
            left = int(left * speed_mult)
            right = int(right * speed_mult)
            self.bridge.move(left, right)
            self._speed_l = left
            self._speed_r = right
        else:
            base = int(100 * speed_mult)
            self.bridge.move(base, base)
            self._speed_l = base
            self._speed_r = base

    async def _handle_at_poi(self, frame: np.ndarray):
        """At a POI: trigger AI narration, then leave."""
        self.bridge.stop()
        self._speed_l = 0
        self._speed_r = 0

        aruco_id = self._last_poi_id
        poi_info = POI_MAP.get(aruco_id, {})
        prompt = poi_info.get("prompt", "Describe what you see for a tourist.")

        # Get AI narration
        narration = await self._get_ai_narration(frame, prompt)
        if narration:
            self._latest_narration = narration
            logger.info("Narration for POI %s: %s", poi_info.get("name"), narration[:100])

            # TODO: Play via Piper TTS when audio is set up
            # For now, narration is sent to dashboard via state push

        # Wait for tourist to absorb, then continue
        await asyncio.sleep(8.0)

        if self.fsm.state == "AT_POI":
            self.fsm.leave_poi()

    async def _handle_following(self, frame: np.ndarray):
        """Follow the locked target — with collision avoidance."""
        result = self.tracker.update(frame)

        if not result.target_found:
            # Lost target — slow stop
            self.bridge.move(80, 80)  # Creep forward hoping to re-acquire
            self._speed_l = 80
            self._speed_r = 80
            return

        # Tell collision guard to ignore the tracked person
        self.collision.set_ignore_target(result.target_id)

        # ── Collision check (don't crash into OTHER obstacles) ──
        safety = self._check_collision_from_nav(frame)
        if safety == SafetyLevel.DANGER:
            self.bridge.stop()
            self._speed_l = 0
            self._speed_r = 0
            logger.warning("COLLISION DANGER — emergency stop during following")
            return

        speed_mult = 0.5 if safety == SafetyLevel.CAUTION else 1.0

        # ── Don't get too close to the tourist ──
        # If target bbox is huge (> danger threshold), we're too close — stop
        if result.target_bbox:
            _, y1, _, y2 = result.target_bbox
            h = frame.shape[0]
            target_height_ratio = (y2 - y1) / h
            if target_height_ratio > COLLISION_DANGER_THRESHOLD:
                self.bridge.stop()
                self._speed_l = 0
                self._speed_r = 0
                return
            # Slow down when getting close to tourist
            if target_height_ratio > COLLISION_CAUTION_THRESHOLD:
                speed_mult = min(speed_mult, 0.3)

        # Convert steering + throttle to motor speeds
        base = int(FOLLOW_BASE_SPEED * result.throttle * speed_mult)
        left = base + int(result.steering * base)
        right = base - int(result.steering * base)

        left = max(-255, min(255, left))
        right = max(-255, min(255, right))

        self.bridge.move(left, right)
        self._speed_l = left
        self._speed_r = right

    async def _handle_end_trip(self):
        """End trip: stop AI control, revert to line-follow, reset to IDLE."""
        self.bridge.stop()
        self._speed_l = 0
        self._speed_r = 0
        self._current_poi = None
        self._latest_narration = None
        self._last_poi_id = None
        self._phone_paired = False
        self._phone_lost_since = None
        self.tracker.unlock_target()
        self.collision.set_ignore_target(None)
        self.ble.unpair()

        # Revert to LINE_FOLLOW — robot becomes simple line-follower again
        self.bridge.set_line_follow_mode()
        self._ai_mode = False
        logger.info("Reverted to LINE_FOLLOW mode")

        # Reset phone link session on Vercel
        try:
            await self._client.get(f"{VERCEL_BASE_URL}/api/phone-link?action=reset", timeout=3.0)
        except Exception:
            pass

        # Push final state
        await self._push_state()

        # Reset to IDLE
        self.fsm.reset()
        logger.info("Trip ended. Robot is IDLE.")

    # ── Frame Fetching ─────────────────────────────────────

    async def _fetch_frame(self) -> Optional[np.ndarray]:
        """Fetch the latest frame from Face Pi's LAN HTTP server."""
        try:
            resp = await self._client.get(FACE_PI_CAMERA_URL, timeout=2.0)
            if resp.status_code != 200:
                return None

            jpeg_bytes = resp.content
            arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
            frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            return frame

        except httpx.HTTPError as e:
            logger.debug("Frame fetch error: %s", e)
            return None

    # ── AI Narration ───────────────────────────────────────

    async def _get_ai_narration(self, frame: np.ndarray, prompt: str) -> Optional[str]:
        """Send frame + prompt to Vercel /api/ask for AI narration."""
        try:
            _, jpeg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            b64_image = base64.b64encode(jpeg_buf.tobytes()).decode("ascii")

            resp = await self._client.post(
                VERCEL_ASK_URL,
                json={"image": b64_image, "prompt": prompt},
                timeout=15.0,
            )

            if resp.status_code == 200:
                data = resp.json()
                return data.get("answer")
            else:
                logger.warning("AI narration failed: %d", resp.status_code)
                return None

        except Exception as e:
            logger.error("AI narration error: %s", e)
            return None

    # ── Vercel Communication ───────────────────────────────

    async def _command_poll_loop(self):
        """Poll Vercel for dashboard commands."""
        while self._running:
            try:
                resp = await self._client.get(VERCEL_ROBOT_COMMAND_URL, timeout=5.0)
                if resp.status_code == 200:
                    data = resp.json()
                    action = data.get("action")
                    if action:
                        await self._handle_dashboard_command(action)
            except httpx.HTTPError as e:
                logger.debug("Command poll error: %s", e)

            await asyncio.sleep(COMMAND_POLL_INTERVAL)

    async def _handle_dashboard_command(self, action: str):
        """Process a command from the dashboard."""
        logger.info("Dashboard command: %s (current state: %s)", action, self.fsm.state)

        try:
            if action == "start_trip":
                if self.fsm.state == "IDLE":
                    self.fsm.start_trip()

            elif action == "end_trip":
                self.fsm.emergency_stop()

            elif action == "follow_me":
                if self._latest_frame is not None:
                    self.tracker.initialize()
                    if self.tracker.lock_target(self._latest_frame):
                        if self.fsm.state in ("IDLE", "TOURING", "AT_POI"):
                            self.fsm.start_follow()
                    else:
                        logger.warning("Could not lock target — no person detected")

            elif action == "pause":
                self.bridge.stop()
                self._speed_l = 0
                self._speed_r = 0

            elif action == "resume":
                pass  # Main loop will resume movement on next iteration

        except Exception as e:
            logger.error("Error handling command '%s': %s", action, e)

    async def _state_push_loop(self):
        """Push robot state to Vercel at regular intervals."""
        while self._running:
            await self._push_state()
            await asyncio.sleep(TELEMETRY_PUSH_INTERVAL)

    async def _push_state(self):
        """Push current state to Vercel."""
        telemetry = self.bridge.telemetry
        state = {
            "state": self.fsm.state,
            "mode": "COMMAND" if self._ai_mode else "LINE_FOLLOW",
            "ir_l": telemetry.get("ir_l", 0),
            "ir_r": telemetry.get("ir_r", 0),
            "poi": self._current_poi,
            "speed_l": self._speed_l,
            "speed_r": self._speed_r,
            "tracking": self.tracker._locked_track_id is not None,
            "narration": self._latest_narration,
            "safety": self._safety_level,
            "phone_paired": self._phone_paired,
            "ble": self.ble.to_dict() if BLE_ENABLED else None,
        }
        try:
            await self._client.post(VERCEL_ROBOT_STATE_URL, json=state, timeout=5.0)
        except httpx.HTTPError as e:
            logger.debug("State push error: %s", e)

    # ── Safety ─────────────────────────────────────────────

    def _check_collision_from_nav(self, frame: np.ndarray) -> SafetyLevel:
        """
        Quick collision check using the tracker's YOLO model (if loaded)
        or a lightweight pass. Returns the safety level.
        """
        try:
            if self.tracker._initialized and self.tracker._model is not None:
                # Re-use tracker's YOLO model for efficiency
                import supervision as sv
                results = self.tracker._model(frame, verbose=False)
                detections = sv.Detections.from_ultralytics(results[0])
                assessment = self.collision.assess(detections, frame.shape)
            else:
                # No YOLO loaded yet — can't assess, assume clear
                assessment = self.collision.assess(None, frame.shape)

            self._safety_level = assessment.level.value
            if assessment.level == SafetyLevel.DANGER:
                logger.warning("Collision: %s", assessment.reason)
            return assessment.level

        except Exception as e:
            logger.debug("Collision check error: %s", e)
            return SafetyLevel.CLEAR

    async def _phone_link_loop(self):
        """Poll Vercel for phone link status — AirTag-like presence detection.
        Controls mode switching: no phone = LINE_FOLLOW, phone paired = COMMAND."""
        phone_link_url = f"{VERCEL_BASE_URL}/api/phone-link"

        while self._running:
            try:
                resp = await self._client.get(phone_link_url, timeout=5.0)
                if resp.status_code == 200:
                    data = resp.json()
                    was_paired = self._phone_paired
                    self._phone_paired = data.get("paired", False)

                    if self._phone_paired:
                        self._phone_lost_since = None

                        # Phone just connected → switch to AI/COMMAND mode
                        if not was_paired:
                            logger.info("Phone paired! Switching to COMMAND mode.")
                            self.bridge.set_command_mode()
                            self.bridge.stop()
                            self._ai_mode = True

                        # Check for "I'm here" signal
                        if data.get("signal") == "here":
                            logger.info("Phone: tourist sent 'I'm here' signal!")

                    elif was_paired and not self._phone_paired:
                        # Phone just went offline
                        if self._phone_lost_since is None:
                            self._phone_lost_since = time.monotonic()
                            logger.warning("Phone: heartbeat lost — starting timeout")

                    # If phone lost for too long, revert to LINE_FOLLOW
                    if (
                        self._phone_lost_since is not None
                        and (time.monotonic() - self._phone_lost_since) > PHONE_LOST_TIMEOUT
                    ):
                        if self._ai_mode:
                            logger.warning(
                                "Phone lost for >%.0fs — reverting to LINE_FOLLOW",
                                PHONE_LOST_TIMEOUT,
                            )
                            self.bridge.stop()
                            self._speed_l = 0
                            self._speed_r = 0
                            self.bridge.set_line_follow_mode()
                            self._ai_mode = False
                            self.fsm.reset()

            except httpx.HTTPError as e:
                logger.debug("Phone link poll error: %s", e)

            await asyncio.sleep(PHONE_LINK_POLL_INTERVAL)

    async def _heartbeat_loop(self):
        """Monitor Arduino heartbeat. Emergency stop if lost."""
        while self._running:
            self.bridge.ping()

            if not self.bridge.check_heartbeat() and self.fsm.state != "IDLE":
                logger.warning("Arduino heartbeat lost — emergency stop!")
                self.bridge.stop()
                self._speed_l = 0
                self._speed_r = 0

            await asyncio.sleep(HEARTBEAT_TIMEOUT / 2)

    # ── Telemetry Callback ─────────────────────────────────

    def _on_telemetry(self, data: dict):
        """Called by ArduinoBridge reader thread on each telemetry message."""
        pass  # Data is stored in bridge.telemetry, accessed in push loop


# ── Entry Point ────────────────────────────────────────────
async def main():
    brain = RobotBrain()

    loop = asyncio.get_event_loop()

    def shutdown(signum, frame):
        logger.info("Received signal %d, shutting down...", signum)
        loop.create_task(brain.stop())

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    await brain.start()


if __name__ == "__main__":
    asyncio.run(main())
