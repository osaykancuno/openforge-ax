// Mission registry for the Workbench: robot id → mission module. Pure (Node-importable for tests).
import so101 from "./so101.js";
import rover from "./rover.js";
import hound from "./hound.js";
import hand from "./hand.js";
import spider from "./spider.js";
import drone from "./drone.js";
import fab from "./fab.js";
import replicant from "./replicant.js";
import ax1Rover from "./ax1-rover.js";
import ax1Desk from "./ax1-desk.js";
import ax1Walker from "./ax1-walker.js";

export const MISSIONS = { so101, rover, hound, hand, spider, drone, fab, replicant, "ax1-rover": ax1Rover, "ax1-desk": ax1Desk, "ax1-walker": ax1Walker };
export { replay, standardScore, prng } from "./common.js";
