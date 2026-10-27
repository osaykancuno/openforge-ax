// Workbench text: figure titles, stage captions, spec chips and "The big idea" for every robot. Pure data.
// Facts here match web/js/models/robot-specs.js (from docs/research/open-robot-catalog.md); stage chips describe the model.

export const ORDER = ["so101", "rover", "hound", "hand", "spider", "drone", "fab", "replicant", "ax1-rover", "ax1-desk", "ax1-walker"];

export const STAGE_IDS = ["assemble", "apart", "sensors", "brain", "move", "test", "build"];

/** Default stage titles; a robot can rename one (e.g. the drone "Unfold"). */
const TITLES = { assemble: "Assemble", apart: "Take it apart", sensors: "Sensors", brain: "Brain", move: "Move", test: "Test", build: "Build it" };

const R = {
  so101: {
    fig: "ARM",
    sensorNote: "each servo reports angle, load, speed, voltage",
    title: "The robot arm",
    chips: { JOINTS: "6", SERVOS: "6 × STS3215", BUS: "1 wire, daisy-chained", REACH: "≈ 35 cm" },
    captions: {
      assemble: "Six bus servos, stacked from the base clamp to the gripper, make a desk-sized arm.",
      apart: "Every link is a printed part with one servo: base, shoulder, upper arm, forearm, wrist and jaw.",
      sensors: "The servos are the sensors too: each one reports its angle, load, speed and voltage on the bus.",
      brain: "A PC (or a phone over USB) reads the angles, decides, and writes new targets to all six servos.",
      move: "Inverse kinematics turns “put the tip there” into six angles: reach, grasp, lift, place.",
      test: "Three lab missions: reach a marker, pick and place a cube, stack two cubes.",
      build: "The real thing: the SO-101 from TheRobotStudio, the reference arm of Hugging Face LeRobot.",
    },
    stageChips: {
      apart: { PARTS: "6 links + clamp" },
      sensors: { FEEDBACK: "angle · load · speed · V" },
      brain: { LOOP: "read → decide → write" },
      move: { IK: "x y z → 6 angles" },
    },
    bigIdea: "An arm is a chain of joints. Forward kinematics adds up the angles to find the tip; inverse kinematics runs the sum backwards to find the angles for a tip you want. Everything else, from grasping to teleoperation, is built on that one round trip.",
  },
  rover: {
    fig: "ROVER",
    title: "The phone on wheels",
    chips: { WHEELS: "4", DRIVE: "differential", BRAIN: "your phone", MCU: "Arduino Nano" },
    captions: {
      assemble: "A printed chassis, four gear motors, a battery and a phone mount: that is the whole car.",
      apart: "The phone does the thinking; the small board only turns its commands into motor power.",
      sensors: "All the sensing is in the phone: camera, IMU, GPS. The car itself has almost none.",
      brain: "Camera frame → phone app → speed for the left and right wheels, many times a second.",
      move: "No steering wheel: turn by spinning the left and right wheels at different speeds.",
      test: "Three lab missions: drive to a cone, run a slalom, park in a box using the phone's camera.",
      build: "The real thing: OpenBot, the open smartphone-brain car.",
    },
    stageChips: {
      sensors: { SENSORS: "in the phone" },
      brain: { LINK: "USB serial" },
      move: { TURN: "left ≠ right speed" },
    },
    bigIdea: "A modern phone already has a better camera, IMU and computer than most hobby robots. Give it wheels and a tiny motor board, and the phone becomes the robot's brain: the cheapest serious robot you can build.",
  },
  hound: {
    fig: "QUADRUPED",
    title: "The robot dog",
    chips: { LEGS: "4", ACTUATORS: "12 (3 per leg)", BRAIN: "onboard computer", GAIT: "trot" },
    captions: {
      assemble: "Four legs with three joints each hang under a box that holds the battery and the computer.",
      apart: "Hip, thigh and knee: a leg is a small arm that pushes on the ground instead of grabbing.",
      sensors: "A camera looks ahead; an IMU in the body feels which way is down.",
      brain: "The computer turns “go forward” into twelve joint angles, 50 or more times a second.",
      move: "Trot: diagonal legs move together, so two feet are always on the ground.",
      test: "Three lab missions: stand up, trot one metre, turn on the spot.",
      build: "The real thing: Petoi Bittle X (OpenCat) to buy, or the Stanford Pupper family.",
    },
    stageChips: {
      apart: { LEG: "hip · thigh · knee" },
      move: { PAIRS: "FL+BR · FR+BL" },
    },
    bigIdea: "Walking is falling, caught in time. A trot keeps the body on a diagonal pair of feet while the other pair swings forward; speed is stride times cadence, and the legs' reach sets the limit.",
  },
  hand: {
    fig: "HAND",
    title: "The robot hand",
    chips: { FINGERS: "4 + thumb", SERVOS: "8 micro", DRIVE: "servo per joint pair" },
    captions: {
      assemble: "A palm on a wrist pack: the servos sit low, so the fingers stay light.",
      apart: "Each finger has two segments; the thumb swings across to oppose them.",
      sensors: "Servo load tells the hand when a finger touches something; fingertip sensors are optional.",
      brain: "A bus board reads every finger and sends new targets; the host decides the grasp.",
      move: "Open, wrap, pinch, count: a handful of curl values make every grip.",
      test: "Three lab missions: pinch, power grasp, count to three.",
      build: "The real thing: AmazingHand from Pollen Robotics and Hugging Face.",
    },
    stageChips: {
      sensors: { TOUCH: "from servo load" },
      move: { GRIPS: "pinch · power · count" },
    },
    bigIdea: "A hand is many tiny arms that share one goal. Most everyday grips need only a few patterns: the power grasp wraps everything, the pinch uses thumb and index, and the rest is timing.",
  },
  spider: {
    fig: "HEXAPOD",
    title: "The six-legged walker",
    chips: { LEGS: "6", SERVOS: "18 micro", GAIT: "tripod", BRAIN: "microcontroller" },
    captions: {
      assemble: "Two hexagonal plates, six legs, eighteen small servos: no balancing needed.",
      apart: "Each leg has a coxa (swing), a femur (lift) and a tibia (reach).",
      sensors: "A range sensor looks ahead; the gait itself needs no sensing at all.",
      brain: "A gait engine on the controller turns one walking command into eighteen angles.",
      move: "Tripod gait: legs 1-3-5 push while 2-4-6 swing, then they swap.",
      test: "Three lab missions: one tripod step, walk 50 cm, rotate in place.",
      build: "The real thing: Bob The Hexapod, an MIT-licensed design on a Raspberry Pi Pico.",
    },
    stageChips: {
      apart: { LEG: "coxa · femur · tibia" },
      move: { TRIPODS: "A 1·3·5 · B 2·4·6" },
    },
    bigIdea: "Three feet always make a stable triangle. A hexapod walks by keeping one tripod on the ground while the other swings, so it never has to balance: the easiest walking robot to get right.",
  },
  drone: {
    fig: "DRONE",
    title: "The quadcopter",
    titles: { assemble: "Unfold" },
    chips: { "ARMS OUT": "4", MOTORS: "4", PROPS: "2 CW + 2 CCW", BRAIN: "ESP32" },
    captions: {
      assemble: "Four arms, four motors, two pairs of props that spin in opposite directions.",
      apart: "A frame, a flight controller with an IMU, a small battery and four coreless motors.",
      sensors: "The IMU's gyro and accelerometer tell the controller how the frame is tilting, hundreds of times a second.",
      brain: "Gyro → flight controller → four motor speeds: the fastest control loop on the bench.",
      move: "Spin up: CW and CCW twists cancel. Tilt to move. Speed up one pair to turn.",
      test: "Three lab missions: hover at 1 m, yaw 90°, fly through a ring.",
      build: "The real thing: ESP-Drone by Espressif, with Crazyflie as the premium reference.",
    },
    stageChips: {
      sensors: { IMU: "gyro + accel" },
      brain: { LOOP: "IMU → motors" },
      move: { YAW: "CW vs CCW speed" },
    },
    bigIdea: "Every prop pushes air down and twists the frame the other way. With two props each way the twists cancel and the drone holds its heading; speed up one pair and the frame turns, without any change in total lift.",
  },
  fab: {
    fig: "PRINTER",
    title: "The 3D printer",
    chips: { AXES: "3 (X Y Z)", STEPPERS: "4", HOTEND: "1", BRAIN: "Klipper" },
    captions: {
      assemble: "An aluminium frame carries a moving bed, a gantry and a toolhead.",
      apart: "The bed moves front to back, the toolhead left to right, the gantry up and down.",
      sensors: "A thermistor reads the hotend; endstops tell each axis where zero is.",
      brain: "The mainboard turns G-code into step pulses and keeps the hotend at temperature.",
      move: "A layer is a path: the head draws it while plastic flows, 0.2 mm above the bed.",
      test: "Three lab missions: home the axes, print a square perimeter, nail the first layer.",
      build: "The real thing: the Voron 2.4, a fully open, community-built printer.",
    },
    stageChips: {
      sensors: { ZERO: "endstops" },
      move: { LAYER: "0.2 mm" },
    },
    bigIdea: "A printer is a robot that draws with hot plastic. It must know where zero is (homing), move along exact lines, and start with the nozzle the right distance from the bed: get the first layer right and the rest follows.",
  },
  replicant: {
    fig: "HUMANOID",
    title: "The small humanoid",
    chips: { "LEG JOINTS": "6 (3 per leg)", ARMS: "2 × 2", BRAIN: "phone or SBC", MODEL: "balance" },
    captions: {
      assemble: "A pelvis, a torso, two arms and two legs: a small biped built on bus servos.",
      apart: "Hips, knees and ankles carry the weight; the arms help balance and gesture.",
      sensors: "A camera and an IMU in the head tell the robot what it sees and which way is up.",
      brain: "The computer keeps the centre of mass over the feet while it moves the joints.",
      move: "Squat, shift the weight, lift a foot, wave: every pose keeps the COM over the support.",
      test: "Three lab missions: balance on the edge, squat, stand on one foot.",
      build: "The concept reference: PhoneBot from UCLA RoMeLa. Its CAD is non-commercial, so we link to it and build our own walker.",
    },
    stageChips: {
      sensors: { IMU: "in the head" },
      move: { RULE: "COM over the feet" },
    },
    bigIdea: "Standing still is a skill. A biped stays up only while its centre of mass is above the patch of ground under its feet; every pose, squat or step is planned around that one rule.",
  },
  "ax1-rover": {
    fig: "AX-1 ROVER",
    title: "AX-1 Rover",
    chips: { WHEELS: "2 + caster", SERVOS: "2 (neck)", BRAIN: "your phone", BRIDGE: "ESP32, BLE" },
    captions: {
      assemble: "Our first build: a printed body, two geared wheels and a phone head on a pan/tilt neck.",
      apart: "The ESP32 bridge drives the motors and the neck; the battery sits low for stability.",
      sensors: "Everything it senses comes from the phone: camera, IMU, microphone.",
      brain: "Phone → Bluetooth → ESP32 bridge → motors. The bridge holds safety: a lost link means stop.",
      move: "Two wheels, one turning rule: the faster wheel goes round the slower one. The head looks into the turn.",
      test: "Three lab missions: drive to a cone, run a slalom, park in a box using the phone's camera.",
      build: "Our own design, CC0. The firmware is experimental and untested on hardware until the first build.",
    },
    stageChips: {
      brain: { WATCHDOG: "250 ms → hold" },
      move: { TURN: "left ≠ right speed" },
    },
    bigIdea: "One brain, one bridge, many bodies. The phone sees and decides; a small ESP32 runs the motors and refuses anything unsafe. Swap the body and the same phone drives it.",
  },
  "ax1-desk": {
    fig: "AX-1 DESK",
    title: "AX-1 Desk",
    chips: { SERVOS: "7 × STS3215", NECK: "pan + tilt", ARMS: "2 × 2 DOF", BRAIN: "your phone" },
    captions: {
      assemble: "A desk companion: a round base, a turning torso, two arms and a phone for a face.",
      apart: "Seven bus servos on one wire: torso, neck pan and tilt, two shoulders, two elbows.",
      sensors: "The phone camera finds faces and objects; the servos report where every joint is.",
      brain: "Phone → Bluetooth → ESP32 bridge → servo bus, with limits stored in the bridge.",
      move: "Look, nod, wave, point: a few joints are enough to say a lot.",
      test: "Three lab missions: look at a target, wave, point at three objects in order.",
      build: "Our own design, CC0, about 7 servos and one driver board.",
    },
    stageChips: {
      brain: { LIMITS: "in the bridge" },
      move: { GESTURES: "look · wave · point" },
    },
    bigIdea: "A robot doesn't need legs to be useful company. Turning to look and pointing at things uses the same maths as an arm: angles add up to a direction.",
  },
  "ax1-walker": {
    fig: "AX-1 WALKER",
    title: "AX-1 Walker",
    chips: { SERVOS: "13 × STS3215", LEGS: "2 × 6 DOF", BRAIN: "your phone", STATUS: "balance only" },
    captions: {
      assemble: "The long-term build: a biped with six servos per leg and the phone high on its head.",
      apart: "Hip yaw, roll and pitch, knee, ankle pitch and roll, on each side, plus a torso yaw.",
      sensors: "The phone's IMU is the balance sensor; its camera looks ahead.",
      brain: "Phone → Bluetooth → ESP32 bridge → 13 servos. Walking itself needs a learned policy.",
      move: "Squat, shift onto one foot, look around: balance first, walking later.",
      test: "Three lab missions: balance on the edge, squat, stand on one foot.",
      build: "Our own design, CC0. It ships walking only when a policy runs in sim and on a real unit.",
    },
    stageChips: {
      sensors: { IMU: "the phone's" },
      move: { RULE: "COM over the feet" },
    },
    bigIdea: "A heavy phone high up makes balance harder, and that is the point: the same rule (keep the centre of mass over the feet) has to hold with a real, top-heavy body before any walking policy is worth training.",
  },
};

/** Stage list for a robot: [{ id, title, caption, chips: [[k, v]] }]. Chips accumulate from the base set. */
export function stagesFor(id) {
  const r = R[id];
  return STAGE_IDS.map((sid) => {
    const extra = r.stageChips?.[sid] || {};
    const chips = Object.entries({ ...r.chips, ...extra });
    if (sid === "test") chips.push(["LEVELS", "3"], ["SIM", "lab model"]);
    return { id: sid, title: r.titles?.[sid] || TITLES[sid], caption: r.captions[sid], chips };
  });
}
export const robotText = (id) => R[id];
