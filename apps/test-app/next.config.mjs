/** @type {import('next').NextConfig} */
const nextConfig = {
  // canopycms-auth-dev also ships raw TS via its exports map, so it must be
  // transpiled too — `next build` fails on it otherwise (next dev tolerates it).
  transpilePackages: ['canopycms', 'canopycms-next', 'canopycms-auth-dev'],
}

export default nextConfig
