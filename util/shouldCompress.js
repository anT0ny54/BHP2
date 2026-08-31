"use strict";

const MIN_COMPRESS_LENGTH = 1024;

function shouldCompress(contentType, size) {
  if (!contentType || !contentType.toLowerCase().startsWith("image/")) {
    return false;
  }

  return Number.isFinite(size) && size >= MIN_COMPRESS_LENGTH;
}

module.exports = shouldCompress;
