"use strict";

const sharp = require("sharp");

const DEFAULT_QUALITY = 40;
const DEFAULT_MAX_WIDTH = 0;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

const CACHE_HEADERS = {
  "cache-control":
    "public, max-age=3600, s-maxage=604800, stale-while-revalidate=86400",
};

const BASE_HEADERS = {
  ...CORS_HEADERS,
  ...CACHE_HEADERS,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
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

function createResponse(statusCode, body = "", headers = {}) {
  return {
    statusCode,
    headers: {
      ...BASE_HEADERS,
      ...headers,
    },
    body,
  };
}

function createBinaryResponse(buffer, headers = {}) {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    body: buffer.toString("base64"),
    headers: {
      ...BASE_HEADERS,
      ...headers,
    },
  };
}

function getQueryParameters(event) {
  return event.queryStringParameters || {};
}

function getImageUrl(value) {
  if (!value) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.join("&url=");
  }

  // Compatibility with clients that send the URL as a JSON string or array.
  try {
    const parsed = JSON.parse(value);

    if (Array.isArray(parsed)) {
      return parsed.join("&url=");
    }

    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // The value is a normal URL.
  }

  return value;
}

function normalizeImageUrl(value) {
  let imageUrl = getImageUrl(value).trim();

  // Support the old Bandwidth Hero format:
  // http://1.1.1.1/bmi/https://example.com/image.jpg
  imageUrl = imageUrl.replace(
    /^http:\/\/1\.1\.\d+\.\d+\/bmi\/(https?:\/\/)?/i,
    "http://"
  );

  return imageUrl;
}

function parseHttpUrl(value) {
  try {
    const parsedUrl = new URL(value);

    if (
      parsedUrl.protocol !== "http:" &&
      parsedUrl.protocol !== "https:"
    ) {
      return null;
    }

    return parsedUrl;
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname) {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  const privateHostnames = new Set([
    "localhost",
    "localhost.localdomain",
    "local",
    "ip6-localhost",
    "ip6-loopback",
    "::1",
    "0.0.0.0",
  ]);

  if (privateHostnames.has(host)) {
    return true;
  }

  // IPv4 validation and private ranges.
  const ipv4Match = host.match(
    /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/
  );

  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);

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

  // IPv6 private, loopback, link-local and unspecified ranges.
  return (
    host === "::" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb")
  );
}

function validateRemoteUrl(value) {
  const parsedUrl = parseHttpUrl(value);

  if (!parsedUrl) {
    return {
      valid: false,
      error: "Invalid URL. Only HTTP and HTTPS URLs are supported.",
    };
  }

  if (isPrivateHostname(parsedUrl.hostname)) {
    return {
      valid: false,
      error: "Requests to private or local addresses are not allowed.",
    };
  }

  return {
    valid: true,
    url: parsedUrl.toString(),
  };
}

function parseInteger(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(number, min), max);
}

function parseBoolean(value) {
  return value === "1" || value === "true";
}

function getForwardedHeaders(event) {
  const input = event.headers || {};
  const headers = {};

  const cookie = input.cookie;
  const referer = input.referer || input.referrer;
  const userAgent = input["user-agent"];
  const acceptLanguage = input["accept-language"];

  if (cookie) {
    headers.cookie = cookie;
  }

  if (referer) {
    headers.referer = referer;
  }

  if (userAgent) {
    headers["user-agent"] = userAgent;
  }

  if (acceptLanguage) {
    headers["accept-language"] = acceptLanguage;
  }

  headers.accept =
    input.accept ||
    "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

  // Sharp should receive the decoded image body.
  headers["accept-encoding"] = "identity";

  return headers;
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });
}

async function readResponseBody(response) {
  const contentLength = Number.parseInt(
    response.headers.get("content-length") || "",
    10
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_IMAGE_BYTES
  ) {
    const error = new Error("The source image is too large.");
    error.statusCode = 413;
    throw error;
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_IMAGE_BYTES) {
      const error = new Error("The source image is too large.");
      error.statusCode = 413;
      throw error;
    }

    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      totalBytes += chunk.length;

      if (totalBytes > MAX_IMAGE_BYTES) {
        await reader.cancel();

        const error = new Error("The source image is too large.");
        error.statusCode = 413;
        throw error;
      }

      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

async function fetchImage(event, initialUrl) {
  let currentUrl = initialUrl;

  for (
    let redirect = 0;
    redirect <= MAX_REDIRECTS;
    redirect += 1
  ) {
    const validation = validateRemoteUrl(currentUrl);

    if (!validation.valid) {
      const error = new Error(validation.error);
      error.statusCode = 403;
      throw error;
    }

    const upstream = await fetchWithTimeout(validation.url, {
      method: "GET",
      headers: getForwardedHeaders(event),
      redirect: "manual",
    });

    const location = upstream.headers.get("location");

    if (
      upstream.status >= 300 &&
      upstream.status < 400 &&
      location
    ) {
      if (redirect === MAX_REDIRECTS) {
        const error = new Error("Too many upstream redirects.");
        error.statusCode = 508;
        throw error;
      }

      currentUrl = new URL(location, validation.url).toString();
      continue;
    }

    if (!upstream.ok) {
      const error = new Error(
        `Upstream image request failed with status ${upstream.status}.`
      );

      error.statusCode =
        upstream.status >= 400 ? upstream.status : 502;

      throw error;
    }

    const contentType = (
      upstream.headers.get("content-type") || ""
    )
      .split(";")[0]
      .toLowerCase();

    if (!contentType.startsWith("image/")) {
      const error = new Error(
        `Upstream returned a non-image response (${
          contentType || "unknown"
        }).`
      );

      error.statusCode = 415;
      throw error;
    }

    const buffer = await readResponseBody(upstream);

    return {
      buffer,
      contentType,
      headers: upstream.headers,
    };
  }

  const error = new Error("Unable to fetch image.");
  error.statusCode = 502;
  throw error;
}

function getSafeUpstreamHeaders(headers) {
  const safeHeaders = {};
  const allowedHeaders = new Set([
    "etag",
    "last-modified",
    "expires",
  ]);

  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase();

    if (
      allowedHeaders.has(normalizedKey) &&
      !HOP_BY_HOP_HEADERS.has(normalizedKey)
    ) {
      safeHeaders[normalizedKey] = value;
    }
  }

  return safeHeaders;
}

async function compressImage(
  input,
  useWebp,
  grayscale,
  quality,
  maxWidth
) {
  let pipeline = sharp(input, {
    animated: false,
    failOn: "none",
    limitInputPixels: MAX_INPUT_PIXELS,
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
    return pipeline
      .webp({
        quality,
        effort: 4,
        smartSubsample: true,
      })
      .toBuffer();
  }

  return pipeline
    .jpeg({
      quality,
      progressive: true,
      mozjpeg: true,
      chromaSubsampling: "4:2:0",
    })
    .toBuffer();
}

function getOutputHeaders({
  contentType,
  originalSize,
  compressedSize,
  upstreamHeaders = {},
}) {
  const bytesSaved = Math.max(
    0,
    originalSize - compressedSize
  );

  return {
    ...upstreamHeaders,
    "content-type": contentType,
    "content-length": String(compressedSize),
    "content-encoding": "identity",
    "x-original-size": String(originalSize),
    "x-compressed-size": String(compressedSize),
    "x-bytes-saved": String(bytesSaved),
  };
}

exports.handler = async (event) => {
  const method = event.httpMethod || "GET";

  if (method === "OPTIONS") {
    return createResponse(204);
  }

  if (method !== "GET") {
    return createResponse(405, "Method Not Allowed", {
      allow: "GET, OPTIONS",
      "content-type": "text/plain; charset=utf-8",
    });
  }

  const query = getQueryParameters(event);

  // Used by Bandwidth Hero-compatible extensions to test availability.
  if (!query.url) {
    return createResponse(200, "bandwidth-hero-proxy", {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    });
  }

  const imageUrl = normalizeImageUrl(query.url);
  const validation = validateRemoteUrl(imageUrl);

  if (!validation.valid) {
    return createResponse(400, validation.error, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
  }

  const useWebp = query.jpeg !== "1";
  const grayscale = parseBoolean(query.bw);

  // Supports both:
  // quality=40
  // l=40
  const quality = parseInteger(
    query.quality ?? query.l,
    DEFAULT_QUALITY,
    1,
    100
  );

  const maxWidth = parseInteger(
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

    const outputIsSmaller = compressed.length < originalSize;

    // Returning the source image prevents the proxy from increasing
    // bandwidth usage for already-compressed images.
    if (!outputIsSmaller) {
      return createBinaryResponse(source.buffer, {
        ...getSafeUpstreamHeaders(source.headers),
        ...getOutputHeaders({
          contentType: source.contentType,
          originalSize,
          compressedSize: originalSize,
        }),
      });
    }

    const outputType = useWebp
      ? "image/webp"
      : "image/jpeg";

    return createBinaryResponse(compressed, {
      ...getOutputHeaders({
        contentType: outputType,
        originalSize,
        compressedSize: compressed.length,
      }),
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

    return createResponse(statusCode, message, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
  }
};
