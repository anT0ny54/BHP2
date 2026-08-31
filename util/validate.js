"use strict";

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

function isValidUrl(value) {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function isPrivateHost(hostname) {
  const normalized = String(hostname)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();

  return PRIVATE_HOST_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
}

module.exports = {
  isValidUrl,
  isPrivateHost,
};
