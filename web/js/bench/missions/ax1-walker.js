// AX-1 Walker balance missions: 12 leg servos, the phone high on the head. Lab model, see biped.js; masses are estimates.
import { makeBipedMission } from "./biped.js";

export const mission = makeBipedMission({
  id: "ax1-walker",
  arms: false,
  geometry: { shank: 0.1, thigh: 0.088, heel: 0.032, toe: 0.056, hw: 0.042, footW: 0.05, torso: 0.1, shoulder: 0, arm: 0, mShank: 0.07, mThigh: 0.1, mPelvis: 0.15, mTorso: 0.35, mArm: 0 },
});
export default mission;
