import QRCode from "qrcode";

/**
 * QR codes are rendered to SVG on the SERVER and sent as markup. A phone camera
 * needs nothing but the picture, and generating it here keeps the encoder out
 * of the browser bundle — this is a page most people open once.
 */
export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    // Tight quiet zone: the card supplies its own padding, and the default
    // four-module margin wastes a third of the width at the size this renders at.
    margin: 1,
    // Medium recovery survives a phone screenshot and a bit of glare without
    // inflating the module count the way high recovery does.
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });
}
