# The clip worker (README.md). Its own root on Railway (services/media-worker), so the web service's
# railway.json, migrations and secrets never reach it. No npm dependencies: node runs the .ts directly.
FROM node:24-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json main.mjs fetch-clip.ts clip.ts handler.ts ./
USER node
ENV NODE_ENV=production
CMD ["node", "main.mjs"]
