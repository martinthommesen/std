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

CMD ["pnpm", "--silent", "std", "serve"]
