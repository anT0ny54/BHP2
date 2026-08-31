"use strict";

const sharp = require("sharp");

function compress(
  input,
  useWebp,
  grayscale,
  quality,
  originalSize,
  maxWidth
) {
  const format = useWebp ? "webp" : "jpeg";
  let pipeline = sharp(input, {
    failOn: "none",
    limitInputPixels: 268402689,
  });

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

  const formatOptions = useWebp
    ? {
        quality,
        effort: 3,
        smartSubsample: true,
      }
    : {
        quality,
        progressive: true,
        mozjpeg: true,
        chromaSubsampling: "4:2:0",
      };

  return pipeline
    .toFormat(format, formatOptions)
    .toBuffer()
    .then((output) => ({
      err: null,
      output,
      headers: {
        "content-type": `image/${format}`,
        "content-length": String(output.length),
        "x-bh-original-size": String(originalSize),
        "x-bh-compressed-size": String(output.length),
        "x-bh-bytes-saved": String(originalSize - output.length),
      },
    }))
    .catch((err) => ({
      err,
      output: null,
      headers: {},
    }));
}

module.exports = compress;
