// Webcam access with health checks: notices when the camera disconnects, freezes or sends
// a black picture, so the page can explain the problem instead of showing a black box.

// Tried in order; a retry after a failure steps down to a lower resolution,
// which helps cameras that drop out at HD.
export const PROFILES = [
  { width: { ideal: 1280 }, height: { ideal: 720 } },
  { width: { ideal: 640 }, height: { ideal: 480 } },
];

export class Webcam {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.deviceId = null;
    this.profile = 0;
  }

  async start({ deviceId = this.deviceId, profile = this.profile } = {}) {
    this.stop();
    this.deviceId = deviceId;
    this.profile = profile;
    const video = { ...PROFILES[profile] };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = "user";
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.deviceId = this.stream.getVideoTracks()[0]?.getSettings().deviceId || deviceId;
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /**
   * Checks the camera once a second and calls onProblem("ended" | "no-frames" | "black")
   * after a problem lasts a few seconds. Returns a function that stops watching.
   */
  watch(onProblem) {
    const probe = document.createElement("canvas");
    probe.width = 16; probe.height = 9;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    let lastSum = -1, stalled = 0, black = 0, waiting = 0;

    const id = setInterval(() => {
      const track = this.stream?.getVideoTracks()[0];
      if (!track || track.readyState === "ended") return report("ended");
      if (this.video.readyState < 2) return ++waiting >= 5 ? report("no-frames") : undefined;
      waiting = 0;

      ctx.drawImage(this.video, 0, 0, probe.width, probe.height);
      const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
      let sum = 0, lum = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum = (sum * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) % 1e9;
        lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      lum /= (d.length / 4) * 255;

      black = lum < 0.03 ? black + 1 : 0;
      // Real camera images always change slightly (sensor noise); an identical picture means a frozen feed.
      stalled = track.muted || sum === lastSum ? stalled + 1 : 0;
      lastSum = sum;
      if (black >= 3) report("black");
      else if (stalled >= 4) report("no-frames");
    }, 1000);

    const stopWatching = () => clearInterval(id);
    function report(problem) {
      stopWatching();
      onProblem(problem);
    }
    return stopWatching;
  }
}

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(d => d.kind === "videoinput");
}

export function describeProblem(problem) {
  switch (problem) {
    case "ended":
      return "The camera disconnected. If the Windows Camera app also fails, the camera driver or hardware is at fault: update the camera driver, or use a USB webcam. Retrying uses a lower resolution.";
    case "no-frames":
      return "The camera stopped sending video. Close other apps that use the camera, then try again. Retrying uses a lower resolution.";
    case "black":
      return "The camera is sending a black picture. Open the camera's privacy shutter, or press the camera key on your keyboard (often F8 or Fn+F8), then try again.";
    default:
      return "The camera stopped working. Try again.";
  }
}

export function describeStartError(err) {
  if (!window.isSecureContext) {
    return "The camera only works on https:// pages or http://localhost. To use a phone on your Wi-Fi, " +
      "run \"python serve-https.py\" on the computer and open the https:// address it prints.";
  }
  if (err.name === "NotAllowedError") return "Camera permission was denied. Allow it in the address bar and try again.";
  if (err.name === "NotFoundError" || err.name === "OverconstrainedError") return "No camera found.";
  if (err.name === "NotReadableError") return "The camera is in use by another app, or Windows couldn't start it. Close other camera apps and try again.";
  return `Could not start: ${err.message || err}`;
}
