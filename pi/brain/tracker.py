"""
TRIAGE Robot — YOLOv8n Target Tracker

Detects and tracks a specific tourist using:
  - YOLOv8n (NCNN export) for person detection
  - supervision ByteTrack for persistent track IDs
  - PID controller for follow behavior

Usage:
    tracker = TargetTracker()
    tracker.lock_target(frame)    # Lock onto nearest person
    result = tracker.update(frame) # Get follow steering
"""

import logging
import time
from dataclasses import dataclass
from typing import Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Lazy imports — these are heavy and only needed if following is activated
_ultralytics = None
_supervision = None


def _ensure_imports():
    """Lazy-load heavy ML libraries only when needed."""
    global _ultralytics, _supervision
    if _ultralytics is None:
        from ultralytics import YOLO
        _ultralytics = YOLO
        logger.info("Loaded Ultralytics YOLO")
    if _supervision is None:
        import supervision as sv
        _supervision = sv
        logger.info("Loaded supervision")


@dataclass
class TrackingResult:
    """Result of one tracking frame update."""
    target_found: bool
    steering: float         # -1.0 (left) to 1.0 (right)
    throttle: float         # 0.0 (stop) to 1.0 (full speed)
    target_bbox: Optional[Tuple[int, int, int, int]] = None  # x1, y1, x2, y2
    target_id: Optional[int] = None
    num_persons: int = 0


class TargetTracker:
    """Vision-based person tracker for tourist following."""

    def __init__(
        self,
        model_path: str = "yolov8n.pt",
        kp: float = 0.4,
        ki: float = 0.0,
        kd: float = 0.15,
        target_area_fraction: float = 0.08,
        deadzone_px: int = 30,
        confidence_threshold: float = 0.5,
    ):
        self.model_path = model_path
        self.kp = kp
        self.ki = ki
        self.kd = kd
        self.target_area_fraction = target_area_fraction
        self.deadzone_px = deadzone_px
        self.confidence_threshold = confidence_threshold

        self._model = None
        self._byte_tracker = None
        self._locked_track_id: Optional[int] = None
        self._initialized = False

        # PID state
        self._integral = 0.0
        self._prev_error = 0.0
        self._prev_time = time.monotonic()

    def initialize(self):
        """Load model and tracker. Call once before use."""
        if self._initialized:
            return

        _ensure_imports()
        self._model = _ultralytics(self.model_path)
        self._byte_tracker = _supervision.ByteTrack(
            track_activation_threshold=self.confidence_threshold,
            minimum_matching_threshold=0.8,
            lost_track_buffer=30,
            frame_rate=15,
        )
        self._initialized = True
        logger.info("Target tracker initialized with model: %s", self.model_path)

    def lock_target(self, frame: np.ndarray) -> bool:
        """
        Detect persons in frame and lock onto the nearest/largest one.
        Returns True if a target was found and locked.
        """
        if not self._initialized:
            self.initialize()

        detections = self._detect(frame)
        if detections is None or len(detections) == 0:
            logger.warning("No persons detected — cannot lock target")
            return False

        # Pick the largest bounding box (closest person)
        areas = detections.area
        best_idx = int(np.argmax(areas))

        if detections.tracker_id is not None and len(detections.tracker_id) > best_idx:
            self._locked_track_id = int(detections.tracker_id[best_idx])
            logger.info("Locked onto target track ID: %d", self._locked_track_id)
            return True

        logger.warning("Could not assign track ID to target")
        return False

    def unlock_target(self):
        """Release the locked target."""
        self._locked_track_id = None
        self._integral = 0.0
        self._prev_error = 0.0
        logger.info("Target unlocked")

    def update(self, frame: np.ndarray) -> TrackingResult:
        """
        Process a frame and return tracking/follow result.
        Must call lock_target() first.
        """
        if not self._initialized:
            self.initialize()

        h, w = frame.shape[:2]
        center_x = w / 2
        frame_area = w * h

        detections = self._detect(frame)

        if detections is None or len(detections) == 0:
            return TrackingResult(target_found=False, steering=0.0, throttle=0.0, num_persons=0)

        num_persons = len(detections)

        # Find our locked target
        target_bbox = None
        target_id = self._locked_track_id

        if detections.tracker_id is not None and self._locked_track_id is not None:
            for i, tid in enumerate(detections.tracker_id):
                if int(tid) == self._locked_track_id:
                    target_bbox = detections.xyxy[i]
                    break

        if target_bbox is None:
            # Target lost — try to re-lock onto the largest person
            areas = detections.area
            best_idx = int(np.argmax(areas))
            if detections.tracker_id is not None and len(detections.tracker_id) > best_idx:
                self._locked_track_id = int(detections.tracker_id[best_idx])
                target_bbox = detections.xyxy[best_idx]
                target_id = self._locked_track_id
                logger.info("Re-locked onto track ID: %d", self._locked_track_id)

        if target_bbox is None:
            return TrackingResult(
                target_found=False, steering=0.0, throttle=0.0, num_persons=num_persons
            )

        x1, y1, x2, y2 = target_bbox
        bbox_center_x = (x1 + x2) / 2
        bbox_area = (x2 - x1) * (y2 - y1)
        bbox_area_fraction = bbox_area / frame_area

        # Steering: PID on horizontal offset
        error_x = (bbox_center_x - center_x) / center_x  # -1 to 1

        if abs(bbox_center_x - center_x) < self.deadzone_px:
            error_x = 0.0

        steering = self._pid_update(error_x)
        steering = max(-1.0, min(1.0, steering))

        # Throttle: based on target area vs desired area
        area_error = self.target_area_fraction - bbox_area_fraction
        throttle = max(0.0, min(1.0, area_error * 10))  # Scale factor

        return TrackingResult(
            target_found=True,
            steering=steering,
            throttle=throttle,
            target_bbox=(int(x1), int(y1), int(x2), int(y2)),
            target_id=target_id,
            num_persons=num_persons,
        )

    def _detect(self, frame: np.ndarray):
        """Run YOLO detection + ByteTrack."""
        results = self._model(frame, classes=[0], verbose=False)  # class 0 = person
        detections = _supervision.Detections.from_ultralytics(results[0])

        # Filter by confidence
        mask = detections.confidence >= self.confidence_threshold
        detections = detections[mask]

        # Update tracker
        detections = self._byte_tracker.update_with_detections(detections)

        return detections

    def _pid_update(self, error: float) -> float:
        now = time.monotonic()
        dt = now - self._prev_time
        if dt <= 0:
            dt = 0.01

        self._integral += error * dt
        self._integral = max(-50, min(50, self._integral))
        derivative = (error - self._prev_error) / dt

        output = (self.kp * error) + (self.ki * self._integral) + (self.kd * derivative)

        self._prev_error = error
        self._prev_time = now

        return output
