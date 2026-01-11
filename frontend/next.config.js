/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Next 14.x uses this key (NOT serverExternalPackages)
    serverComponentsExternalPackages: ["pdf-parse", "pdfjs-dist"],
  },
};

module.exports = nextConfig;
