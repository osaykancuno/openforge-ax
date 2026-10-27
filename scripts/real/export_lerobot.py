#!/usr/bin/env python3
"""Step 2 of the LeRobot export: write verified OpenForge runs as a LeRobot dataset (format v3.0).

Input: the JSONL from `node scripts/lerobot-prep.mjs` (actions + measured joint states, replayed by the site's own
simulator). Output: a LeRobotDataset written with the official `lerobot` library, plus provenance in
`meta/openforge.json` (data hash, agent, outcome, on-chain attestation of every episode). Optionally pushed to the
Hugging Face Hub under CC0.

    pip install lerobot
    python scripts/real/export_lerobot.py lerobot-src.jsonl --repo-id <hf-user>/openforge-proving-grounds [--root out] [--push] [--private]

Checked against lerobot `main` (2026-10): LeRobotDataset.create(...), add_frame(frame) with a "task" key,
save_episode(), finalize() (required), push_to_hub(license=..., tags=..., private=...). Older releases (task passed
to add_frame/save_episode, `lerobot.common` import path, no finalize) are handled below.

Units: joints in degrees (LeRobot `use_degrees=True` convention), gripper 0-100 (LeRobot RANGE_0_100), 30 fps,
robot_type "so101_follower", features "<joint>.pos". The episodes are simulated runs of the SO-101 digital twin,
verified by deterministic replay; they are not real-robot recordings.
"""
import argparse
import inspect
import json
import shutil
import sys
from pathlib import Path

import numpy as np

try:  # current layout
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
except ImportError:  # older releases
    try:
        from lerobot.common.datasets.lerobot_dataset import LeRobotDataset
    except ImportError:
        sys.exit("The `lerobot` package is not installed: pip install lerobot")


def load(path):
    eps = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if not eps:
        sys.exit(f"{path} has no episodes")
    first = eps[0]
    for e in eps:  # one dataset = one robot, rate and joint layout
        if (e["robot_type"], e["fps"], tuple(e["joints"])) != (first["robot_type"], first["fps"], tuple(first["joints"])):
            sys.exit(f"Episode {e['dataHash']} has a different robot/fps/joints than the first one")
        if len(e["actions"]) != len(e["states"]):
            sys.exit(f"Episode {e['dataHash']}: {len(e['actions'])} actions but {len(e['states'])} states")
    return eps


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", help="JSONL from scripts/lerobot-prep.mjs")
    ap.add_argument("--repo-id", required=True, help="<hf-user>/<dataset-name>")
    ap.add_argument("--root", default=None, help="output folder (default: ./lerobot/<dataset-name>)")
    ap.add_argument("--only-success", action="store_true", help="skip failed runs (by default failures are kept: failure is data too)")
    ap.add_argument("--push", action="store_true", help="upload to the Hugging Face Hub (needs `huggingface-cli login`)")
    ap.add_argument("--private", action="store_true", help="create the Hub dataset as private")
    ap.add_argument("--overwrite", action="store_true", help="replace an existing output folder")
    args = ap.parse_args()

    eps = load(args.src)
    if args.only_success:
        eps = [e for e in eps if e["success"]]
    root = Path(args.root or Path("lerobot") / args.repo_id.split("/")[-1])
    if root.exists():
        if not args.overwrite:
            sys.exit(f"{root} exists: pass --overwrite to replace it")
        shutil.rmtree(root)

    names = [f"{j}.pos" for j in eps[0]["joints"]]
    features = {
        "action": {"dtype": "float32", "shape": (len(names),), "names": names},
        "observation.state": {"dtype": "float32", "shape": (len(names),), "names": names},
    }
    ds = LeRobotDataset.create(repo_id=args.repo_id, fps=eps[0]["fps"], features=features, root=root,
                               robot_type=eps[0]["robot_type"], use_videos=False)

    # task location changed across releases: frame["task"] (current) vs add_frame(..., task=) (older)
    task_arg = "task" in inspect.signature(ds.add_frame).parameters
    provenance = []
    for i, e in enumerate(eps):
        for act, obs in zip(e["actions"], e["states"]):
            frame = {"action": np.asarray(act, dtype=np.float32), "observation.state": np.asarray(obs, dtype=np.float32)}
            if task_arg:
                ds.add_frame(frame, task=e["task"])
            else:
                frame["task"] = e["task"]
                ds.add_frame(frame)
        ds.save_episode()
        provenance.append({
            "episode_index": i, "data_hash": e["dataHash"], "source": e["source"], "agent_token_id": e["tokenId"],
            "success": e["success"], "seconds": e["seconds"], "quality": e["quality"], "events": e["events"],
            "seed": e["seed"], "attestation_tx": e.get("attestationTx"), "status": e.get("status"),
        })
    if hasattr(ds, "finalize"):
        ds.finalize()  # required by format v3.0, or the parquet footers are missing

    meta = root / "meta"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "openforge.json").write_text(json.dumps({
        "project": "OpenForge AX", "license": "CC0-1.0",
        "sim": "openforge-arm-sim@1 (digital twin of the LeRobot SO-101)", "mission": "pick-place-cell",
        "units": {"joints": "degrees", "gripper": "0-100"},
        "verification": "every episode was replayed deterministically from its seed and actions; data_hash = keccak256 of the canonical episode",
        "episodes": provenance,
    }, indent=1), encoding="utf-8")

    docked = sum(e["success"] for e in eps)
    print(f"Wrote {len(eps)} episodes ({docked} docked, {len(eps) - docked} failures kept) to {root}")
    if args.push:
        kwargs = {"tags": ["openforge", "so101", "simulation", "lerobot"], "private": args.private or None}
        if "license" in inspect.signature(ds.push_to_hub).parameters:
            kwargs["license"] = "cc0-1.0"
        ds.push_to_hub(**kwargs)
        print(f"Pushed to https://huggingface.co/datasets/{args.repo_id}")


if __name__ == "__main__":
    main()
