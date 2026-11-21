import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  transpilePackages: ['lexel-ui', 'lexel-wasm'],
  trailingSlash: true,
};

export default nextConfig;
