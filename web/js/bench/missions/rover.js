// Street Rover (OpenBot class): a phone on a 4-wheel differential base. Lab sim, see drive.js.
import { makeDriveMission } from "./drive.js";

export const mission = makeDriveMission({ id: "rover", track: 0.19, vmax: 0.6, tau: 0.15, radius: 0.11 });
export default mission;
