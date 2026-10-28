// AR Quick Look (iPhone, iPad): Apple's own AR viewer, free and built into iOS, stands the twin on your real floor at
// its real size with ARKit's tracking (walk around it, look under it). Safari has no WebXR AR, so this is how an iPhone
// gets true floor placement; driving stays in the camera view (Quick Look shows a model, it runs no page code).
// The model is made here, in the browser, from the same 3D twin the page draws: no file is downloaded or uploaded.
import * as THREE from "three";
import { disposeObject } from "../models/look.js";
import { buildRobot, bounds } from "../models/robots.js";

/** True where an `<a rel="ar">` link opens AR Quick Look (Safari and every browser on iPhone and iPad). Never throws. */
export function quickLookSupported(doc = globalThis.document) {
  try {
    return !!doc?.createElement("a").relList?.supports?.("ar");
  } catch {
    return false;
  }
}

const cache = new Map(); // body -> Promise<blob URL>

/**
 * usdzUrl(body) -> Promise<string>: a blob URL of the AX-1 `body` ("rover" | "desk" | "walker") as a USDZ model, in
 * metres, its lowest point on the floor, anchored to a horizontal plane. Made once per body; a failure is not cached.
 */
export function usdzUrl(body) {
  if (!cache.has(body)) {
    const job = (async () => {
      // loaded only here: phones without Quick Look never download the exporter
      const { USDZExporter } = await import("three/addons/exporters/USDZExporter.js");
      const rig = buildRobot(`ax1-${body}`);
      try {
        rig.update?.(0, 0); // the rest pose
        const scene = new THREE.Scene();
        scene.add(rig.group);
        rig.group.position.y -= bounds(rig).min.y; // stand on the floor (the Desk and Walker origins are not at their soles)
        // USDZ only knows lit (standard) materials: the unlit phone screen (the face) becomes a standard material that
        // glows with its own picture, or Quick Look would drop it and show a faceless robot. Only this rig's copy changes.
        rig.group.traverse((o) => {
          if (!o.isMesh || !o.material?.isMeshBasicMaterial) return;
          const m = o.material;
          o.material = new THREE.MeshStandardMaterial({ color: 0x000000, map: m.map, emissive: 0xffffff, emissiveMap: m.map, roughness: 0.35, metalness: 0, transparent: m.transparent, opacity: m.opacity });
        });
        scene.updateMatrixWorld(true);
        const data = await new USDZExporter().parse(scene, { quickLookCompatible: true, ar: { anchoring: { type: "plane" }, planeAnchoring: { alignment: "horizontal" } } });
        return URL.createObjectURL(new Blob([data], { type: "model/vnd.usdz+zip" }));
      } finally {
        disposeObject(rig.group);
      }
    })();
    job.catch(() => cache.delete(body));
    cache.set(body, job);
  }
  return cache.get(body);
}

/**
 * openQuickLook(link, url, body): opens Quick Look through the page's own `<a rel="ar">` (it must hold an <img>, or
 * Safari downloads the file instead). Call it in the tap, with the URL already made, so Safari treats it as the
 * person's own gesture.
 */
export function openQuickLook(link, url, body) {
  link.setAttribute("href", `${url}#allowsContentScaling=0`); // real size: no pinch to resize
  link.setAttribute("download", `ax1-${body}.usdz`); // a blob URL has no file name; Quick Look reads the type from it
  link.click();
}
