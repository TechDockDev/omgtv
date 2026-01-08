# Auth Service

Fastify-based authentication service for PocketLOL. Handles user registration and login, issues JWT access and refresh tokens, and exposes a gRPC surface for internal service-to-service communication.

## Features

- Fastify HTTP API with register and login endpoints
- PostgreSQL persistence managed via Prisma ORM
- Password hashing via bcrypt
- JWT issuance with RSA keys and JWKS endpoint for verification
- Refresh token rotation with per-device session tracking
- gRPC API for token validation and user lookups
- Pino structured logging and graceful shutdown hooks

## Getting Started

To run the service together with the rest of the stack, use `docker compose up --build` from the repository root (see [../README.md](../README.md)).

### Prerequisites

- Node.js 18.18 or newer
- PostgreSQL database reachable by the service
- OpenSSL (only for generating RSA keys)

### Environment Variables

Copy `.env.example` to `.env` and adjust values as needed:

- `DATABASE_URL` – PostgreSQL connection string
- `AUTH_JWT_PRIVATE_KEY` / `AUTH_JWT_PUBLIC_KEY` – RSA key pair used for JWT signing
- `AUTH_JWT_KEY_ID` – Key identifier exposed via JWKS
- `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` – Token lifetimes (seconds)
- `GRPC_BIND_ADDRESS` – Host:port for the gRPC server
- `SERVICE_AUTH_TOKEN` – Shared bearer token required by gRPC callers (optional but recommended)

### Install & Migrate

```bash
npm install
npm run generate
npm run migrate:dev
```

### Development

Run the HTTP and gRPC servers together:

```bash
npm run dev
```

The HTTP API listens on `http://localhost:4000` by default. Health and JWKS endpoints:

- `GET /health`
- `GET /.well-known/jwks.json`

### Prisma

- `npm run migrate:dev` – Apply migrations in development
- `npm run migrate:deploy` – Apply migrations in production
- `npm run generate` – Regenerate Prisma client

## HTTP API

| Method | Path              | Description                |
| ------ | ----------------- | -------------------------- |
| POST   | `/public/register`| Register a new user        |
| POST   | `/public/login`   | Login and receive tokens   |

### Register Request

```json
{
  "email": "player@example.com",
  "username": "player-one",
  "password": "changeme123",
  "role": "CUSTOMER",
  "deviceId": "device-123" 
}
```

### Login Request

```json
{
  "username": "player-one",
  "password": "changeme123",
  "deviceId": "device-123"
}
```

Responses from both endpoints include access and refresh tokens plus expiry metadata.

## gRPC API

Defined in `proto/auth.proto` under `auth.v1.AuthService`:

- `ValidateToken` – Validates an access token and returns user metadata
- `GetUserById` – Retrieves core user attributes by identifier

Clients must send a bearer token in the `authorization` metadata header when `SERVICE_AUTH_TOKEN` is configured.

## Integration Notes

- The JWKS endpoint can be wired to the API Gateway via `AUTH_JWKS_URL`
- Set `AUTH_SERVICE_URL` in the API Gateway to the HTTP base URL (e.g. `http://auth:4000`)
- Use the gRPC service for internal consumers that need trusted user lookups or token validation

## Testing

Add your preferred runner (e.g., Vitest or Jest) and unit tests for handlers and services. Integration tests can use Prisma's sqlite adapter or a containerised PostgreSQL instance via docker-compose.
