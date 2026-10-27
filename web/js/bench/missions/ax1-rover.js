// AX-1 Rover: two geared DC motors driven by the ESP32 bridge, the phone on a pan/tilt head. Lab sim, see drive.js.
import { makeDriveMission } from "./drive.js";

export const mission = makeDriveMission({ id: "ax1-rover", track: 0.17, vmax: 0.45, tau: 0.2, radius: 0.1 });
export default mission;
