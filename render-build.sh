#!/bin/bash
set -e

echo "Starting Render custom build script for the NestJS monorepo..."

npm ci --ignore-scripts
npm run build:api

echo "Build complete!"
