# ⚡ Bandwidth Hero Proxy 2

A serverless image-compression proxy for Bandwidth Hero-compatible browser extensions.

The service fetches an image, converts it to WebP or JPEG using Sharp, optionally applies grayscale conversion and resizing, and returns the optimized image.

## Features

- WebP output by default
- JPEG output with `jpeg=1`
- Grayscale conversion with `bw=1`
- Quality control
- Maximum-width resizing
- Manual redirect handling
- Redirect limit
- HTTP and HTTPS URL validation
- Private IPv4 and IPv6 blocking
- DNS resolution checks before each request
- DNS-rebinding protection
- Maximum image-size limit
- Maximum Sharp input-pixel limit
- CORS support
- `/api/health` endpoint
- Node.js native test runner
- Netlify Functions deployment

## Requirements

- Node.js 18.18 or later
- Netlify CLI for local development
- Sharp


#### :department_store: **My Free DNS Server, free** <a name="dns server"></a>

On [My Free DNS] you can use HaGeZi Blocklists Multi Pro + TIF.

| Hagezi Blocklists | DNS-over-HTTPS |
|:---------------|:---------------|
| Multi Pro + TIF | `https://xdns.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://freedns-six.vercel.app/api/doh/dns-query` |


## Supporting My Project

If you are interested in supporting the project you can donate :
 - Bitcoin: 1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP
