import dns from "node:dns/promises";
import net from "node:net";

export const INVALID_URL_ERROR =
  "Invalid URL. Only HTTP and HTTPS URLs are supported.";

export const PRIVATE_HOST_ERROR =
  "Requests to private or local addresses are not allowed.";

export const DNS_RESOLUTION_ERROR =
  "Unable to resolve the remote host.";

let dnsLookup = defaultDnsLookup;

async function defaultDnsLookup(hostname) {
  return dns.lookup(hostname, {
    all: true,
    verbatim: true,
  });
}

/**
 * Allows tests to replace DNS lookup behavior.
 * Do not use this in application code.
 */
export function setDnsLookupForTests(lookup) {
  dnsLookup = lookup;
}

/**
 * Restores normal DNS resolution.
 */
export function resetDnsLookupForTests() {
  dnsLookup = defaultDnsLookup;
}

function ipv4ToNumber(value) {
  const parts = value.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255
    )
  ) {
    return null;
  }

  return (
    ((parts[0] << 24) |
      (parts[1] << 16) |
      (parts[2] << 8) |
      parts[3]) >>>
    0
  );
}

function isPrivateIpv4(value) {
  const number = ipv4ToNumber(value);

  if (number === null) {
    return true;
  }

  const first = (number >>> 24) & 255;
  const second = (number >>> 16) & 255;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function expandIpv6(value) {
  let address = value.toLowerCase();

  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4Part = address.slice(lastColon + 1);
    const ipv4Number = ipv4ToNumber(ipv4Part);

    if (ipv4Number === null) {
      return null;
    }

    const high = ((ipv4Number >>> 16) & 0xffff).toString(16);
    const low = (ipv4Number & 0xffff).toString(16);

    address = `${address.slice(0, lastColon)}${high}:${low}`;
  }

  const doubleColonParts = address.split("::");

  if (doubleColonParts.length > 2) {
    return null;
  }

  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":")
    : [];

  const right = doubleColonParts[1]
    ? doubleColonParts[1].split(":")
    : [];

  if (
    left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
    right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  ) {
    return null;
  }

  const missing = 8 - left.length - right.length;

  if (doubleColonParts.length === 1 && missing !== 0) {
    return null;
  }

  if (doubleColonParts.length === 2 && missing < 1) {
    return null;
  }

  return [
    ...left,
    ...(doubleColonParts.length === 2 ? Array(missing).fill("0") : []),
    ...right,
  ].map((part) => parseInt(part || "0", 16));
}

function ipv6ToBigInt(value) {
  const groups = expandIpv6(value);

  if (!groups || groups.length !== 8) {
    return null;
  }

  return groups.reduce(
    (result, group) => (result << 16n) | BigInt(group),
    0n
  );
}

function isPrivateIpv6(value) {
  const normalized = value.toLowerCase();

  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);

    if (net.isIP(mappedIpv4) === 4) {
      return isPrivateIpv4(mappedIpv4);
    }

    const groups = expandIpv6(normalized);

    if (groups?.length === 8) {
      const mappedNumber =
        (groups[6] << 16) | groups[7];

      const mappedAddress = [
        (mappedNumber >>> 24) & 255,
        (mappedNumber >>> 16) & 255,
        (mappedNumber >>> 8) & 255,
        mappedNumber & 255,
      ].join(".");

      return isPrivateIpv4(mappedAddress);
    }
  }

  const number = ipv6ToBigInt(normalized);

  if (number === null) {
    return true;
  }

  const firstByte = Number(number >> 120n);
  const first16 = Number(number >> 112n);
  const first10 = Number(number >> 118n);

  return (
    number === 0n ||
    number === 1n ||
    firstByte === 0xff ||
    first10 === 0b1111111010 ||
    first16 >= 0xfc00 && first16 <= 0xfdff
  );
}

export function isPrivateIp(value) {
  const address = String(value)
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();

  const family = net.isIP(address);

  if (family === 4) {
    return isPrivateIpv4(address);
  }

  if (family === 6) {
    return isPrivateIpv6(address);
  }

  return true;
}

export function isPrivateHost(hostname) {
  const host = String(hostname)
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase()
    .replace(/\.$/, "");

  const blockedHostnames = new Set([
    "localhost",
    "localhost.localdomain",
    "local",
    "ip6-localhost",
    "ip6-loopback",
  ]);

  if (blockedHostnames.has(host)) {
    return true;
  }

  if (net.isIP(host)) {
    return isPrivateIp(host);
  }

  return false;
}

export function parseHttpUrl(value) {
  try {
    const url = new URL(value);

    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:"
    ) {
      return null;
    }

    if (!url.hostname) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

export function validateRemoteUrl(value) {
  const url = parseHttpUrl(value);

  if (!url) {
    return {
      valid: false,
      error: INVALID_URL_ERROR,
    };
  }

  if (isPrivateHost(url.hostname)) {
    return {
      valid: false,
      error: PRIVATE_HOST_ERROR,
    };
  }

  return {
    valid: true,
    url: url.toString(),
  };
}

/**
 * Performs both hostname validation and DNS-address validation.
 *
 * The DNS result is checked immediately before fetch. This prevents a
 * hostname that initially resolves to a public address from being used
 * after it changes to a private address.
 */
export async function resolveAndValidateRemoteUrl(value) {
  const validation = validateRemoteUrl(value);

  if (!validation.valid) {
    return validation;
  }

  const url = new URL(validation.url);

  let records;

  try {
    records = await dnsLookup(url.hostname);
  } catch {
    return {
      valid: false,
      error: DNS_RESOLUTION_ERROR,
      statusCode: 502,
    };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return {
      valid: false,
      error: DNS_RESOLUTION_ERROR,
      statusCode: 502,
    };
  }

  if (records.some((record) => isPrivateIp(record.address))) {
    return {
      valid: false,
      error: PRIVATE_HOST_ERROR,
    };
  }

  return {
    valid: true,
    url: url.toString(),
  };
}
