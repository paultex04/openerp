/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The API lives on a different origin during development; proxying keeps the
  // browser on a single origin so the session cookie is first-party.
  async rewrites() {
    const target = process.env.API_BASE_URL ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};

export default nextConfig;
