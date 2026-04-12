"""
TRIAGE Robot — Finite State Machine

States:
  IDLE        → Motors off, waiting for "start_trip" command from dashboard.
  TOURING     → Vision navigation active, heading to next POI.
  AT_POI      → Stopped at POI, triggering AI narration.
  FOLLOWING   → Target tracking active, following a tourist.
  END_TRIP    → Stop motors, reset everything, return to IDLE.

Transitions are triggered by the Brain daemon based on sensor data,
vision events, and dashboard commands.
"""

import logging
from transitions import Machine

logger = logging.getLogger(__name__)


class RobotFSM:
    """Finite state machine for the TRIAGE tourist guide robot."""

    states = ["IDLE", "TOURING", "AT_POI", "FOLLOWING", "END_TRIP"]

    def __init__(self):
        self.machine = Machine(
            model=self,
            states=RobotFSM.states,
            initial="IDLE",
            auto_transitions=False,
            send_event=True,
        )

        # IDLE transitions
        self.machine.add_transition("start_trip", "IDLE", "TOURING", before="on_exit_idle")
        self.machine.add_transition("start_follow", "IDLE", "FOLLOWING", before="on_exit_idle")

        # TOURING transitions
        self.machine.add_transition("arrive_poi", "TOURING", "AT_POI", before="on_arrive_poi")
        self.machine.add_transition("end_trip", "TOURING", "END_TRIP", before="on_end_trip")
        self.machine.add_transition("start_follow", "TOURING", "FOLLOWING")

        # AT_POI transitions
        self.machine.add_transition("leave_poi", "AT_POI", "TOURING", after="on_leave_poi")
        self.machine.add_transition("end_trip", "AT_POI", "END_TRIP", before="on_end_trip")
        self.machine.add_transition("start_follow", "AT_POI", "FOLLOWING")

        # FOLLOWING transitions
        self.machine.add_transition("stop_follow", "FOLLOWING", "TOURING")
        self.machine.add_transition("end_trip", "FOLLOWING", "END_TRIP", before="on_end_trip")
        self.machine.add_transition("arrive_poi", "FOLLOWING", "AT_POI", before="on_arrive_poi")

        # END_TRIP transitions
        self.machine.add_transition("reset", "END_TRIP", "IDLE", after="on_reset")

        # Universal pause: any state can end trip
        self.machine.add_transition("emergency_stop", "*", "END_TRIP", before="on_end_trip")

    # ── Callbacks ───────────────────────────────────────────

    def on_exit_idle(self, event):
        logger.info("Starting trip — leaving IDLE state")

    def on_arrive_poi(self, event):
        poi_name = event.kwargs.get("poi_name", "Unknown POI")
        logger.info("Arrived at POI: %s", poi_name)

    def on_leave_poi(self, event):
        logger.info("Leaving POI — resuming tour")

    def on_end_trip(self, event):
        logger.info("Ending trip — stopping all systems")

    def on_reset(self, event):
        logger.info("Robot reset — ready for next tourist")
