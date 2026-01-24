# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
RUN apk add --no-cache curl
COPY --from=build /app/dist ./dist
COPY --from=build /app/.env.example ./
EXPOSE 3000
CMD ["node", "dist/server.js"]
