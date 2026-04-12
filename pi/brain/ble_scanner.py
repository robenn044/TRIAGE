"""
TRIAGE Robot — BLE Proximity Scanner (AirTag-like)

Optional BLE-based proximity estimation using the Pi 5's built-in
Bluetooth 5.0. Scans for the paired phone's BLE advertisements
and estimates distance from RSSI.

This is a SUPPLEMENT to visual tracking — it provides:
  - Rough distance estimation even when the camera can't see the user
  - "Lost user" detection when they walk out of BLE range (~15m)
  - Proximity zones similar to Apple AirTag (IMMEDIATE/NEAR/MEDIUM/FAR/LOST)

Requires:
  - bleak >= 0.22 (pip install bleak)
  - Bluetooth enabled on the Pi (sudo bluetoothctl power on)
  - Phone's BLE address (obtained during QR pairing flow)

Usage:
    scanner = BLEScanner()
    scanner.pair("AA:BB:CC:DD:EE:FF")
    await scanner.start()
    print(scanner.zone)  # ProximityZone.NEAR
"""

import asyncio
import logging
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)

try:
    from bleak import BleakScanner
    HAS_BLEAK = True
except ImportError:
    HAS_BLEAK = False
    logger.info("bleak not installed — BLE proximity disabled (vision-only tracking)")


class ProximityZone(Enum):
    """RSSI-based proximity zones (approximate distances in open air)."""
    IMMEDIATE = "IMMEDIATE"  # RSSI > -50  → < 0.5m
    NEAR = "NEAR"            # RSSI -50 to -65 → 0.5-2m
    MEDIUM = "MEDIUM"        # RSSI -65 to -80 → 2-5m
    FAR = "FAR"              # RSSI -80 to -90 → 5-10m
    LOST = "LOST"            # RSSI < -90 or no signal


def rssi_to_zone(rssi: Optional[int]) -> ProximityZone:
    """Convert raw RSSI dBm to a proximity zone."""
    if rssi is None:
        return ProximityZone.LOST
    if rssi > -50:
        return ProximityZone.IMMEDIATE
    if rssi > -65:
        return ProximityZone.NEAR
    if rssi > -80:
        return ProximityZone.MEDIUM
    if rssi > -90:
        return ProximityZone.FAR
    return ProximityZone.LOST


def rssi_to_distance_m(rssi: int, tx_power: int = -59, path_loss: float = 2.5) -> float:
    """
    Rough RSSI → distance conversion using log-distance path loss model.

    Args:
        rssi: measured RSSI in dBm
        tx_power: RSSI at 1 meter (calibrate per device, -59 is typical)
        path_loss: environment factor (2.0=open air, 2.5=indoor, 3.5=cluttered)

    Returns:
        Estimated distance in meters (very approximate)
    """
    if rssi >= tx_power:
        return 0.1
    return 10 ** ((tx_power - rssi) / (10 * path_loss))


class BLEScanner:
    """
    BLE proximity scanner for tracking the paired tourist's phone.

    The phone's BLE address is obtained during QR pairing. We then
    continuously scan for its BLE advertisements to estimate distance.
    """

    def __init__(self, scan_interval: float = 2.0, scan_duration: float = 1.5):
        self._paired_address: Optional[str] = None
        self._rssi: Optional[int] = None
        self._zone = ProximityZone.LOST
        self._distance_m: Optional[float] = None
        self._running = False
        self._scan_interval = scan_interval
        self._scan_duration = scan_duration
        self._miss_count = 0
        self._max_misses = 5  # LOST after 5 consecutive missed scans

    # ── Properties ────────────────────────────────────────

    @property
    def is_paired(self) -> bool:
        return self._paired_address is not None

    @property
    def rssi(self) -> Optional[int]:
        return self._rssi

    @property
    def zone(self) -> ProximityZone:
        return self._zone

    @property
    def distance_m(self) -> Optional[float]:
        return self._distance_m

    @property
    def is_connected(self) -> bool:
        """True if the phone was seen in the last few scans."""
        return self._zone != ProximityZone.LOST

    # ── Control ───────────────────────────────────────────

    def pair(self, address: str):
        """Register the phone's BLE MAC address for tracking."""
        self._paired_address = address.upper().strip()
        self._miss_count = 0
        logger.info("BLE paired with: %s", self._paired_address)

    def unpair(self):
        """Clear the paired device."""
        self._paired_address = None
        self._rssi = None
        self._zone = ProximityZone.LOST
        self._distance_m = None
        self._miss_count = 0
        logger.info("BLE unpaired")

    async def start(self):
        """Start the background BLE scan loop."""
        if not HAS_BLEAK:
            logger.warning("BLE scanning unavailable — bleak not installed")
            return

        self._running = True
        logger.info("BLE scanner started (interval=%.1fs)", self._scan_interval)

        while self._running:
            if self._paired_address:
                await self._scan_once()
            await asyncio.sleep(self._scan_interval)

    async def stop(self):
        """Stop scanning."""
        self._running = False
        logger.info("BLE scanner stopped")

    # ── Internal ──────────────────────────────────────────

    async def _scan_once(self):
        """Perform one BLE scan cycle."""
        try:
            devices = await BleakScanner.discover(
                timeout=self._scan_duration,
                return_adv=True,
            )

            found = False
            for device, adv_data in devices.values():
                if device.address.upper() == self._paired_address:
                    self._rssi = adv_data.rssi
                    self._zone = rssi_to_zone(self._rssi)
                    self._distance_m = round(rssi_to_distance_m(self._rssi), 2)
                    self._miss_count = 0
                    found = True
                    logger.debug(
                        "BLE: %s RSSI=%d zone=%s dist≈%.1fm",
                        self._paired_address, self._rssi, self._zone.value, self._distance_m,
                    )
                    break

            if not found:
                self._miss_count += 1
                if self._miss_count >= self._max_misses:
                    self._rssi = None
                    self._zone = ProximityZone.LOST
                    self._distance_m = None
                    if self._miss_count == self._max_misses:
                        logger.warning("BLE: Phone lost after %d missed scans", self._max_misses)

        except Exception as e:
            logger.debug("BLE scan error: %s", e)

    def to_dict(self) -> dict:
        """Serialize state for API/telemetry."""
        return {
            "paired": self.is_paired,
            "connected": self.is_connected,
            "rssi": self._rssi,
            "zone": self._zone.value,
            "distance_m": self._distance_m,
        }
