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
