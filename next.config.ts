import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas"],
  allowedDevOrigins: ["raider-trivial-pointer.ngrok-free.dev"],
  devIndicators: false,
};

export default nextConfig;
