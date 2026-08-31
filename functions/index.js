"use strict";

const shouldCompress = require("../util/shouldCompress");
const compress = require("../util/compress");
const {
  isValidUrl,
  isPrivateHost,
} = require("../util/validate");
const {
  fetchWithRedirectCheck,
} = require("../util/fetch");

const DEFAULT_QUALITY = 40;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_WIDTH = 8192;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers":
    "content-type, content-length, cache-control, " +
    "x-bh-original-size, x-bh-compressed-size, x-bh-bytes-saved",
};

const CACHE_HEADERS = {
  "netlify-cdn-cache-control":
    "public, durable, s-maxage=604800, stale-while-revalidate=86400",
  "cache-control": "public, max-age=0, must-revalidate",
  "netlify-vary": "query=url|quality|bw|jpeg|max_width|l",
};

const BACKEND_HEADERS = {
  "x-bh-backend": "bandwidth-proxy-2",
  "x-bh-version": "2.1.0",
  "x-bh-api": "1",
  "x-bh-features": "webp,grayscale,maxwidth,stats",
};

const UPSTREAM_HEADER_DENYLIST = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cache-control",
  "content-encoding",
  "content-length",
  "content-range",
  "set-cookie",
  "strict-transport-security",
  "age",
  "via",
  "alt-svc",
  "server",
  "location",
  "cf-cache-status",
  "cf-ray",
]);

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      ...headers,
    },
    body,
  };
}

function numberInRange(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function getQuery(event) {
  return event.queryStringParameters || {};
}

function getImageUrl(value) {
  if (!value) {
    return null;
  }

  let url = value;

  try {
    const parsed = JSON.parse(value);
    url = Array.isArray(parsed)
      ? parsed.join("&url=")
      : typeof parsed === "string"
        ? parsed
        : value;
  } catch {
    // The extension normally sends a plain URL.
  }

  return String(url)
    .replace(
      /http:\/\/1\.1\.\d+\.\d+\/bmi\/(https?:\/\/)?/i,
      "http://"
    )
    .trim();
}

function copyUpstreamHeaders(headers) {
  const result = {};

  headers.forEach((value, key) => {
    if (!UPSTREAM_HEADER_DENYLIST.has(key.toLowerCase())) {
      result[key] = value;
    }
  });

  return result;
}

function requestHeaders(event) {
  const headers = event.headers || {};
  const get = (name) => headers[name] || headers[name.toLowerCase()];

  return {
    ...(get("cookie") && { cookie: get("cookie") }),
    ...(get("dnt") && { dnt: get("dnt") }),
    ...(get("referer") && { referer: get("referer") }),
    "user-agent":
      get("user-agent") ||
      "Mozilla/5.0 (compatible; BandwidthHeroProxy/2.1)",
    accept:
      get("accept") ||
      "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "accept-language": get("accept-language") || "en-US,en;q=0.9",
    "accept-encoding": "identity",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  const query = getQuery(event);
  const rawUrl = getImageUrl(query.url);

  if (!rawUrl) {
    return response(200, "bandwidth-hero-proxy");
  }

  if (!isValidUrl(rawUrl)) {
    return response(400, "Invalid URL");
  }

  const parsedUrl = new URL(rawUrl);

  if (isPrivateHost(parsedUrl.hostname)) {
    return response(403, "Forbidden");
  }

  const useWebp = query.jpeg !== "1";
  const grayscale = query.bw === "1";
  const quality = numberInRange(
    query.quality || query.l,
    DEFAULT_QUALITY,
    1,
    100
  );
  const maxWidth = numberInRange(query.max_width, 0, 0, MAX_WIDTH);

  try {
    const upstream = await fetchWithRedirectCheck(
      rawUrl,
      {
        headers: requestHeaders(event),
        timeout: DEFAULT_TIMEOUT_MS,
        maxBytes: MAX_INPUT_BYTES,
      },
      MAX_REDIRECTS
    );

    if (!upstream.ok) {
      return response(upstream.status || 502, "");
    }

    const contentType =
      upstream.headers.get("content-type") || "application/octet-stream";

    if (!contentType.toLowerCase().startsWith("image/")) {
      return response(
        415,
        `Upstream returned non-image response (${contentType})`
      );
    }

    const contentLength = Number.parseInt(
      upstream.headers.get("content-length"),
      10
    );

    if (contentLength > MAX_INPUT_BYTES) {
      return response(413, "Image is too large");
    }

    const body = Buffer.from(await upstream.arrayBuffer());

    if (body.length > MAX_INPUT_BYTES) {
      return response(413, "Image is too large");
    }

    const originalSize = body.length;
    const upstreamHeaders = copyUpstreamHeaders(upstream.headers);

    if (!shouldCompress(contentType, originalSize, useWebp)) {
      return {
        statusCode: 200,
        isBase64Encoded: true,
        body: body.toString("base64"),
        headers: {
          ...CORS_HEADERS,
          ...CACHE_HEADERS,
          ...upstreamHeaders,
          "content-type": contentType,
          "content-encoding": "identity",
          ...BACKEND_HEADERS,
          "x-bh-original-size": String(originalSize),
          "x-bh-compressed-size": String(originalSize),
          "x-bh-bytes-saved": "0",
        },
      };
    }

    const result = await compress(
      body,
      useWebp,
      grayscale,
      quality,
      originalSize,
      maxWidth
    );

    if (result.err) {
      throw result.err;
    }

    return {
      statusCode: 200,
      isBase64Encoded: true,
      body: result.output.toString("base64"),
      headers: {
        ...CORS_HEADERS,
        ...CACHE_HEADERS,
        ...upstreamHeaders,
        ...result.headers,
        "content-encoding": "identity",
        ...BACKEND_HEADERS,
      },
    };
  } catch (error) {
    if (error.message === "FETCH_TIMEOUT") {
      return response(504, "Upstream fetch timed out");
    }

    if (error.message === "MAX_RESPONSE_SIZE_EXCEEDED") {
      return response(413, "Image is too large");
    }

    if (
      error.message === "FORBIDDEN_PRIVATE_REDIRECT" ||
      error.message === "INVALID_REDIRECT_URL"
    ) {
      return response(403, "Forbidden");
    }

    if (error.message === "MAX_REDIRECTS_EXCEEDED") {
      return response(508, "Too many redirects");
    }

    console.error("Proxy error:", error);
    return response(502, "Unable to fetch or process image");
  }
};
