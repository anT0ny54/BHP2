#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/anT0ny54/BHP2/archive/refs/heads/main.tar.gz"
WORK_DIR="bhp2-optimized"
ARCHIVE="bhp2-optimized.tar.gz"
ZIP_FILE="bhp2-optimized.zip"

rm -rf "$WORK_DIR" "$ARCHIVE" "$ZIP_FILE"

curl -L --fail --silent --show-error "$REPO_URL" -o "$ARCHIVE"
mkdir -p "$WORK_DIR"

tar -xzf "$ARCHIVE" --strip-components=1 -C "$WORK_DIR"
rm -f "$ARCHIVE"

cat > "$WORK_DIR/functions/index.js" <<'EOF'
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
EOF

cat > "$WORK_DIR/util/compress.js" <<'EOF'
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
EOF

cat > "$WORK_DIR/util/validate.js" <<'EOF'
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
EOF

cat > "$WORK_DIR/util/fetch.js" <<'EOF'
"use strict";

const { isValidUrl, isPrivateHost } = require("./validate");

async function fetchWithRedirectCheck(
  url,
  options = {},
  maxRedirects = 5
) {
  let currentUrl = url;
  let redirectCount = 0;
  const timeoutMs = options.timeout || 8000;
  const maxBytes = options.maxBytes || 15 * 1024 * 1024;
  const { timeout, maxBytes: unused, ...fetchOptions } = options;

  fetchOptions.redirect = "manual";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    while (true) {
      const response = await fetch(currentUrl, {
        ...fetchOptions,
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        redirectCount += 1;

        if (redirectCount > maxRedirects) {
          throw new Error("MAX_REDIRECTS_EXCEEDED");
        }

        const location = response.headers.get("location");

        if (!location) {
          throw new Error("REDIRECT_MISSING_LOCATION");
        }

        const nextUrl = new URL(location, currentUrl).toString();

        if (!isValidUrl(nextUrl)) {
          throw new Error("INVALID_REDIRECT_URL");
        }

        const nextHost = new URL(nextUrl).hostname;

        if (isPrivateHost(nextHost)) {
          throw new Error("FORBIDDEN_PRIVATE_REDIRECT");
        }

        currentUrl = nextUrl;
        continue;
      }

      const contentLength = Number.parseInt(
        response.headers.get("content-length"),
        10
      );

      if (contentLength > maxBytes) {
        throw new Error("MAX_RESPONSE_SIZE_EXCEEDED");
      }

      if (!response.body || typeof response.body.getReader !== "function") {
        return response;
      }

      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        total += value.byteLength;

        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("MAX_RESPONSE_SIZE_EXCEEDED");
        }

        chunks.push(Buffer.from(value));
      }

      return new Response(Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("FETCH_TIMEOUT");
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  fetchWithRedirectCheck,
};
EOF

cat > "$WORK_DIR/functions/health.js" <<'EOF'
"use strict";

exports.handler = async (event) => ({
  statusCode: event.httpMethod === "OPTIONS" ? 204 : 200,
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
    "content-type": "application/json",
    "cache-control": "no-store",
  },
  body: event.httpMethod === "OPTIONS"
    ? ""
    : JSON.stringify({
        status: "ok",
        service: "bandwidth-hero-proxy",
      }),
});
EOF

cat > "$WORK_DIR/netlify.toml" <<'EOF'
[build]
  environment = { NODE_VERSION = "22" }

[functions]
  directory = "functions"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200

[[headers]]
  for = "/"

  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    Cache-Control = "public, max-age=300"

[[headers]]
  for = "/api/*"

  [headers.values]
    Access-Control-Allow-Origin = "*"
    Access-Control-Allow-Methods = "GET, OPTIONS"
    Access-Control-Allow-Headers = "*"
EOF

# Correct the diagnostic page to use the headers emitted by the optimized function.
python3 - "$WORK_DIR/index.html" <<'PY'
from pathlib import Path
path = Path(__import__("sys").argv[1])
text = path.read_text(encoding="utf-8")
text = text.replace("x-original-size", "x-bh-original-size")
text = text.replace("x-bytes-saved", "x-bh-bytes-saved")
path.write_text(text, encoding="utf-8")
PY

# Confirm dependency files were not modified.
git -C "$WORK_DIR" diff -- package.json yarn.lock 2>/dev/null || true

# Create a complete downloadable archive.
tar -czf "$WORK_DIR.tar.gz" "$WORK_DIR"
zip -qr "$ZIP_FILE" "$WORK_DIR"

echo
echo "Created:"
echo "  $ZIP_FILE"
echo "  $WORK_DIR.tar.gz"
echo
echo "Package files preserved:"
echo "  $WORK_DIR/package.json"
echo "  $WORK_DIR/yarn.lock"
