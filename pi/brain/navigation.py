"""
TRIAGE Robot — Vision Navigation Engine

Processes camera frames for:
  1. Path/lane detection (color threshold + contour centroid)
  2. ArUco marker detection (POI identification)
  3. PID steering output (centroid offset → differential motor speeds)

Uses frames from the Face Pi LAN stream (http://face-pi.local:8085/frame).
"""

import logging
import time
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ArUco dictionary — 4x4 with 50 markers is compact and fast
ARUCO_DICT = cv2.aruco.DICT_4X4_50


@dataclass
class NavigationResult:
    """Result of one navigation frame analysis."""
    steering: float         # -1.0 (hard left) to 1.0 (hard right), 0 = straight
    path_detected: bool     # Whether a valid path was found
    aruco_id: Optional[int] # Detected ArUco marker ID, or None
    aruco_distance: float   # Estimated distance to ArUco marker (cm)
    frame_debug: Optional[np.ndarray] = None  # Annotated frame for debugging


class PIDController:
    """Simple PID controller for steering and speed."""

    def __init__(self, kp: float, ki: float, kd: float):
        self.kp = kp
        self.ki = ki
        self.kd = kd
        self._integral = 0.0
        self._prev_error = 0.0
        self._prev_time = time.monotonic()

    def update(self, error: float) -> float:
        now = time.monotonic()
        dt = now - self._prev_time
        if dt <= 0:
            dt = 0.01

        self._integral += error * dt
        # Anti-windup: clamp integral
        self._integral = max(-100, min(100, self._integral))

        derivative = (error - self._prev_error) / dt

        output = (self.kp * error) + (self.ki * self._integral) + (self.kd * derivative)

        self._prev_error = error
        self._prev_time = now

        return output

    def reset(self):
        self._integral = 0.0
        self._prev_error = 0.0
        self._prev_time = time.monotonic()


class NavigationEngine:
    """Vision-based navigation using path detection and ArUco markers."""

    def __init__(
        self,
        kp: float = 0.5,
        ki: float = 0.0,
        kd: float = 0.1,
        base_speed: int = 180,
        max_speed: int = 255,
    ):
        self.pid = PIDController(kp, ki, kd)
        self.base_speed = base_speed
        self.max_speed = max_speed

        # ArUco detector
        aruco_dict = cv2.aruco.getPredefinedDictionary(ARUCO_DICT)
        params = cv2.aruco.DetectorParameters()
        self.aruco_detector = cv2.aruco.ArucoDetector(aruco_dict, params)

        # Path detection HSV range — tune for your path color
        # Default: dark line on light floor (like black tape)
        self.path_lower_hsv = np.array([0, 0, 0])
        self.path_upper_hsv = np.array([180, 255, 80])

        # Frame dimensions (set on first frame)
        self._frame_w = 0
        self._frame_h = 0

    def process_frame(self, frame: np.ndarray, debug: bool = False) -> NavigationResult:
        """Process a single camera frame and return navigation output."""
        self._frame_h, self._frame_w = frame.shape[:2]
        center_x = self._frame_w // 2

        # 1. Detect ArUco markers
        aruco_id, aruco_dist = self._detect_aruco(frame)

        # 2. Detect path centroid
        path_detected, centroid_x = self._detect_path(frame)

        # 3. Calculate steering via PID
        if path_detected:
            # Error: positive = path is to the right, need to steer right
            error = (centroid_x - center_x) / center_x  # Normalized -1 to 1
            steering = self.pid.update(error)
        else:
            steering = 0.0

        # Clamp steering
        steering = max(-1.0, min(1.0, steering))

        # Debug frame
        debug_frame = None
        if debug:
            debug_frame = frame.copy()
            # Draw center line
            cv2.line(debug_frame, (center_x, 0), (center_x, self._frame_h), (0, 255, 0), 1)
            # Draw centroid
            if path_detected:
                cv2.circle(debug_frame, (int(centroid_x), self._frame_h - 50), 10, (0, 0, 255), -1)
            # Draw steering bar
            bar_x = int(center_x + steering * center_x)
            cv2.line(debug_frame, (center_x, self._frame_h - 20), (bar_x, self._frame_h - 20), (255, 0, 0), 4)

        return NavigationResult(
            steering=steering,
            path_detected=path_detected,
            aruco_id=aruco_id,
            aruco_distance=aruco_dist,
            frame_debug=debug_frame,
        )

    def steering_to_motors(self, steering: float) -> Tuple[int, int]:
        """
        Convert steering value (-1..1) to (left_speed, right_speed).
        Returns speeds in range -max_speed..max_speed.
        """
        left = self.base_speed + int(steering * self.base_speed)
        right = self.base_speed - int(steering * self.base_speed)

        left = max(-self.max_speed, min(self.max_speed, left))
        right = max(-self.max_speed, min(self.max_speed, right))

        return left, right

    def _detect_path(self, frame: np.ndarray) -> Tuple[bool, float]:
        """
        Detect the path (dark line) and return its centroid x-coordinate.
        Only looks at the bottom third of the frame for immediate path.
        """
        h = self._frame_h
        # Region of interest: bottom third
        roi = frame[int(h * 0.66):h, :]

        # Convert to HSV and threshold
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, self.path_lower_hsv, self.path_upper_hsv)

        # Morphological cleanup
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

        # Find contours
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        if not contours:
            return False, self._frame_w / 2

        # Use the largest contour
        largest = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(largest)

        # Minimum area threshold (noise filter)
        if area < 500:
            return False, self._frame_w / 2

        M = cv2.moments(largest)
        if M["m00"] == 0:
            return False, self._frame_w / 2

        centroid_x = M["m10"] / M["m00"]
        return True, centroid_x

    def _detect_aruco(self, frame: np.ndarray) -> Tuple[Optional[int], float]:
        """
        Detect ArUco markers and return (marker_id, estimated_distance).
        Returns (None, 0) if no marker found.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        corners, ids, _ = self.aruco_detector.detectMarkers(gray)

        if ids is None or len(ids) == 0:
            return None, 0.0

        # Use the first (closest/largest) marker
        marker_id = int(ids[0][0])

        # Estimate distance from marker size (perimeter)
        perimeter = cv2.arcLength(corners[0][0], True)
        # Rough calibration: a 10cm marker at 100cm has ~perimeter of 200px at 640px width
        # Adjust this constant for your marker size
        estimated_distance = 20000.0 / max(perimeter, 1)

        return marker_id, estimated_distance
