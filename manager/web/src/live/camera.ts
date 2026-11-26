// Opening the camera, with an explanation the user can act on when it is refused.

export type CameraProblem = "insecure" | "blocked" | "dismissed" | "missing" | "busy" | "other";

export class CameraError extends Error {
  constructor(message: string, readonly problem: CameraProblem) {
    super(message);
  }
}

const SITE_SETTINGS = "click the 🔒 (or camera) icon at the left of the address bar → Camera → Allow, then press “Ask again”";

/** The camera stream, or a CameraError saying why not and what to do. */
export async function openCamera(constraints: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } }): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(
      `The browser only gives the camera to secure pages: open this app at https://${location.hostname}:3443 (or on this computer at http://localhost:3000).`,
      "insecure",
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (failure) {
    const name = failure instanceof DOMException ? failure.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      let state: PermissionState | null = null;
      try { state = (await navigator.permissions.query({ name: "camera" as PermissionName })).state; } catch { /* not supported (Firefox, Safari) */ }
      if (state === "denied") {
        throw new CameraError(`Camera blocked for this site: the browser will not ask again by itself. To allow it, ${SITE_SETTINGS}.`, "blocked");
      }
      throw new CameraError("Camera permission refused: press “Ask again” and choose Allow in the browser's question.", "dismissed");
    }
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new CameraError("No camera found: connect one, then press “Ask again”.", "missing");
    if (name === "NotReadableError" || name === "AbortError") throw new CameraError("The camera is used by another application (or tab): close it, then press “Ask again”.", "busy");
    throw new CameraError(`Camera: ${failure instanceof Error ? failure.message : String(failure)}`, "other");
  }
}
