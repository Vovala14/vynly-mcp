# syntax=docker/dockerfile:1
#
# Dockerfile for Glama introspection sandbox.
#
# The image installs production deps, compiles TypeScript, and the default
# CMD runs the MCP server over stdio — which is what Glama's prober speaks
# to enumerate tools. A `VYNLY_TOKEN` env var is NOT required for tools/list
# (only for calls), so the prober gets a full tool manifest out of the box.

FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (including typescript for the build step)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

# Compile TypeScript to dist/
COPY src ./src
RUN npm run build

# Drop devDeps for the runtime image
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app

# Runtime artifacts only — no toolchain, smaller surface
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Stdio MCP server; Glama's prober connects to stdin/stdout
ENTRYPOINT ["node", "dist/index.js"]
