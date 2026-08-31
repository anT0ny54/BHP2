"use strict";

const sharp = require("sharp");

const DEFAULT_QUALITY = 40;
const DEFAULT_MAX_WIDTH = 0;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

const CACHE_HEADERS = {
  "cache-control":
    "public, s-maxage=604800, max-age=3600, stale-while-revalidate=86400",
};

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "content-type",
]);

function response(statusCode, body = "", headers = {}) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      ...headers,
    },
    body,
  };
}

function base64Response(buffer, headers = {}) {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    body: buffer.toString("base64"),
    headers: {
      ...CORS_HEADERS,
      ...CACHE_HEADERS,
      ...headers,
    },
  };
}

function getQueryParameters(event) {
  return event.queryStringParameters || {};
}

function getImageUrl(value) {
  if (!value) return "";

  if (Array.isArray(value)) {
    return value.join("&url=");
  }

  // Compatibility with older Bandwidth Hero clients that send a JSON string.
  try {
    const parsed = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return parsed.join("&url=");
    }

    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Normal URL; no JSON decoding needed.
  }

  return value;
}

function normalizeImageUrl(value) {
  let imageUrl = getImageUrl(value).trim();

  // Legacy Bandwidth Hero image proxy URL format.
  imageUrl = imageUrl.replace(
    /^http:\/\/1\.1\.\d+\.\d+\/bmi\/(https?:\/\/)?/i,
    "http://"
  );

  return imageUrl;
}

function parseHttpUrl(value) {
  try {
    const parsed = new URL(value);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return true;
  }

  // IPv4 private, loopback, link-local, carrier-grade NAT and multicast ranges.
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);

  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);

    if (octets.some((part) => part < 0 || part > 255)) {
      return true;
    }

    const [a, b] = octets;

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  // IPv6 loopback, unique-local and link-local ranges.
  return (
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  );
}

function validateRemoteUrl(value) {
  const parsed = parseHttpUrl(value);

  if (!parsed) {
    return {
      valid: false,
      error: "Invalid URL. Only HTTP and HTTPS URLs are supported.",
    };
  }

  if (isPrivateHostname(parsed.hostname)) {
    return {
      valid: false,
      error: "Requests to private or local addresses are not allowed.",
    };
  }

  return {
    valid: true,
    url: parsed.toString(),
  };
}

function getNumber(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(number, min), max);
}

function getBoolean(value) {
  return value === "1" || value === "true";
}

function getForwardedHeaders(event) {
  const input = event.headers || {};
  const headers = {};

  const cookie = input.cookie;
  const referer = input.referer || input.referrer;
  const userAgent = input["user-agent"];
  const acceptLanguage = input["accept-language"];

  if (cookie) headers.cookie = cookie;
  if (referer) headers.referer = referer;
  if (userAgent) headers["user-agent"] = userAgent;
  if (acceptLanguage) headers["accept-language"] = acceptLanguage;

  headers.accept =
    input.accept || "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

  // Do not request compressed transfer encoding. Sharp needs the decoded body.
  headers["accept-encoding"] = "identity";

  return headers;
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

async function fetchImage(event, initialUrl) {
  let currentUrl = initialUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const validation = validateRemoteUrl(currentUrl);

    if (!validation.valid) {
      const error = new Error(validation.error);
      error.statusCode = 403;
      throw error;
    }

    const upstream = await fetchWithTimeout(
      currentUrl,
      {
        method: "GET",
        headers: getForwardedHeaders(event),
        redirect: "manual",
      },
      FETCH_TIMEOUT_MS
    );

    if (
      upstream.status >= 300 &&
      upstream.status < 400 &&
      upstream.headers.get("location")
    ) {
      if (redirect === MAX_REDIRECTS) {
        const error = new Error("Too many upstream redirects.");
        error.statusCode = 508;
        throw error;
      }

      const nextUrl = new URL(
        upstream.headers.get("location"),
        currentUrl
      ).toString();

      currentUrl = nextUrl;
      continue;
    }

    if (!upstream.ok) {
      const error = new Error(
        `Upstream image request failed with status ${upstream.status}.`
      );
      error.statusCode = upstream.status >= 400 ? upstream.status : 502;
      throw error;
    }

    const contentType = (
      upstream.headers.get("content-type") || ""
    ).split(";")[0].toLowerCase();

    if (!contentType.startsWith("image/")) {
      const error = new Error(
        `Upstream returned a non-image response (${contentType || "unknown"}).`
      );
      error.statusCode = 415;
      throw error;
    }

    const contentLength = Number.parseInt(
      upstream.headers.get("content-length") || "",
      10
    );

    if (contentLength > MAX_IMAGE_BYTES) {
      const error = new Error("The source image is too large.");
      error.statusCode = 413;
      throw error;
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_IMAGE_BYTES) {
      const error = new Error("The source image is too large.");
      error.statusCode = 413;
      throw error;
    }

    return {
      buffer,
      contentType,
      headers: upstream.headers,
    };
  }

  throw new Error("Unable to fetch image.");
}

function getSafeUpstreamHeaders(headers) {
  const result = {};

  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase();

    if (!HOP_BY_HOP_HEADERS.has(normalizedKey)) {
      result[normalizedKey] = value;
    }
  }

  return result;
}

async function compressImage(
  input,
  useWebp,
  grayscale,
  quality,
  maxWidth
) {
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

  return pipeline.toBuffer();
}

exports.handler = async (event) => {
  const method = event.httpMethod || "GET";

  if (method === "OPTIONS") {
    return response(204);
  }

  if (method !== "GET") {
    return response(405, "Method Not Allowed", {
      allow: "GET, OPTIONS",
    });
  }

  const query = getQueryParameters(event);

  // Bandwidth Hero uses this response to test whether the proxy is available.
  if (!query.url) {
    return response(200, "bandwidth-hero-proxy");
  }

  const imageUrl = normalizeImageUrl(query.url);
  const validation = validateRemoteUrl(imageUrl);

  if (!validation.valid) {
    return response(400, validation.error);
  }

  const useWebp = query.jpeg !== "1";
  const grayscale = getBoolean(query.bw);

  // Supports both Bandwidth Guardian and the original Bandwidth Hero parameter.
  const quality = getNumber(
    query.quality || query.l,
    DEFAULT_QUALITY,
    1,
    100
  );

  const maxWidth = getNumber(
    query.max_width,
    DEFAULT_MAX_WIDTH,
    0,
    8192
  );

  try {
    const source = await fetchImage(event, validation.url);
    const originalSize = source.buffer.length;

    const compressed = await compressImage(
      source.buffer,
      useWebp,
      grayscale,
      quality,
      maxWidth
    );

    // Never increase bandwidth usage. Return the original image when compression
    // produces an equal or larger file.
    if (compressed.length >= originalSize) {
      return base64Response(
        source.buffer,
        {
          ...CACHE_HEADERS,
          ...getSafeUpstreamHeaders(source.headers),
          "content-type": source.contentType,
          "content-length": String(originalSize),
          "content-encoding": "identity",
          "x-original-size": String(originalSize),
          "x-compressed-size": String(originalSize),
          "x-bytes-saved": "0",
        }
      );
    }

    const outputType = useWebp ? "image/webp" : "image/jpeg";
    const bytesSaved = originalSize - compressed.length;

    return base64Response(compressed, {
      "content-type": outputType,
      "content-length": String(compressed.length),
      "content-encoding": "identity",
      "x-original-size": String(originalSize),
      "x-compressed-size": String(compressed.length),
      "x-bytes-saved": String(bytesSaved),
    });
  } catch (error) {
    console.error("Image proxy error:", error);

    const statusCode =
      Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 &&
      error.statusCode <= 599
        ? error.statusCode
        : error.name === "AbortError"
          ? 504
          : 500;

    const message =
      error.name === "AbortError"
        ? "Upstream image request timed out."
        : error.message || "Image processing failed.";

    return response(statusCode, message);
  }
};
