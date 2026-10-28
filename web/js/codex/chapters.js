// The Codex chapters: short text, actions (real buttons, mirrored by clickable objects in the diorama) and a small
// lab-notebook diorama built from the shared robot models (models/robots.js). Text is authored here (static);
// dynamic values go through textContent in codex.js.
import * as THREE from "three";
import { mat, rbox, cyl, sphere, torus, phone, phoneFace, inkOutline } from "../models/look.js";
import { buildRobot } from "../models/robots.js";

const at = (o, x, y, z) => (o.position.set(x, y, z), o);
const pick = (o, action) => ((o.userData.action = action), o);
const lerp = (a, b, k) => a + (b - a) * k;

/** A paper plinth with a thin coloured rim (where a model stands on the page). */
function pad(color = "accent", r = 0.6) {
  const g = new THREE.Group();
  g.add(at(cyl(r, r * 1.04, 0.06, "paper2", 48), 0, 0.03, 0));
  const rim = at(torus(r, 0.014, color), 0, 0.062, 0);
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  return g;
}

/** A robot from models/robots.js, scaled up to page size. */
function model(id, scale) {
  const rig = buildRobot(id);
  rig.group.scale.setScalar(scale);
  inkOutline(rig.group, { opacity: 0.3 }); // the lab-plate ink line keeps white plastic readable on white paper
  return rig;
}

/** Tween many joints of a rig from their current values to `to`. */
function poseTo(animate, rig, to, ms = 500) {
  const from = Object.fromEntries(Object.keys(to).map((k) => [k, rig.get(k)]));
  return animate(ms, (k) => rig.pose(Object.fromEntries(Object.keys(to).map((n) => [n, lerp(from[n], to[n], k)]))));
}

/** A small glowing-free "packet": a sphere that travels along points (signal diagrams). */
async function travel(animate, obj, pts, ms = 600) {
  obj.visible = true;
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
  await animate(ms, (k) => obj.position.copy(curve.getPoint(k)));
  obj.visible = false;
}

const disposeFace = (rig) => rig?.face?.texture.dispose();

/** Each build() gets the view API (animate, ease, reduced) and returns { group, pickables, update?, act(id) → status text, dispose? } */
export const CHAPTERS = [
  {
    number: "01", kicker: "Meet AX-1", title: "A phone for a brain",
    body: `<p>This is <b>AX-1</b>, the lab's own open robot. Its head is a <b>phone</b>: the screen is its face, the camera and motion sensors are its senses, and the phone's chip does the thinking.</p><p>The rest is simple, open parts: a printed body, a few bus servos and a small ESP32 board. Everything is <b>CC0</b>, so you can check every part.</p>`,
    actions: [{ id: "wake", label: "Wake AX-1" }, { id: "look", label: "Look around" }],
    build({ animate }) {
      const group = new THREE.Group();
      const rig = model("ax1-desk", 7);
      group.add(at(pad("accent", 0.85), 0, 0, 0.2), at(pick(rig.group, "wake"), 0, 0.06, 0.2));
      let woke = false;
      return {
        group, pickables: [rig.group],
        async act(id) {
          if (id === "look") {
            for (const pan of [-55, 45, 0]) {
              rig.face.setLook(-pan / 55, 0);
              await poseTo(animate, rig, { head_pan: pan }, 420);
            }
            rig.face.setLook(0, 0);
            return "AX-1 turned its neck servo left, right and back. The eyes follow, because the face is drawn live on the phone.";
          }
          rig.face.setMood("happy");
          await poseTo(animate, rig, { r_shoulder: -150, r_elbow: -30, head_tilt: 12 }, 420);
          for (let i = 0; i < 2; i++) {
            await poseTo(animate, rig, { r_elbow: -80 }, 220);
            await poseTo(animate, rig, { r_elbow: -30 }, 220);
          }
          await poseTo(animate, rig, { r_shoulder: 0, r_elbow: -20, head_tilt: 0 }, 420);
          rig.face.setMood("idle");
          const first = !woke;
          woke = true;
          return first ? "Hello. I am AX-1. My brain is the phone; my body is open parts. Show me the part, and I will tell you what it does." : "Let me try that again. Same wave, same two servos.";
        },
        update: (dt, t) => {
          rig.update(dt, t);
          if (dt) rig.set("torso_yaw", Math.sin(t * 0.5) * 12);
        },
        dispose: () => disposeFace(rig),
      };
    },
  },
  {
    number: "02", kicker: "Sensing", title: "How a robot senses",
    body: `<p>A robot only knows what its sensors tell it. AX-1 borrows two from the phone:</p><ul><li>the <b>camera</b>: a picture of what is in front of it;</li><li>the <b>IMU</b> (motion sensor): which way is down and how fast it is turning.</li></ul><p>The numbers are noisy, so a robot reads them many times a second and trusts the trend.</p>`,
    actions: [{ id: "camera", label: "Use the camera" }, { id: "tilt", label: "Tilt the phone" }],
    build({ animate }) {
      const group = new THREE.Group();
      const holder = new THREE.Group();
      const face = phoneFace({ w: 512, h: 248 });
      const ph = phone({ face: face.texture, landscape: true });
      ph.scale.setScalar(9);
      holder.add(at(ph, 0, 0, 0));
      group.add(at(pad("sky", 0.7), -0.7, 0, 0.5), at(holder, -0.7, 0.9, 0.5));
      group.add(at(cyl(0.05, 0.05, 0.8, "alu", 16), -0.7, 0.45, 0.38));
      // the camera's view: a thin wire cone pointing away from the phone's back
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.6, 4, 1, true), new THREE.MeshBasicMaterial({ color: 0x4f7ea8, wireframe: true, transparent: true, opacity: 0.5 }));
      cone.rotation.x = Math.PI / 2;
      cone.position.set(0, 0, -0.8);
      cone.visible = false;
      holder.add(cone);
      const cubeObj = at(rbox(0.28, 0.28, 0.28, "sun", 0.04), -0.55, 0.14, -1.4);
      group.add(cubeObj);
      // IMU axes: x terracotta, y sage, z sky
      const axes = new THREE.Group();
      for (const [c, rot] of [["accent", [0, 0, -Math.PI / 2]], ["sage", [0, 0, 0]], ["sky", [Math.PI / 2, 0, 0]]]) {
        const a = new THREE.Group();
        a.add(at(cyl(0.018, 0.018, 0.5, c, 10), 0, 0.25, 0), at(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 12), mat(c)), 0, 0.55, 0));
        a.rotation.set(...rot);
        axes.add(a);
      }
      axes.visible = false;
      holder.add(axes);
      group.add(at(pad("sun", 0.5), 1.1, 0, 0.5));
      pick(ph, "tilt");
      pick(cubeObj, "camera");
      let tilt = 0;
      return {
        group, pickables: [ph, cubeObj],
        async act(id) {
          if (id === "camera") {
            axes.visible = false;
            holder.rotation.set(0, Math.PI, 0); // the camera is on the back of the phone
            cone.visible = true;
            face.setMood("alert");
            await animate(500, (k) => (cubeObj.position.y = 0.14 + Math.sin(k * Math.PI) * 0.4));
            face.setMood("idle");
            return "Camera: the yellow cube is inside the view cone. The phone sees pixels; finding the cube in them is the brain's job (next page).";
          }
          cone.visible = false;
          axes.visible = true;
          holder.rotation.y = 0;
          const to = (tilt = tilt ? 0 : 20);
          const from = holder.rotation.z;
          await animate(500, (k) => (holder.rotation.z = lerp(from, (to * Math.PI) / 180, k)));
          return to ? "IMU: roll 20°, pitch 0°. Gravity now points 20° off the phone's own down axis, so the robot knows it is leaning." : "IMU: roll 0°, pitch 0°. Level again.";
        },
        update: (dt, t) => {
          face.tick(t);
          if (dt) cubeObj.rotation.y = t * 0.6;
        },
        dispose: () => (face.texture.dispose(), cone.geometry.dispose(), cone.material.dispose()),
      };
    },
  },
  {
    number: "03", kicker: "Deciding", title: "How a robot decides",
    body: `<p>The <b>phone</b> is the brain: it looks at the sensors and decides where each joint should go. It sends those targets over <b>Bluetooth (BLE)</b> about 30 times a second.</p><p>A small <b>ESP32 bridge</b> board turns targets into servo commands and owns the fast loop. It also owns safety: if the phone goes quiet, the bridge <b>holds</b> the robot still.</p>`,
    actions: [{ id: "send", label: "Send a command" }, { id: "quiet", label: "Phone goes quiet" }],
    build({ animate }) {
      const group = new THREE.Group();
      const face = phoneFace({ w: 256, h: 512 });
      const ph = phone({ face: face.texture });
      ph.scale.setScalar(8);
      ph.rotation.x = -0.35;
      const bridgeBoard = new THREE.Group();
      bridgeBoard.add(at(rbox(0.6, 0.04, 0.46, "sky", 0.01), 0, 0.02, 0), at(rbox(0.18, 0.05, 0.24, "alu", 0.01), -0.14, 0.06, 0), at(rbox(0.1, 0.05, 0.1, "graphite", 0.01), 0.16, 0.06, 0.1));
      const servoBox = new THREE.Group();
      servoBox.add(at(rbox(0.45, 0.32, 0.24, "servo", 0.03), 0, 0.16, 0), at(cyl(0.09, 0.09, 0.04, "alu", 24), 0.11, 0.34, 0));
      const horn = at(rbox(0.32, 0.03, 0.06, "shell", 0.012), 0.11, 0.37, 0);
      servoBox.add(horn);
      const lamp = at(sphere(0.07, "sage"), 0, 0.12, 0.27);
      bridgeBoard.add(lamp);
      group.add(at(pad("accent", 0.5), -1.3, 0, 0.2), at(ph, -1.3, 0.75, 0.2), at(pad("sky", 0.5), 0, 0, 0.2), at(bridgeBoard, 0, 0.06, 0.2), at(pad("sun", 0.5), 1.3, 0, 0.2), at(servoBox, 1.3, 0.06, 0.2));
      const packet = at(sphere(0.07, "accent"), -1.3, 0.8, 0.2);
      const bus = at(sphere(0.06, "sun"), 0, 0.2, 0.2);
      packet.visible = bus.visible = false;
      group.add(packet, bus);
      pick(ph, "send");
      let angle = 0, held = false;
      return {
        group, pickables: [ph],
        async act(id) {
          if (id === "quiet") {
            face.setMood("idle");
            await animate(400, () => {});
            held = true;
            lamp.material = mat("accent");
            return "250 ms with no valid command: the bridge holds every servo where it is and latches STOP. It never starts moving again by itself: you re-arm with a gesture.";
          }
          if (held) {
            held = false;
            lamp.material = mat("sage");
          }
          face.setMood("alert");
          await travel(animate, packet, [[-1.3, 0.9, 0.2], [-0.65, 1.2, 0.2], [0, 0.3, 0.2]], 520);
          await travel(animate, bus, [[0.1, 0.12, 0.2], [0.7, 0.12, 0.2], [1.3, 0.3, 0.2]], 380);
          const from = angle;
          angle = angle ? 0 : 1.2;
          await animate(360, (k) => (horn.rotation.y = lerp(from, angle, k)));
          face.setMood("idle");
          return `Phone → BLE → bridge → servo bus: the servo turned to ${angle ? "70°" : "0°"}. The phone decides what; the bridge decides how fast and how safely.`;
        },
        update: (dt, t) => face.tick(t),
        dispose: () => face.texture.dispose(),
      };
    },
  },
  {
    number: "04", kicker: "Moving", title: "How a robot moves",
    body: `<p>Each joint is a <b>bus servo</b>: a motor, a gearbox and a position sensor in one box. All six servos of this <b>SO-101</b> arm share one cable, the <b>bus</b>, and each has its own ID.</p><p>Safety rule of the lab: <b>STOP holds, it never drops</b>. The servos stay powered at their present position, so the arm stays in the air instead of falling on your desk.</p>`,
    actions: [{ id: "move", label: "Move the arm" }, { id: "stop", label: "STOP" }, { id: "arm", label: "Re-arm" }],
    build({ animate }) {
      const group = new THREE.Group();
      const rig = model("so101", 6);
      const lamp = at(cyl(0.12, 0.14, 0.12, "sage", 24), 1.25, 0.06, 0.9);
      group.add(at(pad("accent", 0.85), 0, 0, 0), at(pick(rig.group, "move"), 0, 0.06, 0), at(pad("sage", 0.3), 1.25, 0, 0.9), pick(lamp, "stop"));
      const POSES = [
        { shoulder_pan: 40, shoulder_lift: 35, elbow_flex: 50, wrist_flex: 40, gripper: 20 },
        { shoulder_pan: -45, shoulder_lift: 20, elbow_flex: 70, wrist_flex: 30, gripper: 90 },
      ];
      let n = 0, stopped = false;
      return {
        group, pickables: [rig.group, lamp],
        async act(id) {
          if (id === "stop") {
            if (stopped) return "STOP is already latched. The arm is holding its pose.";
            stopped = true;
            lamp.material = mat("accent");
            await animate(300, (k) => (lamp.position.y = 0.06 - Math.sin(k * Math.PI) * 0.04));
            return "STOP: every servo holds its present position. The arm stays exactly where it was; nothing drops. Press Re-arm to move again.";
          }
          if (id === "arm") {
            if (!stopped) return "Already armed. Move the arm, then try STOP.";
            stopped = false;
            lamp.material = mat("sage");
            return "Re-armed by you. The arm never resumes on its own after a STOP.";
          }
          if (stopped) return "STOP is latched: re-arm first. A robot should not move again until a person says so.";
          const p = POSES[n++ % POSES.length];
          await poseTo(animate, rig, p, 900);
          return `Moved: pan ${p.shoulder_pan}°, lift ${p.shoulder_lift}°, elbow ${p.elbow_flex}°, wrist ${p.wrist_flex}°. Six servos, one bus cable, one target each.`;
        },
      };
    },
  },
  {
    number: "05", kicker: "Testing", title: "Test before you build",
    body: `<p>Every robot in the lab has <b>missions</b> on the <b>Workbench</b>: three levels, scored by a simulation that runs in your browser. Pass, fail and time are plain numbers.</p><p>In the <b>Proving Grounds</b> you pilot the SO-101 twin to move a cell into a dock. Those runs are replayed by a verifier, not self-reported, and can be played on a real arm with Robot Link.</p>`,
    actions: [{ id: "run", label: "Run the mission" }, { id: "bad", label: "Try a bad plan" }],
    build({ animate }) {
      const group = new THREE.Group();
      const S = 6;
      const rig = model("so101", S);
      group.add(at(pad("accent", 0.6), -0.9, 0, 0), at(rig.group, -0.9, 0.06, 0));
      // where the gripper tip is for a pose, in the diorama's frame
      const tip = at(new THREE.Object3D(), 0, 0.1, 0);
      rig.joints.wrist_roll.node.add(tip);
      const tipAt = (pose) => {
        rig.pose(pose);
        group.updateMatrixWorld(true);
        return group.worldToLocal(tip.getWorldPosition(new THREE.Vector3()));
      };
      const PICK = { shoulder_pan: -20, shoulder_lift: 40, elbow_flex: 60, wrist_flex: 80 };
      const DROP = { shoulder_pan: 60, shoulder_lift: 40, elbow_flex: 60, wrist_flex: 80 };
      const LIFT = { shoulder_lift: 10, elbow_flex: 70, wrist_flex: 90 };
      const pPick = tipAt(PICK), pDrop = tipAt(DROP);
      rig.home();
      const CELLS = 0.03 * S;
      const cellObj = at(rbox(CELLS, CELLS, CELLS, "sun", 0.02), pPick.x, 0.06 + CELLS / 2, pPick.z);
      const dock = at(torus(0.24, 0.02, "sage"), pDrop.x, 0.065, pDrop.z);
      dock.rotation.x = Math.PI / 2;
      group.add(dock, cellObj);
      pick(cellObj, "run");
      const reset = () => (group.attach(cellObj), cellObj.position.set(pPick.x, 0.06 + CELLS / 2, pPick.z), cellObj.rotation.set(0, 0, 0));
      let runs = 0;
      return {
        group, pickables: [cellObj],
        async act(id) {
          reset();
          runs++;
          await poseTo(animate, rig, { ...PICK, gripper: 100, shoulder_lift: 20 }, 600);
          await poseTo(animate, rig, PICK, 350);
          if (id === "bad") {
            await poseTo(animate, rig, { shoulder_pan: 30 }, 400); // swept sideways with the jaws open
            const x0 = cellObj.position.x;
            await animate(350, (k) => ((cellObj.position.x = x0 + k * 0.5), (cellObj.rotation.z = -k * 1.4)));
            await poseTo(animate, rig, { shoulder_pan: 0, shoulder_lift: -30, elbow_flex: 90, wrist_flex: 60 }, 600);
            return `Run ${runs}: failed. The gripper swept sideways before closing and pushed the cell off. Noted: a logged failure is data too.`;
          }
          await poseTo(animate, rig, { gripper: 15 }, 250);
          rig.joints.wrist_roll.node.attach(cellObj);
          await poseTo(animate, rig, LIFT, 450);
          await poseTo(animate, rig, { ...DROP, shoulder_lift: 20 }, 650);
          await poseTo(animate, rig, DROP, 300);
          await poseTo(animate, rig, { gripper: 100 }, 200);
          group.attach(cellObj);
          cellObj.position.y = 0.06 + CELLS / 2;
          cellObj.rotation.set(0, cellObj.rotation.y, 0);
          await poseTo(animate, rig, { shoulder_pan: 0, shoulder_lift: -30, elbow_flex: 90, wrist_flex: 60 }, 600);
          return `Run ${runs}: passed. The cell is in the dock. In the Proving Grounds a run like this is replayed by the verifier before it counts.`;
        },
      };
    },
  },
  {
    number: "06", kicker: "Building", title: "Build your AX-1",
    body: `<p>One phone brain, three open bodies:</p><ul><li><b>Rover</b>: two wheels and a pan/tilt head. The first build.</li><li><b>Desk</b>: a neck and two small arms.</li><li><b>Walker</b>: a 12–13 servo biped. Roadmap.</li></ul><p>The firmware is experimental and untested on hardware until our first build. Every part is listed with its open source.</p>`,
    actions: [{ id: "rover", label: "Rover" }, { id: "desk", label: "Desk" }, { id: "walker", label: "Walker" }, { id: "apart", label: "Take it apart" }],
    build({ animate }) {
      const group = new THREE.Group();
      const SCALE = { rover: 7, desk: 7, walker: 5.5 };
      const bodies = Object.fromEntries(Object.keys(SCALE).map((k) => [k, model(`ax1-${k}`, SCALE[k])]));
      group.add(at(pad("accent", 0.9), 0, 0, 0.2));
      for (const [k, rig] of Object.entries(bodies)) {
        group.add(at(pick(rig.group, "apart"), 0, 0.06, 0.2));
        rig.group.visible = k === "rover";
      }
      let shown = "rover", apart = false;
      const INFO = {
        rover: "AX-1 Rover: two geared DC motors, two head servos, the ESP32 bridge and a 2S battery. Status: design; the twin drives it in Phone Brain.",
        desk: "AX-1 Desk: seven STS3215 bus servos for the neck and arms. Status: design. It looks, points and waves in the twin.",
        walker: "AX-1 Walker: 12–13 bus servos. Status: roadmap. Walking needs a learned policy, and it ships only when one runs in sim and on a real unit.",
      };
      return {
        group, pickables: Object.values(bodies).map((r) => r.group),
        async act(id) {
          const rig = bodies[shown];
          if (id === "apart") {
            const from = rig.explode, to = apart ? 0 : 1;
            apart = !apart;
            await animate(600, (k) => rig.setExplode(lerp(from, to, k)));
            return apart ? `Exploded view: ${[...new Set(rig.parts.map((p) => p.label))].join(", ")}.` : "Back together. Same parts, nothing hidden.";
          }
          if (apart) rig.setExplode(0), (apart = false);
          if (id !== shown) {
            await animate(200, (k) => rig.group.scale.setScalar(Math.max(0.001, rig.group.scale.x * (1 - k))));
            rig.group.visible = false;
            rig.group.scale.setScalar(SCALE[shown]);
            const next = bodies[id];
            const s = SCALE[id];
            next.group.visible = true;
            next.group.scale.setScalar(0.001);
            await animate(300, (k) => next.group.scale.setScalar(Math.max(0.001, s * k)));
            shown = id;
          }
          return INFO[id];
        },
        update: (dt, t) => {
          const rig = bodies[shown];
          rig.update(dt, t);
          if (dt) rig.set("head_pan", Math.sin(t * 0.7) * 25);
        },
        dispose: () => Object.values(bodies).forEach(disposeFace),
      };
    },
  },
  {
    number: "07", kicker: "On-chain", title: "Agents on-chain",
    body: `<p>An <b>agent (NFT)</b> is a collectible robot with its own wallet and a record of verified lab missions, failures included.</p>`,
    actions: [{ id: "wallet", label: "Show its wallet" }, { id: "record", label: "Log a mission" }, { id: "manual", label: "Manual mode" }],
    build({ animate }) {
      const group = new THREE.Group();
      const rig = model("ax1-rover", 6);
      group.add(at(pad("accent", 0.6), -0.8, 0, 0.5), at(pick(rig.group, "record"), -0.8, 0.06, 0.5));
      const wallet = new THREE.Group();
      wallet.add(at(rbox(0.6, 0.38, 0.14, "sage", 0.05), 0, 0.19, 0), at(rbox(0.62, 0.12, 0.16, "graphite", 0.03), 0, 0.3, 0.0));
      wallet.visible = false;
      group.add(at(wallet, 0.1, 0.06, 0.95));
      const bubble = at(rbox(0.36, 0.24, 0.06, "shell", 0.06), -0.8, 1.55, 0.5);
      bubble.add(at(sphere(0.035, "ink"), -0.09, 0, 0.04), at(sphere(0.035, "ink"), 0, 0, 0.04), at(sphere(0.035, "ink"), 0.09, 0, 0.04));
      bubble.visible = false;
      group.add(bubble, at(rbox(0.7, 0.06, 0.7, "paper2", 0.02), 1.1, 0.03, -0.2));
      const stack = [];
      let runs = 0, fails = 0;
      return {
        group, pickables: [rig.group],
        async act(id) {
          bubble.visible = false;
          if (id === "wallet") {
            if (!wallet.visible) {
              wallet.visible = true;
              wallet.scale.setScalar(0.001);
              await animate(380, (k) => wallet.scale.setScalar(Math.max(0.001, k)));
            }
            return "Its wallet: an Ethereum address that belongs to the agent, not to a person.";
          }
          if (id === "manual") {
            bubble.visible = true;
            await animate(300, (k) => (bubble.position.y = 1.45 + k * 0.1));
            return "Manual: the agent only proposes (the bubble); nothing happens until you approve.";
          }
          if (stack.length >= 10) stack.splice(0).forEach((b) => group.remove(b));
          const ok = runs % 3 !== 2;
          runs++;
          if (!ok) fails++;
          const b = rbox(0.5, 0.14, 0.5, ok ? "sage" : "accent", 0.03);
          const y = 0.13 + stack.length * 0.16;
          group.add(at(b, 1.1, y + 1.2, -0.2));
          stack.push(b);
          await animate(380, (k) => (b.position.y = y + 1.2 * (1 - k)), (t) => t * t);
          return `${ok ? "Mission passed" : "Mission failed (logged)"} · runs ${runs}, failures ${fails}. The record keeps both: an honest robot is more useful than a lucky one.`;
        },
        update: (dt, t) => rig.update(dt, t),
        dispose: () => disposeFace(rig),
      };
    },
  },
];
