export async function handler(event = {}) {
  if (event.httpMethod && event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        allow: "GET",
      },
      body: JSON.stringify({
        error: "Method Not Allowed",
      }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify({
      status: "ok",
      service: "bandwidth-hero-proxy",
      version: "2.0.1",
    }),
  };
}
