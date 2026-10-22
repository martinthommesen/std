# The quickstart's development image (docker-compose.yml, services `upgrade`
# and `server`; decision 0016).
#
# Deliberately minimal and NOT the release image, which is Step 4D's work
# (a built, smaller image with the web app). This one is the workspace as
# checked out: the pinned Node and pnpm, `pnpm install --frozen-lockfile`
# (dev dependencies included), and the `std` command run from its TypeScript
# sources, exactly as the root `pnpm std` script runs it.

# Node 26.12.0, the version `devEngines.runtime` pins in package.json, so
# pnpm finds it and downloads nothing.
FROM node:26.12.0-bookworm-slim

# pnpm 12.14.0, the version `packageManager` pins.
RUN npm install --global pnpm@12.14.0 && npm cache clean --force

WORKDIR /std

# The whole workspace (minus `.dockerignore`): every workspace package must
# be present for a frozen install. `--ignore-scripts` skips the root
# `prepare` (it patches `tsc`, which the image never runs) and lefthook's git
# hooks (the image has no git checkout).
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts

# The web app (apps/web), built into apps/web/dist, which `std serve` serves
# at / by default (STD_WEB_ROOT; decision 0018). Open http://localhost:8080.
RUN pnpm --filter @std/web build

# Run as the base image's unprivileged `node` user. The workspace, the web
# build included, stays owned by root, so the server can read the web root
# but not write to it: a process that could write there could swap a file
# for a symlink between the server's check and its read (decision 0018).
# `COPY` keeps the build host's file modes, so make everything readable,
# and writable by root only, whatever they were.
RUN chmod -R a+rX,go-w /std
USER node

CMD ["pnpm", "--silent", "std", "serve"]
