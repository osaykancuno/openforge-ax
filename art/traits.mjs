// EXACT mirror of AgentRenderer.traitsOf / legendaryIds (same weights, same derivation).
// test/Traits.parity.js checks parity with the contract.
import { AbiCoder, keccak256 } from "ethers";

export const WEIGHTS = {
  class: [1500, 1200, 900, 900, 800, 700, 500, 400, 1400, 1100, 600],
  core: [5500, 3000, 1200, 300],
  sensor: [4000, 3000, 1800, 1000, 200],
  finish: [2600, 2000, 1600, 1400, 1100, 900, 400],
  district: [2500, 2200, 1900, 1500, 1200, 700],
  faction: [3000, 2400, 2000, 1600, 1000],
  augment: [3500, 2000, 1500, 1300, 1100, 600],
};

export const NAMES = {
  class: ["Synth Arm", "Street Rover", "Cyber Hound", "Ghost Hand", "Spider Mech", "Sky Drone", "Fab Rig", "Replicant", "AX-1 Rover", "AX-1 Desk", "AX-1 Walker"],
  core: ["VLA-Base", "VLA-Tuned", "VLA-Prime", "VLA-Genesis"],
  sensor: ["Optic", "Stereo Depth", "Haptic", "Lidar Halo", "Omni Array"],
  finish: ["Blacksteel", "Ghost White", "Hazard Orange", "Ice Cobalt", "Toxic Green", "Blood Red", "Holo Chrome"],
  frame: ["Mk-I", "Mk-II", "Mk-III", "Mk-IV"],
  district: ["Neon Bazaar", "Rust Docks", "Undergrid", "Chrome Spire", "Data Shrine", "Orbital Yard"],
  faction: ["Free Units", "Forge Syndicate", "Helix Corp", "Null Collective", "Ghost Union"],
  augment: ["None", "Antenna Array", "Holo Halo", "Cable Spine", "Visor Band", "Exhaust Vents"],
};

export const PREFIX = ["Neon", "Static", "Chrome", "Ghost", "Rust", "Volt", "Null", "Hex", "Cipher", "Razor", "Vapor", "Iron", "Glitch", "Echo", "Nova", "Onyx", "Flux", "Pulse", "Shadow", "Quartz", "Solar", "Toxic", "Binary", "Carbon", "Ion", "Lumen", "Mirage", "Nitro", "Omega", "Proxy", "Sable", "Zero"];
export const SUFFIX = ["Kestrel", "Jackal", "Mantis", "Viper", "Raven", "Lynx", "Wolf", "Moth", "Hornet", "Cobra", "Falcon", "Orca", "Shrike", "Fox", "Heron", "Wasp", "Panther", "Scorpion", "Owl", "Hydra", "Mamba", "Condor", "Gecko", "Badger", "Marlin", "Spider", "Tiger", "Vulture", "Coyote", "Beetle", "Puma", "Dragonfly"];
export const LEGENDARY = ["RONIN", "ORACLE", "MOTHER", "WRAITH", "SAINT", "KAIJU", "ECHO ZERO", "VANTA", "HALCYON", "GODMODE"];

const coder = AbiCoder.defaultAbiCoder();

function roll(seed, id, k) {
  const h = keccak256(coder.encode(["bytes32", "uint256", "uint8"], [seed, id, k]));
  return Number(BigInt(h) % 10000n);
}

function pick(r, weights) {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}

/** Unique callsign: affine permutation of 0..1023 (mirror of AgentRenderer.nameIndex). */
export function nameIndex(seed, id) {
  const a = (BigInt(keccak256(coder.encode(["bytes32", "string"], [seed, "NAME_A"]))) % 512n) * 2n + 1n;
  const b = BigInt(keccak256(coder.encode(["bytes32", "string"], [seed, "NAME_B"]))) % 1024n;
  return Number((a * BigInt(id - 1) + b) % 1024n);
}

export function legendaryIds(seed, supply) {
  const count = Math.min(10, Math.floor(supply / 50));
  const ids = [];
  let nonce = 0n;
  while (ids.length < count) {
    const h = keccak256(coder.encode(["bytes32", "string", "uint256"], [seed, "LEGEND", nonce++]));
    const c = Number(BigInt(h) % BigInt(supply)) + 1;
    if (!ids.includes(c)) ids.push(c);
  }
  return ids;
}

/** Raw traits (indices). `legendaries` = legendaryIds output (pass it in for efficiency). */
export function traitsOf(seed, id, legendaries = []) {
  return {
    class: pick(roll(seed, id, 0), WEIGHTS.class),
    core: pick(roll(seed, id, 1), WEIGHTS.core),
    sensor: pick(roll(seed, id, 2), WEIGHTS.sensor),
    finish: pick(roll(seed, id, 3), WEIGHTS.finish),
    frame: Math.floor(roll(seed, id, 4) / 2500),
    district: pick(roll(seed, id, 5), WEIGHTS.district),
    faction: pick(roll(seed, id, 6), WEIGHTS.faction),
    augment: pick(roll(seed, id, 7), WEIGHTS.augment),
    prefix: Math.floor(nameIndex(seed, id) / 32),
    suffix: nameIndex(seed, id) % 32,
    legendary: legendaries.indexOf(id) + 1,
  };
}

/** Human-readable attributes, as in the on-chain tokenURI. */
export function describe(t) {
  const L = t.legendary > 0;
  return {
    name: L ? LEGENDARY[t.legendary - 1] : `${PREFIX[t.prefix]} ${SUFFIX[t.suffix]}`,
    Class: NAMES.class[t.class],
    "Core Model": L ? "VLA-Genesis" : NAMES.core[t.core],
    Sensor: NAMES.sensor[t.sensor],
    Finish: L ? "24K Circuit" : NAMES.finish[t.finish],
    Frame: NAMES.frame[t.frame],
    District: L ? "The Forge Core" : NAMES.district[t.district],
    Faction: L ? "Prime Constructs" : NAMES.faction[t.faction],
    Augment: L ? "Crown Halo" : NAMES.augment[t.augment],
    ...(L ? { "1/1": LEGENDARY[t.legendary - 1] } : {}),
  };
}
