#!/usr/bin/env python3
"""Replay a Proving Grounds run on a real SO-101 follower arm (LeRobot).

Input: the file from the arena ("Download for real robot"). Safety first:
- dry run is the default; --execute also requires a calibration file and a typed confirmation;
- the run is re-simulated locally (node scripts/real/verify-run.mjs) and refused if it hits the table,
  loses the cell, breaks command limits or disagrees with the file;
- playback is slowed (0.5x default), eased in from the current pose and back to rest;
- on Ctrl+C / SIGTERM / errors the arm ramps slowly to rest before torque is disabled.

    python scripts/real/replay_so101.py run.json
    python scripts/real/replay_so101.py run.json --execute --port COM5 --calibration calib.json

The LeRobot backend targets the SO101Follower API (lerobot >= 0.3): verify it against your installed version
before the first real run. Clear the workspace and keep a hand on the power switch.
"""
import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time

JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]
SIM_LIMITS = [(-110, 110), (-100, 100), (-100, 100), (-100, 100), (-160, 160), (0, 100)]
SIM_FPS = 30
SIM_MAX_STEP = 6.0  # deg per frame, enforced by the verifier
REST = [0, -30, 90, 60, 0, 100]
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def identity_calibration():
    return {j: {"sign": 1, "offset_deg": 0, "min": lo, "max": hi} for j, (lo, hi) in zip(JOINTS, SIM_LIMITS)}


def load_calibration(path):
    """Per joint: sign (1|-1), offset_deg (real = sign * sim + offset), and the arm's own min/max in real degrees."""
    with open(path, encoding="utf-8") as f:
        cal = json.load(f)
    for j in JOINTS:
        c = cal.get(j)
        if not isinstance(c, dict) or c.get("sign") not in (1, -1) or not all(isinstance(c.get(k), (int, float)) for k in ("offset_deg", "min", "max")) or c["min"] >= c["max"]:
            sys.exit(f"Invalid calibration for {j}: need sign 1|-1, numeric offset_deg, min < max")
    return cal


def to_real(frame, cal):
    return [cal[j]["sign"] * frame[i] + cal[j]["offset_deg"] for i, j in enumerate(JOINTS)]


def in_limits(real, cal):
    return all(cal[j]["min"] <= real[i] <= cal[j]["max"] for i, j in enumerate(JOINTS))


def resimulate(path):
    node = shutil.which("node")
    if not node:
        return None, "node not found: cannot re-verify the run locally"
    out = subprocess.run([node, os.path.join(ROOT, "scripts", "real", "verify-run.mjs"), path], capture_output=True, text=True)
    try:
        res = json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return None, f"verifier failed: {out.stderr.strip()[:200]}"
    return res, None if res.get("valid") else res.get("error")


def safety_check(path, ep, cal):
    problems = []
    if ep.get("format") != "openforge.episode.v1" or ep.get("robot_type") != "so101_follower" or ep.get("units") != "deg":
        problems.append("not an openforge.episode.v1 SO-101 run in degrees")
    if ep.get("fps") != SIM_FPS:
        problems.append(f"fps must be {SIM_FPS}")
    res, err = resimulate(path)
    if err:
        problems.append(err)
    else:
        outcome = res["outcome"]
        if outcome["events"]["tableHits"] > 0:
            problems.append("the run hits the table in simulation")
        if outcome["reason"] == "cell_lost":
            problems.append("the run throws the cell off the table")
        claimed = ep.get("outcome")
        if claimed and (claimed.get("success") != outcome["success"] or claimed.get("ticks") != outcome["ticks"]):
            problems.append("the outcome written in the file does not match the local re-simulation")
    prev = REST
    for t, a in enumerate(ep.get("actions", [])):
        if len(a) != 6 or any(abs(a[i] - prev[i]) > SIM_MAX_STEP + 1e-6 for i in range(6)):
            problems.append(f"bad or too large command at frame {t}")
            break
        if not all(SIM_LIMITS[i][0] <= a[i] <= SIM_LIMITS[i][1] for i in range(6)) or not in_limits(to_real(a, cal), cal):
            problems.append(f"command outside the arm's safe range at frame {t}")
            break
        prev = a
    if not in_limits(to_real(REST, cal), cal):
        problems.append("the rest pose is outside the calibrated range")
    return problems


def interpolate(a, b, steps):
    return [[a[i] + (b[i] - a[i]) * k / steps for i in range(6)] for k in range(1, steps + 1)]


class PrintBackend:
    def connect(self):
        print("[dry-run] no hardware connected")

    def position(self):
        return None

    def send(self, real):
        pass

    def disconnect(self):
        pass


class LeRobotBackend:
    def __init__(self, port, robot_id, max_relative_target):
        try:
            from lerobot.robots.so101_follower import SO101Follower, SO101FollowerConfig
        except ImportError as e:  # pragma: no cover
            sys.exit(f"LeRobot not found ({e}). Install lerobot with the feetech extra, or run without --execute.")
        self.robot = SO101Follower(SO101FollowerConfig(port=port, id=robot_id, max_relative_target=max_relative_target, use_degrees=True))

    def connect(self):
        self.robot.connect()

    def position(self):
        obs = self.robot.get_observation()
        return [float(obs[f"{j}.pos"]) for j in JOINTS]

    def send(self, real):
        self.robot.send_action({f"{j}.pos": float(v) for j, v in zip(JOINTS, real)})

    def disconnect(self):
        self.robot.disconnect()  # disables torque


def play(backend, poses, period):
    last = None
    for real in poses:
        t0 = time.perf_counter()
        backend.send(real)
        last = real
        time.sleep(max(0.0, period - (time.perf_counter() - t0)))
    return last


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("episode")
    ap.add_argument("--calibration", help="JSON with sign/offset_deg/min/max per joint (required with --execute)")
    ap.add_argument("--execute", action="store_true", help="drive the real arm (default: dry run)")
    ap.add_argument("--port", default="/dev/ttyACM0")
    ap.add_argument("--robot-id", default="openforge_so101")
    ap.add_argument("--speed", type=float, default=0.5, help="playback speed factor (0.1-1.0)")
    args = ap.parse_args()

    if args.execute and not args.calibration:
        sys.exit("--execute requires --calibration for your physical arm.")
    cal = load_calibration(args.calibration) if args.calibration else identity_calibration()
    with open(args.episode, encoding="utf-8") as f:
        ep = json.load(f)

    problems = safety_check(args.episode, ep, cal)
    if problems:
        print("REFUSED: this run is not safe to replay:")
        for p in dict.fromkeys(problems):
            print("  -", p)
        sys.exit(2)

    speed = min(1.0, max(0.1, args.speed))
    frames = ep["actions"]
    period = 1.0 / (SIM_FPS * speed)
    print(f"Run OK (re-simulated locally): token {ep['tokenId']}, {len(frames)} frames, {len(frames) / SIM_FPS:.1f}s sim -> {len(frames) * period:.1f}s real at {speed}x")
    print("Scene (robot base frame, meters):", json.dumps(ep.get("scene")))
    print("Note: sim success means a plausible trajectory, not a guaranteed real grasp.")

    if args.execute and input("Workspace clear and hand on the power switch? Type YES to start: ").strip() != "YES":
        sys.exit("Aborted.")

    backend = LeRobotBackend(args.port, args.robot_id, max_relative_target=5) if args.execute else PrintBackend()
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    rest = to_real(REST, cal)
    last = None
    try:
        backend.connect()
        start = backend.position()
        if start is not None and not in_limits(start, cal):
            sys.exit("The arm's current pose is outside the calibrated range. Move it to rest manually first.")
        first = to_real(frames[0], cal)
        ease = interpolate(start, first, 2 * SIM_FPS) if start else []  # 2 s ease-in
        last = play(backend, ease + [to_real(a, cal) for a in frames], period)
        last = play(backend, interpolate(last, rest, 2 * SIM_FPS), period)
        print("Done." if args.execute else "Dry run complete. Add --execute --calibration <file> to drive the arm.")
    except KeyboardInterrupt:
        print("\nSTOP requested: ramping slowly to rest before disabling torque.")
        if last is not None:
            try:
                play(backend, interpolate(last, rest, 3 * SIM_FPS), 1.0 / SIM_FPS)
            except Exception as e:  # pragma: no cover
                print("ramp failed:", e)
    finally:
        backend.disconnect()


if __name__ == "__main__":
    main()
