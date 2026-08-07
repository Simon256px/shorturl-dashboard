/**
 * QR codes as inline SVG.
 *
 * `qrcode-generator` is a zero-dependency encoder; we do the rendering here so
 * nothing pulls in a canvas or an image codec. SVG also scales cleanly to a
 * printed poster, which is the main reason anyone wants a QR code.
 */

import qrcode from "qrcode-generator";

export interface QrOptions {
  /** Pixels per module. 0 means "no fixed size", let CSS scale it. */
  scale?: number;
  /** Quiet-zone width in modules. The spec asks for 4; less hurts scanning. */
  margin?: number;
  dark?: string;
  light?: string;
}

export function qrSvg(text: string, opts: QrOptions = {}): string {
  const { scale = 8, margin = 4, dark = "#0f172a", light = "#ffffff" } = opts;

  // Type 0 = auto-select the smallest version that fits. "M" recovery level
  // tolerates ~15% damage, the usual choice for URLs on paper.
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + margin * 2;

  // One path with many subpaths beats thousands of <rect> elements: same
  // pixels, a fraction of the bytes.
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        d += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
  }

  const px = scale > 0 ? ` width="${size * scale}" height="${size * scale}"` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"${px}`,
    ` shape-rendering="crispEdges" role="img" aria-label="QR code">`,
    `<rect width="${size}" height="${size}" fill="${light}"/>`,
    `<path d="${d}" fill="${dark}"/>`,
    `</svg>`,
  ].join("");
}
