# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl libstdc++
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
COPY proto ./proto
COPY src ./src
RUN npm run generate
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl libstdc++ curl
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/proto ./proto
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
EXPOSE 4600
CMD ["./docker-entrypoint.sh"]
