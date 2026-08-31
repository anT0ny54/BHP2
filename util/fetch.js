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
