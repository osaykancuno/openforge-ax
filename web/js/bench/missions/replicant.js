// Replicant (small open humanoid) balance missions. Lab model, see biped.js. Masses are lab estimates, not measured.
import { makeBipedMission } from "./biped.js";

export const mission = makeBipedMission({
  id: "replicant",
  arms: true,
  geometry: { shank: 0.11, thigh: 0.11, heel: 0.025, toe: 0.045, hw: 0.03, footW: 0.04, torso: 0.065, shoulder: 0.11, arm: 0.135, mShank: 0.04, mThigh: 0.05, mPelvis: 0.06, mTorso: 0.4, mArm: 0.06 },
});
export default mission;
