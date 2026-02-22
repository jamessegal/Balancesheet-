import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  instrumentationHook: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
};

export default nextConfig;
