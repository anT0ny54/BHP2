"use strict";

const sharp = require("sharp");

async function compress(
  input,
  useWebp,
  grayscale,
  quality,
  originalSize,
  maxWidth = 0
) {
  try {
    const format = useWebp ? "webp" : "jpeg";

    let pipeline = sharp(input, {
      animated: false,
      failOn: "none",
    }).rotate();

    if (maxWidth > 0) {
      pipeline = pipeline.resize({
        width: maxWidth,
        fit: "inside",
        withoutEnlargement: true,
        fastShrinkOnLoad: true,
      });
    }

    if (grayscale) {
      pipeline = pipeline.grayscale();
    }

    if (useWebp) {
      pipeline = pipeline.webp({
        quality,
        effort: 4,
        smartSubsample: true,
      });
    } else {
      pipeline = pipeline.jpeg({
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: "4:2:0",
      });
    }

    const output = await pipeline.toBuffer();

    return {
      err: null,
      output,
      headers: {
        "content-type": `image/${format}`,
        "content-length": String(output.length),
        "x-original-size": String(originalSize),
        "x-compressed-size": String(output.length),
        "x-bytes-saved": String(originalSize - output.length),
      },
    };
  } catch (err) {
    return {
      err,
      output: null,
      headers: {},
    };
  }
}

module.exports = compress;
