// LeRobot export: step 1 (Node replay, scripts/lerobot-prep.mjs) end to end, and step 2 (Python writer) against a
// stub of the `lerobot` API that records every call (the real package pulls in PyTorch; its API was checked by hand).
const { expect } = require("chai");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");

const ROOT = path.join(__dirname, "..");

describe("LeRobot dataset export", function () {
  this.timeout(60_000);
  let sim, dir;
  before(async () => {
    sim = { ...(await import("../web/js/sim/autopilot.js")), ...(await import("../web/js/sim/episode.js")), ...(await import("../web/js/sim/arm-sim.js")) };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lerobot-"));
  });

  function verifierRun(data, tokenId, { tamper = false, status = "attested" } = {}) {
    const seed = ethers.hexlify(ethers.randomBytes(32));
    const challengeId = ethers.hexlify(ethers.randomBytes(32));
    const ep = sim.buildEpisode({ tokenId, challengeId, seed, actions: sim.autopilot(seed) });
    const bytes = sim.canonicalize(ep);
    const hash = ethers.keccak256(ethers.toUtf8Bytes(bytes));
    fs.mkdirSync(path.join(data, "episodes"), { recursive: true });
    fs.mkdirSync(path.join(data, "results"), { recursive: true });
    const stored = tamper ? bytes.replace(/"tokenId":\d+/, `"tokenId":${tokenId + 1}`) : bytes;
    fs.writeFileSync(path.join(data, "episodes", `${hash}.json`), stored);
    fs.writeFileSync(path.join(data, "results", `${hash}.json`), JSON.stringify({ dataHash: hash, tokenId, owner: "0x0", status, tx: "0xabc", verifiedAt: 1000 + tokenId }));
    return hash;
  }

  it("prep replays verified runs, keeps failures, skips tampered files, filters by attestation", () => {
    const data = path.join(dir, "data");
    const good = verifierRun(data, 2);
    verifierRun(data, 3, { tamper: true });
    verifierRun(data, 4, { status: "queued" });
    // a downloaded run file with a failed (truncated) run
    const seed = ethers.hexlify(ethers.randomBytes(32));
    const failed = sim.buildEpisode({ tokenId: 0, challengeId: ethers.ZeroHash, seed, actions: sim.autopilot(seed).slice(0, 10) });
    const runFile = path.join(dir, "run.json");
    fs.writeFileSync(runFile, JSON.stringify(failed));

    const out = path.join(dir, "src.jsonl");
    const log = execFileSync(process.execPath, ["scripts/lerobot-prep.mjs", "--data", data, "--attested", "--runs", runFile, "--out", out], { cwd: ROOT, encoding: "utf8" });
    const lines = fs.readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
    expect(lines.map((l) => l.source).sort()).to.deep.equal(["agent-run", "run-file:run.json"]);
    expect(log).to.match(/content does not match its hash/);
    const agentRun = lines.find((l) => l.source === "agent-run");
    expect(agentRun).to.include({ dataHash: good, tokenId: 2, success: true, robot_type: "so101_follower", fps: 30, attestationTx: "0xabc" });
    expect(agentRun.joints).to.deep.equal(["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]);
    expect(agentRun.states.length).to.equal(agentRun.actions.length);
    expect(agentRun.states[0]).to.have.length(6);
    expect(lines.find((l) => l.source !== "agent-run").success).to.equal(false); // failure is data too
  });

  it("the Python writer follows the LeRobot v3 API (create → add_frame with task → save_episode → finalize) and records provenance", function () {
    const py = ["python", "python3", "py"].find((p) => spawnSync(p, ["--version"]).status === 0);
    if (!py) this.skip();
    const stub = path.join(dir, "stub", "lerobot", "datasets");
    fs.mkdirSync(stub, { recursive: true });
    fs.writeFileSync(path.join(dir, "stub", "lerobot", "__init__.py"), "");
    fs.writeFileSync(path.join(stub, "__init__.py"), "");
    fs.writeFileSync(path.join(stub, "lerobot_dataset.py"), `
import json, os
CALLS = []
class LeRobotDataset:
    @classmethod
    def create(cls, repo_id, fps, features, root=None, robot_type=None, use_videos=True, **kw):
        d = cls(); d.root = root; d.frames = 0; d.eps = 0
        CALLS.append(["create", repo_id, fps, sorted(features), list(features["action"]["shape"]), features["action"]["names"], robot_type, use_videos])
        return d
    def add_frame(self, frame):
        assert "task" in frame and frame["action"].dtype.name == "float32" and frame["observation.state"].shape == (6,)
        self.frames += 1
    def save_episode(self, episode_data=None, parallel_encoding=True):
        self.eps += 1
    def finalize(self):
        CALLS.append(["finalize", self.frames, self.eps])
        os.makedirs(os.path.join(self.root, "meta"), exist_ok=True)
        with open(os.path.join(self.root, "calls.json"), "w") as f: json.dump(CALLS, f)
`);
    const root = path.join(dir, "ds");
    const r = spawnSync(py, ["scripts/real/export_lerobot.py", path.join(dir, "src.jsonl"), "--repo-id", "tester/openforge", "--root", root], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, PYTHONPATH: path.join(dir, "stub") },
    });
    if (/No module named 'numpy'/.test(r.stderr)) this.skip();
    expect(r.status, r.stderr).to.equal(0);
    const calls = JSON.parse(fs.readFileSync(path.join(root, "calls.json"), "utf8"));
    const src = fs.readFileSync(path.join(dir, "src.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    expect(calls[0]).to.deep.equal(["create", "tester/openforge", 30, ["action", "observation.state"], [6], src[0].joints.map((j) => `${j}.pos`), "so101_follower", false]);
    expect(calls[1]).to.deep.equal(["finalize", src.reduce((n, e) => n + e.actions.length, 0), 2]);
    const prov = JSON.parse(fs.readFileSync(path.join(root, "meta", "openforge.json"), "utf8"));
    expect(prov.license).to.equal("CC0-1.0");
    expect(prov.episodes.map((e) => e.data_hash)).to.deep.equal(src.map((e) => e.dataHash));
  });
});
