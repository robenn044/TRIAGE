"""
TRIAGE Robot — Vision-Based Collision Avoidance

Since we have no ultrasonic sensor, we use the camera + YOLOv8
detections to estimate obstacle proximity. Objects are assessed
by their bounding box height relative to the frame — larger bbox
means closer object.

Safety zones:
  CLEAR   — No obstacles in path → full speed
  CAUTION — Obstacle detected in path → reduce speed 50%
  DANGER  — Obstacle very close → EMERGENCY STOP

The CollisionGuard also tracks the user's bbox to prevent
the robot from running into the tourist it's following.
"""

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)


class SafetyLevel(Enum):
    CLEAR = "CLEAR"
    CAUTION = "CAUTION"
    DANGER = "DANGER"


@dataclass
class ObstacleInfo:
    """Info about a detected obstacle in the robot's path."""
    bbox: Tuple[int, int, int, int]  # x1, y1, x2, y2
    height_ratio: float              # bbox height / frame height (proxy for distance)
    class_id: int
    class_name: str
    in_path: bool                    # True if in the center driving zone


@dataclass
class SafetyAssessment:
    """Result of collision assessment for one frame."""
    level: SafetyLevel
    speed_multiplier: float          # 1.0 = full, 0.5 = half, 0.0 = stop
    obstacles_in_path: List[ObstacleInfo] = field(default_factory=list)
    closest_height_ratio: float = 0.0
    reason: str = ""


# COCO class names for common obstacles the robot should avoid
OBSTACLE_CLASSES = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle",
    5: "bus", 7: "truck", 13: "bench", 14: "bird",
    15: "cat", 16: "dog", 24: "backpack", 25: "umbrella",
    26: "handbag", 27: "tie", 28: "suitcase", 56: "chair",
    57: "couch", 58: "potted plant", 59: "bed", 60: "dining table",
    62: "tv", 63: "laptop", 67: "cell phone",
}


class CollisionGuard:
    """
    Vision-based collision avoidance.

    Uses YOLOv8 detections to assess if the robot's path is clear.
    Works with any YOLO model that detects COCO classes.
    """

    def __init__(
        self,
        danger_threshold: float = 0.55,
        caution_threshold: float = 0.35,
        path_width_fraction: float = 0.4,
        min_confidence: float = 0.4,
        ignore_target_id: Optional[int] = None,
    ):
        """
        Args:
            danger_threshold:    bbox height / frame height → DANGER (≈ < 0.5m)
            caution_threshold:   bbox height / frame height → CAUTION (≈ < 1.5m)
            path_width_fraction: fraction of frame width considered "in path"
            min_confidence:      minimum detection confidence to consider
            ignore_target_id:    tracker ID to ignore (the followed tourist)
        """
        self.danger_threshold = danger_threshold
        self.caution_threshold = caution_threshold
        self.path_width_fraction = path_width_fraction
        self.min_confidence = min_confidence
        self.ignore_target_id = ignore_target_id

        # Tracking state
        self._consecutive_danger = 0
        self._consecutive_clear = 0

    def set_ignore_target(self, track_id: Optional[int]):
        """Set the tracker ID of the followed tourist (don't treat as obstacle)."""
        self.ignore_target_id = track_id

    def assess(self, detections, frame_shape: Tuple[int, ...]) -> SafetyAssessment:
        """
        Assess safety from YOLO detections.

        Args:
            detections: supervision.Detections object from YOLOv8
            frame_shape: (height, width, channels) of the frame

        Returns:
            SafetyAssessment with level, speed multiplier, and obstacle details
        """
        h, w = frame_shape[:2]
        center_x = w / 2
        path_half = (w * self.path_width_fraction) / 2
        path_left = center_x - path_half
        path_right = center_x + path_half

        obstacles_in_path: List[ObstacleInfo] = []
        max_height_ratio = 0.0

        if detections is None or len(detections) == 0:
            self._consecutive_danger = 0
            self._consecutive_clear += 1
            return SafetyAssessment(
                level=SafetyLevel.CLEAR,
                speed_multiplier=1.0,
                reason="No obstacles detected",
            )

        for i in range(len(detections.xyxy)):
            # Skip low-confidence detections
            if detections.confidence is not None and detections.confidence[i] < self.min_confidence:
                continue

            # Skip the followed tourist (we track them separately)
            if (
                self.ignore_target_id is not None
                and detections.tracker_id is not None
                and len(detections.tracker_id) > i
                and int(detections.tracker_id[i]) == self.ignore_target_id
            ):
                continue

            x1, y1, x2, y2 = detections.xyxy[i]
            bbox_center_x = (x1 + x2) / 2
            bbox_height = y2 - y1
            height_ratio = float(bbox_height / h)

            # Get class info
            class_id = int(detections.class_id[i]) if detections.class_id is not None else -1
            class_name = OBSTACLE_CLASSES.get(class_id, f"object_{class_id}")

            in_path = path_left <= bbox_center_x <= path_right

            obstacle = ObstacleInfo(
                bbox=(int(x1), int(y1), int(x2), int(y2)),
                height_ratio=height_ratio,
                class_id=class_id,
                class_name=class_name,
                in_path=in_path,
            )

            if in_path:
                obstacles_in_path.append(obstacle)
                if height_ratio > max_height_ratio:
                    max_height_ratio = height_ratio

        # Determine safety level from worst in-path obstacle
        if max_height_ratio >= self.danger_threshold:
            self._consecutive_danger += 1
            self._consecutive_clear = 0
            return SafetyAssessment(
                level=SafetyLevel.DANGER,
                speed_multiplier=0.0,
                obstacles_in_path=obstacles_in_path,
                closest_height_ratio=max_height_ratio,
                reason=f"DANGER: obstacle at {max_height_ratio:.0%} of frame height",
            )

        if max_height_ratio >= self.caution_threshold:
            self._consecutive_danger = 0
            self._consecutive_clear = 0
            return SafetyAssessment(
                level=SafetyLevel.CAUTION,
                speed_multiplier=0.5,
                obstacles_in_path=obstacles_in_path,
                closest_height_ratio=max_height_ratio,
                reason=f"CAUTION: obstacle at {max_height_ratio:.0%} of frame height",
            )

        self._consecutive_danger = 0
        self._consecutive_clear += 1
        return SafetyAssessment(
            level=SafetyLevel.CLEAR,
            speed_multiplier=1.0,
            obstacles_in_path=obstacles_in_path,
            closest_height_ratio=max_height_ratio,
            reason="Path clear",
        )

    def assess_raw_frame(self, frame: np.ndarray, model) -> SafetyAssessment:
        """
        Convenience method: run YOLO detection + assessment in one call.
        Use this when collision guard has its own dedicated detection pass.

        Args:
            frame: BGR image from camera
            model: loaded YOLO model (ultralytics.YOLO)

        Returns:
            SafetyAssessment
        """
        import supervision as sv

        results = model(frame, verbose=False)
        detections = sv.Detections.from_ultralytics(results[0])

        # Filter by confidence
        if detections.confidence is not None:
            mask = detections.confidence >= self.min_confidence
            detections = detections[mask]

        return self.assess(detections, frame.shape)
