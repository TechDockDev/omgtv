import type { OpenAPIV3 } from "openapi-types";
import { getServiceRegistry } from "./services";
import type { ServiceDocument } from "../utils/swagger-merge";

function findServiceByName(name: string) {
  const service = getServiceRegistry().find((entry) => entry.name === name);
  if (!service) {
    throw new Error(`Service definition for "${name}" is missing`);
  }
  return service;
}

const RESPONSE_ENVELOPE_REF = "#/components/schemas/ResponseEnvelope" as const;

const successEnvelope = (
  schema?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
  nullableData = false
): OpenAPIV3.SchemaObject => {
  const fallbackDataSchema: OpenAPIV3.SchemaObject = {
    type: "object",
    additionalProperties: true,
    nullable: true,
  };

  const dataSchema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject =
    schema !== undefined
      ? nullableData
        ? { allOf: [schema], nullable: true }
        : schema
      : fallbackDataSchema;

  return {
    allOf: [
      { $ref: RESPONSE_ENVELOPE_REF },
      {
        type: "object",
        required: ["success", "statusCode", "data"],
        properties: {
          success: { type: "boolean", enum: [true] },
          statusCode: { type: "integer", enum: [0] },
          data: dataSchema,
        },
      },
    ],
  };
};

const errorEnvelope = (): OpenAPIV3.SchemaObject => ({
  allOf: [
    { $ref: RESPONSE_ENVELOPE_REF },
    {
      type: "object",
      required: ["success", "statusCode", "data"],
      properties: {
        success: { type: "boolean", enum: [false] },
        statusCode: {
          type: "integer",
          format: "int32",
          minimum: 400,
          maximum: 599,
        },
        data: {
          type: "object",
          description: "Empty object for error responses.",
          additionalProperties: false,
        },
      },
    },
  ],
});

const successContent = (
  schema?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
  nullableData = false
): Record<string, OpenAPIV3.MediaTypeObject> => ({
  "application/json": {
    schema: successEnvelope(schema, nullableData),
  },
});

const errorContent = (): Record<string, OpenAPIV3.MediaTypeObject> => ({
  "application/json": {
    schema: errorEnvelope(),
  },
});

const authDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Auth Service API",
    version: "1.0.0",
    description: "Authentication and public identity workflows for PocketLOL.",
  },
  paths: {
    "/api/v1/auth/admin/login": {
      post: {
        summary: "Authenticate an administrator",
        description:
          "Validates administrator credentials and issues a JWT + refresh token pair scoped for administrative APIs.",
        tags: ["Auth Service"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AdminLoginRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Administrator authenticated successfully.",
            content: successContent({
              $ref: "#/components/schemas/TokenResponse",
            }),
          },
          "401": {
            description: "Invalid administrator credentials supplied.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/auth/admin/register": {
      post: {
        summary: "Register an administrator",
        description:
          "Creates an administrator credential using email and password and issues initial JWT + refresh tokens.",
        tags: ["Auth Service"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AdminRegisterRequest",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Administrator registered and authenticated.",
            content: successContent({
              $ref: "#/components/schemas/TokenResponse",
            }),
          },
          "409": {
            description: "Administrator email already exists.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/auth/customer/login": {
      post: {
        summary: "Exchange Firebase identity for PocketLOL tokens",
        description:
          "Validates a Firebase ID token for a customer account, ensuring the device context is recorded and issuing PocketLOL access and refresh tokens. Provide guestId when migrating an existing guest session; omit guestId for first-time customer login.",
        tags: ["Auth Service"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/CustomerLoginRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Customer authenticated successfully.",
            content: successContent({
              $ref: "#/components/schemas/TokenResponse",
            }),
          },
          "401": {
            description: "Firebase token invalid, expired, or mismatched.",
            content: errorContent(),
          },
          "409": {
            description: "Guest account already migrated to a customer.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/auth/guest/init": {
      post: {
        summary: "Initialize a guest session",
        description:
          "Issues guest-scoped JWT credentials for the supplied device identifier. A guestId is generated server-side and returned with the tokens so it can be reused for later migration to a customer profile.",
        tags: ["Auth Service"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/GuestInitRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Guest session initialized successfully.",
            content: successContent({
              $ref: "#/components/schemas/GuestInitResponse",
            }),
          },
          "409": {
            description: "Guest identifier already migrated to a customer.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/auth/token/refresh": {
      post: {
        summary: "Exchange refresh token for new credentials",
        description:
          "Rotates the refresh token and issues a new access token pair. Tokens are invalidated if expired or revoked.",
        tags: ["Auth Service"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/TokenRefreshRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Fresh access and refresh tokens returned.",
            content: successContent({
              $ref: "#/components/schemas/TokenResponse",
            }),
          },
          "401": {
            description: "Refresh token missing, expired, or invalid.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/auth/logout": {
      post: {
        summary: "Revoke refresh tokens",
        description:
          "Revokes active refresh tokens for the authenticated user. Supports revoking a single token, device-scoped logout, or all sessions.",
        tags: ["Auth Service"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/LogoutRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Sessions revoked successfully.",
            content: successContent(),
          },
          "401": {
            description: "Missing or invalid access token.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/auth/language": {
      patch: {
        summary: "Update preferred language",
        description:
          "Sets the user's preferred language and reissues tokens containing the language claim. Requires a valid access token.",
        tags: ["Auth Service"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdateLanguageRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Tokens reissued with updated language claim.",
            content: successContent({
              $ref: "#/components/schemas/UpdateLanguageResponse",
            }),
          },
          "401": {
            description: "Missing or invalid access token.",
            content: errorContent(),
          },
        },
        security: [{ bearerAuth: [] }],
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Authenticate with PocketLOL credentials by providing a bearer access token generated via the Auth Service login endpoint.",
      },
    },
    schemas: {
      AdminLoginRequest: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password"],
        properties: {
          email: {
            type: "string",
            format: "email",
            description:
              "Administrator email address registered with the platform.",
          },
          password: {
            type: "string",
            minLength: 8,
            description: "Administrator password.",
          },
        },
      },
      AdminRegisterRequest: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password"],
        properties: {
          email: {
            type: "string",
            format: "email",
            description: "Administrator email to register.",
          },
          password: {
            type: "string",
            minLength: 8,
            description: "Administrator password to hash and store.",
          },
        },
      },
      CustomerLoginRequest: {
        type: "object",
        additionalProperties: false,
        required: ["firebaseToken", "deviceId"],
        properties: {
          firebaseToken: {
            type: "string",
            description: "Firebase ID token obtained from the client SDK.",
          },
          deviceId: {
            type: "string",
            minLength: 3,
            maxLength: 128,
            description:
              "Device identifier used to scope the issued refresh token.",
          },
          guestId: {
            type: "string",
            minLength: 3,
            maxLength: 128,
            description:
              "Optional guest identifier to migrate an existing guest session to a customer profile. Leave empty when signing in as a brand-new customer with no prior guest session.",
          },
        },
      },
      GuestInitRequest: {
        type: "object",
        additionalProperties: false,
        required: ["deviceId"],
        properties: {
          deviceId: {
            type: "string",
            minLength: 3,
            maxLength: 128,
            description:
              "Device identifier to associate with the guest session.",
          },
        },
      },
      GuestInitResponse: {
        type: "object",
        additionalProperties: false,
        required: ["guestId", "tokens"],
        properties: {
          guestId: {
            type: "string",
            minLength: 3,
            maxLength: 128,
            description:
              "Server-generated guest identifier that remains stable for the device until migration to a customer account.",
          },
          tokens: {
            $ref: "#/components/schemas/TokenResponse",
          },
        },
      },
      TokenRefreshRequest: {
        type: "object",
        additionalProperties: false,
        required: ["refreshToken"],
        properties: {
          refreshToken: {
            type: "string",
            description: "Previously issued refresh token to exchange.",
          },
          deviceId: {
            type: "string",
            minLength: 3,
            maxLength: 128,
            description:
              "Optional client device identifier to scope the new session.",
          },
        },
      },
      LogoutRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          refreshToken: {
            type: "string",
            description:
              "Specific refresh token to revoke for the current user.",
          },
          deviceId: {
            type: "string",
            minLength: 3,
            maxLength: 128,
            description:
              "Revoke all refresh tokens associated with the supplied device identifier.",
          },
          allDevices: {
            type: "boolean",
            description:
              "When true, revoke all sessions for the authenticated user.",
          },
        },
        oneOf: [
          {
            required: ["allDevices"],
          },
          {
            required: ["refreshToken"],
          },
          {
            required: ["deviceId"],
          },
        ],
      },
      UpdateLanguageRequest: {
        type: "object",
        required: ["preferredLanguageId"],
        properties: {
          preferredLanguageId: {
            type: "string",
            description:
              "Language identifier to set for the user (default 'hi').",
          },
        },
      },
      UpdateLanguageResponse: {
        type: "object",
        additionalProperties: false,
        required: ["preferredLanguageId", "tokens"],
        properties: {
          preferredLanguageId: {
            type: "string",
            description: "Language identifier persisted for the user.",
          },
          tokens: {
            $ref: "#/components/schemas/TokenResponse",
          },
        },
      },
      TokenResponse: {
        type: "object",
        additionalProperties: false,
        required: [
          "accessToken",
          "refreshToken",
          "expiresIn",
          "refreshExpiresIn",
          "tokenType",
        ],
        properties: {
          accessToken: {
            type: "string",
            description: "JWT used for authenticated API calls.",
          },
          refreshToken: {
            type: "string",
            description: "Token used to request a new access token.",
          },
          expiresIn: {
            type: "integer",
            format: "int32",
            minimum: 1,
            description: "Seconds until the access token expires.",
          },
          refreshExpiresIn: {
            type: "integer",
            format: "int32",
            minimum: 1,
            description: "Seconds until the refresh token expires.",
          },
          tokenType: {
            type: "string",
            enum: ["Bearer"],
            description: "Token type as defined by OAuth 2.0.",
          },
        },
      },
      ResponseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: [
          "success",
          "statusCode",
          "userMessage",
          "developerMessage",
          "data",
        ],
        properties: {
          success: {
            type: "boolean",
            description:
              "Indicates whether the request completed successfully.",
          },
          statusCode: {
            type: "integer",
            format: "int32",
            description:
              "0 for success responses, otherwise mirrors the HTTP status code on errors.",
          },
          userMessage: {
            type: "string",
            description: "Message safe for end-user presentation.",
          },
          developerMessage: {
            type: "string",
            description:
              "Message with diagnostic detail suitable for developers.",
          },
          data: {
            type: "object",
            description: "Payload returned when the request succeeds.",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

const userDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "User Service API",
    version: "1.0.0",
    description: "Administrative user and role management APIs.",
  },
  paths: {
    "/api/v1/user/admin/users/{userId}/context": {
      get: {
        summary: "Fetch user RBAC context",
        description:
          "Returns the roles, permissions, and assignments for a user.",
        tags: ["User Service"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "userId",
            in: "path",
            required: true,
            description: "Identifier of the user.",
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "RBAC context for the requested user.",
            content: successContent({
              $ref: "#/components/schemas/UserContext",
            }),
          },
          "404": {
            description: "User was not found.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/user/admin/users/{userId}/roles": {
      post: {
        summary: "Assign a role to a user",
        description: "Creates a role assignment for the specified user.",
        tags: ["User Service"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/AssignRoleRequest",
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Role assignment created.",
            content: successContent({
              $ref: "#/components/schemas/AssignRoleResponse",
            }),
          },
          "400": {
            description: "Invalid request payload or parameters.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/user/admin/users/{userId}/roles/{assignmentId}": {
      delete: {
        summary: "Revoke a role assignment",
        description: "Revokes an existing role assignment for a user.",
        tags: ["User Service"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "assignmentId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Role assignment revoked successfully.",
            content: successContent(),
          },
          "404": {
            description: "Assignment was not found.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/user/admin/roles": {
      get: {
        summary: "List available roles",
        description: "Returns the collection of roles managed by the service.",
        tags: ["User Service"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Array of roles and associated permissions.",
            content: successContent({
              $ref: "#/components/schemas/ListRolesResponse",
            }),
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Authenticate with PocketLOL credentials by providing a bearer access token generated via the Auth Service login endpoint.",
      },
    },
    schemas: {
      Permission: {
        type: "object",
        additionalProperties: false,
        required: ["id", "resource", "action"],
        properties: {
          id: { type: "string", format: "uuid" },
          resource: { type: "string" },
          action: { type: "string" },
          description: { type: "string" },
        },
      },
      Role: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "isSystem", "permissions"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string" },
          isSystem: { type: "boolean" },
          permissions: {
            type: "array",
            items: { $ref: "#/components/schemas/Permission" },
          },
        },
      },
      RoleAssignment: {
        type: "object",
        additionalProperties: false,
        required: ["assignmentId", "userId", "active", "role"],
        properties: {
          assignmentId: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          scope: { type: "string" },
          grantedBy: { type: "string", format: "uuid" },
          active: { type: "boolean" },
          revokedAt: { type: "string", format: "date-time" },
          role: { $ref: "#/components/schemas/Role" },
        },
      },
      UserContext: {
        type: "object",
        additionalProperties: false,
        required: ["userId", "roles", "permissions", "assignments"],
        properties: {
          userId: { type: "string", format: "uuid" },
          roles: {
            type: "array",
            items: { $ref: "#/components/schemas/Role" },
          },
          permissions: {
            type: "array",
            items: { $ref: "#/components/schemas/Permission" },
          },
          assignments: {
            type: "array",
            items: { $ref: "#/components/schemas/RoleAssignment" },
          },
        },
      },
      AssignRoleRequest: {
        type: "object",
        additionalProperties: false,
        required: ["roleId"],
        properties: {
          roleId: { type: "string", format: "uuid" },
          scope: { type: "string", minLength: 1, maxLength: 128 },
          grantedBy: { type: "string", format: "uuid" },
        },
      },
      AssignRoleResponse: {
        type: "object",
        additionalProperties: false,
        required: ["assignment"],
        properties: {
          assignment: {
            $ref: "#/components/schemas/RoleAssignment",
          },
        },
      },
      ListRolesResponse: {
        type: "object",
        additionalProperties: false,
        required: ["roles"],
        properties: {
          roles: {
            type: "array",
            items: { $ref: "#/components/schemas/Role" },
          },
        },
      },
      ResponseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: [
          "success",
          "statusCode",
          "userMessage",
          "developerMessage",
          "data",
        ],
        properties: {
          success: {
            type: "boolean",
            description:
              "Indicates whether the request completed successfully.",
          },
          statusCode: {
            type: "integer",
            format: "int32",
            description:
              "0 for success responses, otherwise mirrors the HTTP status code on errors.",
          },
          userMessage: {
            type: "string",
            description: "Message safe for end-user presentation.",
          },
          developerMessage: {
            type: "string",
            description:
              "Message with diagnostic detail suitable for developers.",
          },
          data: {
            type: "object",
            description: "Payload returned when the request succeeds.",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

const contentDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Content Service Viewer API",
    version: "1.0.0",
    description:
      "Catalog browsing and playback metadata used by the PocketLOL clients.",
  },
  paths: {
    "/api/v1/content/catalog/feed": {
      get: {
        summary: "Fetch catalog feed",
        description:
          "Returns a paginated list of episodes tailored for the viewer feed, sorted by recent publication and trending signals.",
        tags: ["Content Service"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 1,
              maximum: 50,
            },
            description: "Maximum number of feed items to return (default 20).",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: {
              type: "string",
            },
            description:
              "Opaque cursor from a previous feed response. Pass to continue pagination.",
          },
          {
            name: "viewerId",
            in: "query",
            required: false,
            schema: {
              type: "string",
              format: "uuid",
            },
            description:
              "Optional viewer identifier used for personalization hints.",
          },
        ],
        responses: {
          "200": {
            description: "Feed items available for playback.",
            content: successContent({
              $ref: "#/components/schemas/CatalogFeedResponse",
            }),
          },
        },
      },
    },
    "/api/v1/content/catalog/series/{slug}": {
      get: {
        summary: "Get series detail",
        description:
          "Retrieves a published series with season breakdown and playable episodes.",
        tags: ["Content Service"],
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            description: "Slug identifier for the requested series.",
            schema: {
              type: "string",
            },
          },
        ],
        responses: {
          "200": {
            description:
              "Series detail including all seasons and standalone episodes.",
            content: successContent({
              $ref: "#/components/schemas/CatalogSeriesDetail",
            }),
          },
          "404": {
            description: "Series was not found or is unavailable.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/catalog/series/{slug}/related": {
      get: {
        summary: "List related series",
        description:
          "Returns featured series that share a category or trending affinity with the requested series.",
        tags: ["Content Service"],
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            schema: {
              type: "string",
            },
            description: "Slug identifier of the source series.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 1,
              maximum: 20,
            },
            description:
              "Maximum number of related series to return (default 10).",
          },
        ],
        responses: {
          "200": {
            description: "Related catalog entries.",
            content: successContent({
              $ref: "#/components/schemas/CatalogRelatedSeriesResponse",
            }),
          },
          "404": {
            description: "Series was not found or is unavailable.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/mobile/tags": {
      get: {
        summary: "List mobile navigation tags",
        description:
          "Returns the dynamic navigation tags used by the PocketLOL mobile client, ordered for display.",
        tags: ["Content Service"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 1,
              maximum: 50,
            },
            description: "Maximum number of tags to return (default 20).",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
            description:
              "Opaque cursor returned by a previous call for pagination.",
          },
        ],
        responses: {
          "200": {
            description: "Navigation tags returned.",
            content: successContent({
              $ref: "#/components/schemas/MobileTagsData",
            }),
          },
        },
      },
    },
    "/api/v1/content/mobile/home": {
      get: {
        summary: "Fetch mobile home experience",
        description:
          "Generates the carousel, continue watch rows, dynamic sections, and pagination metadata for the mobile home tab.",
        tags: ["Content Service"],
        parameters: [
          {
            name: "tag",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "Optional navigation tag (e.g., home, popular, gaming) to scope results.",
          },
          {
            name: "page",
            in: "query",
            required: false,
            schema: { type: "integer", format: "int32", minimum: 1 },
            description:
              "Client-side page number for analytics (cursor-based pagination is primary).",
          },
          {
            name: "language_id",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "Preferred language identifier supplied by the user token.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 5,
              maximum: 50,
            },
            description:
              "Override the number of feed items evaluated for the home response.",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string" },
            description:
              "Opaque cursor returned via pagination.nextCursor for fetching the next slice.",
          },
        ],
        responses: {
          "200": {
            description: "Home payload ready for rendering.",
            content: successContent({
              $ref: "#/components/schemas/MobileHomeData",
            }),
          },
        },
      },
    },
    "/api/v1/content/mobile/series/{seriesId}": {
      get: {
        summary: "Fetch mobile series detail",
        description:
          "Returns series synopsis, trailer metadata, full episode list, and placeholder review aggregates for the mobile client.",
        tags: ["Content Service"],
        parameters: [
          {
            name: "seriesId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Series slug or identifier to fetch.",
          },
        ],
        responses: {
          "200": {
            description: "Series detail returned.",
            content: successContent({
              $ref: "#/components/schemas/MobileSeriesData",
            }),
          },
          "404": {
            description: "Series not found.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/mobile/reels": {
      get: {
        summary: "List reels for mobile",
        description:
          "Provides short-form reel metadata, streaming manifests, and pagination for the reels surface.",
        tags: ["Content Service"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 5,
              maximum: 50,
            },
            description: "Maximum number of reels to return (default 20).",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Opaque cursor from the previous reels list.",
          },
          {
            name: "page",
            in: "query",
            required: false,
            schema: { type: "integer", format: "int32", minimum: 1 },
            description: "Optional page counter for analytics.",
          },
        ],
        responses: {
          "200": {
            description: "Reels payload generated.",
            content: successContent({
              $ref: "#/components/schemas/MobileReelsData",
            }),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/categories": {
      get: {
        summary: "List categories",
        description: "Returns paginated categories for admin management.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 1,
              maximum: 100,
            },
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Categories fetched successfully.",
            content: successContent({
              $ref: "#/components/schemas/AdminCategoryListResponse",
            }),
          },
        },
      },
      post: {
        summary: "Create category",
        description:
          "Creates a new catalog category. Admin authentication required.",
        tags: ["Content Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CategoryWriteRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Category created.",
            content: successContent({
              $ref: "#/components/schemas/AdminCategory",
            }),
          },
          "409": {
            description: "Category slug already exists.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/categories/{id}": {
      get: {
        summary: "Get category",
        description: "Returns a category by ID for admin editing.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Category detail.",
            content: successContent({
              $ref: "#/components/schemas/AdminCategory",
            }),
          },
          "404": {
            description: "Category not found.",
            content: errorContent(),
          },
        },
      },
      put: {
        summary: "Replace category",
        description: "Replaces category fields with provided payload.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CategoryWriteRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Category replaced.",
            content: successContent({
              $ref: "#/components/schemas/AdminCategory",
            }),
          },
          "404": {
            description: "Category not found.",
            content: errorContent(),
          },
          "409": {
            description: "Category slug conflict.",
            content: errorContent(),
          },
        },
      },
      patch: {
        summary: "Update category",
        description: "Partial update of category fields.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CategoryUpdateRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Category updated.",
            content: successContent({
              $ref: "#/components/schemas/AdminCategory",
            }),
          },
          "404": {
            description: "Category not found.",
            content: errorContent(),
          },
          "409": {
            description: "Category slug conflict.",
            content: errorContent(),
          },
        },
      },
      delete: {
        summary: "Delete category",
        description: "Soft deletes a category.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Category deleted.",
            content: successContent(),
          },
          "404": {
            description: "Category not found.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/carousel": {
      post: {
        summary: "Replace mobile carousel selections",
        description:
          "Allows administrators to curate the mobile carousel by referencing existing series or episodes. The supplied list replaces the entire carousel order in a single request.",
        tags: ["Content Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdminCarouselRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Carousel entries saved.",
            content: successContent({
              $ref: "#/components/schemas/AdminCarouselResponse",
            }),
          },
          "404": {
            description:
              "One or more referenced series or episodes were not found.",
            content: errorContent(),
          },
          "412": {
            description:
              "Selections failed validation (visibility, publication, or duplicate entries).",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/tags": {
      get: {
        summary: "List tags",
        description: "Returns paginated tag definitions for admin management.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 1,
              maximum: 100,
            },
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Tags fetched successfully.",
            content: successContent({
              $ref: "#/components/schemas/AdminTagListResponse",
            }),
          },
        },
      },
      post: {
        summary: "Create tag",
        description:
          "Creates a tag that can be attached to episodes and reels.",
        tags: ["Content Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TagWriteRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Tag created.",
            content: successContent({ $ref: "#/components/schemas/AdminTag" }),
          },
          "409": {
            description: "Tag name or slug already exists.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/episodes/{id}/tags": {
      patch: {
        summary: "Update episode tags",
        description: "Replaces the tag set applied to an episode.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TagAssignmentRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Episode tags updated.",
            content: successContent({
              $ref: "#/components/schemas/TagAssignmentResponse",
            }),
          },
          "404": {
            description: "Episode not found.",
            content: errorContent(),
          },
          "412": {
            description: "One or more tags are undefined.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/reels/{id}/tags": {
      patch: {
        summary: "Update reel tags",
        description: "Replaces the tag set applied to a reel.",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TagAssignmentRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Reel tags updated.",
            content: successContent({
              $ref: "#/components/schemas/TagAssignmentResponse",
            }),
          },
          "404": {
            description: "Reel not found.",
            content: errorContent(),
          },
          "412": {
            description: "One or more tags are undefined.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/series": {
      post: {
        summary: "Create series",
        description: "Creates a series with optional category binding.",
        tags: ["Content Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdminSeriesRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Series created.",
            content: successContent(),
          },
          "409": {
            description: "Slug already exists.",
            content: errorContent(),
          },
          "412": {
            description: "Category missing or archived.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/series/{id}": {
      patch: {
        summary: "Update series",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdminSeriesUpdateRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Series updated.",
            content: successContent(),
          },
          "404": {
            description: "Series not found.",
            content: errorContent(),
          },
          "409": {
            description: "Slug conflict.",
            content: errorContent(),
          },
          "412": {
            description: "Category missing or archived.",
            content: errorContent(),
          },
        },
      },
      delete: {
        summary: "Delete series",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Series deleted.",
            content: successContent(),
          },
          "404": {
            description: "Series not found.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/seasons": {
      post: {
        summary: "Create season",
        tags: ["Content Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdminSeasonRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Season created.",
            content: successContent(),
          },
          "404": {
            description: "Series not found.",
            content: errorContent(),
          },
          "409": {
            description: "Duplicate sequence.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/episodes": {
      post: {
        summary: "Create episode",
        tags: ["Content Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdminEpisodeRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Episode created.",
            content: successContent(),
          },
          "404": {
            description: "Series/season not found.",
            content: errorContent(),
          },
          "409": {
            description: "Slug conflict.",
            content: errorContent(),
          },
        },
      },
      get: {
        summary: "Moderation queue",
        description: "List episodes pending moderation.",
        tags: ["Content Service - Admin"],
        responses: {
          "200": {
            description: "Moderation queue items.",
            content: successContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/episodes/{id}/transition": {
      post: {
        summary: "Transition episode status",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EpisodeTransitionRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Episode transitioned.",
            content: successContent(),
          },
          "404": {
            description: "Episode not found.",
            content: errorContent(),
          },
          "409": {
            description: "Invalid state.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/episodes/{id}/assets": {
      patch: {
        summary: "Update episode assets",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EpisodeAssetRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Assets updated.",
            content: successContent(),
          },
          "404": {
            description: "Episode not found.",
            content: errorContent(),
          },
          "412": {
            description: "Precondition failed.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/content/admin/catalog/episodes/{id}": {
      delete: {
        summary: "Delete episode",
        tags: ["Content Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Episode deleted.",
            content: successContent(),
          },
          "404": {
            description: "Episode not found.",
            content: errorContent(),
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Authenticate with PocketLOL credentials by providing a bearer access token generated via the Auth Service login endpoint.",
      },
    },
    schemas: {
      CategoryWriteRequest: {
        type: "object",
        required: ["slug", "name"],
        additionalProperties: false,
        properties: {
          slug: { type: "string", minLength: 3 },
          name: { type: "string", minLength: 1 },
          description: { type: "string", maxLength: 1000, nullable: true },
          displayOrder: { type: "integer", format: "int32", nullable: true },
        },
      },
      CategoryUpdateRequest: {
        allOf: [
          { $ref: "#/components/schemas/CategoryWriteRequest" },
          {
            required: [],
            description: "Partial update. At least one field required.",
          },
        ],
      },
      AdminCategory: {
        type: "object",
        additionalProperties: false,
        required: ["id", "slug", "name", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          displayOrder: { type: "integer", format: "int32", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      AdminCategoryListResponse: {
        type: "object",
        additionalProperties: false,
        required: ["items", "nextCursor"],
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/AdminCategory" },
          },
          nextCursor: { type: "string", format: "uuid", nullable: true },
        },
      },
      TagWriteRequest: {
        type: "object",
        required: ["name"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1 },
          description: { type: "string", maxLength: 512, nullable: true },
          slug: { type: "string", minLength: 1 },
        },
      },
      AdminTag: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "slug", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          slug: { type: "string" },
          description: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      AdminTagListResponse: {
        type: "object",
        additionalProperties: false,
        required: ["items", "nextCursor"],
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/AdminTag" },
          },
          nextCursor: { type: "string", format: "uuid", nullable: true },
        },
      },
      TagAssignmentRequest: {
        type: "object",
        required: ["tags"],
        additionalProperties: false,
        properties: {
          tags: { type: "array", items: { type: "string" }, minItems: 0 },
        },
      },
      TagAssignmentResponse: {
        type: "object",
        additionalProperties: false,
        required: ["id", "tags"],
        properties: {
          id: { type: "string", format: "uuid" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      AdminCarouselSelection: {
        type: "object",
        additionalProperties: false,
        properties: {
          seriesId: { type: "string", format: "uuid" },
          episodeId: { type: "string", format: "uuid" },
        },
        oneOf: [
          { required: ["seriesId"], not: { required: ["episodeId"] } },
          { required: ["episodeId"], not: { required: ["seriesId"] } },
        ],
      },
      AdminCarouselRequest: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { $ref: "#/components/schemas/AdminCarouselSelection" },
          },
        },
      },
      AdminCarouselSeries: {
        type: "object",
        additionalProperties: false,
        required: ["id", "slug", "title"],
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string" },
          title: { type: "string" },
          synopsis: { type: "string", nullable: true },
          heroImageUrl: { type: "string", format: "uri", nullable: true },
          bannerImageUrl: { type: "string", format: "uri", nullable: true },
          category: { type: "string", nullable: true },
        },
      },
      AdminCarouselEpisode: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "slug",
          "title",
          "seriesId",
          "seriesTitle",
          "durationSeconds",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string" },
          title: { type: "string" },
          seriesId: { type: "string", format: "uuid" },
          seriesTitle: { type: "string" },
          durationSeconds: { type: "integer", format: "int32", minimum: 1 },
          manifestUrl: { type: "string", format: "uri", nullable: true },
          thumbnailUrl: { type: "string", format: "uri", nullable: true },
          publishedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      AdminCarouselEntry: {
        type: "object",
        additionalProperties: false,
        required: ["id", "position", "type"],
        properties: {
          id: { type: "string", format: "uuid" },
          position: { type: "integer", format: "int32", minimum: 1 },
          type: { type: "string", enum: ["episode", "series"] },
          series: {
            allOf: [{ $ref: "#/components/schemas/AdminCarouselSeries" }],
            nullable: true,
          },
          episode: {
            allOf: [{ $ref: "#/components/schemas/AdminCarouselEpisode" }],
            nullable: true,
          },
        },
      },
      AdminCarouselResponse: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/AdminCarouselEntry" },
          },
        },
      },
      AdminSeriesRequest: {
        type: "object",
        required: ["slug", "title"],
        properties: {
          slug: { type: "string", minLength: 3 },
          title: { type: "string", minLength: 1 },
          synopsis: { type: "string", maxLength: 5000 },
          heroImageUrl: { type: "string", format: "uri" },
          bannerImageUrl: { type: "string", format: "uri" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["DRAFT", "PUBLISHED", "ARCHIVED"] },
          visibility: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
          releaseDate: { type: "string", format: "date-time" },
          ownerId: { type: "string", format: "uuid" },
          categoryId: { type: "string", format: "uuid" },
        },
      },
      AdminSeriesUpdateRequest: {
        allOf: [{ $ref: "#/components/schemas/AdminSeriesRequest" }],
        description: "Partial update of series fields.",
      },
      AdminSeasonRequest: {
        type: "object",
        required: ["seriesId", "sequenceNumber", "title"],
        properties: {
          seriesId: { type: "string", format: "uuid" },
          sequenceNumber: { type: "integer", format: "int32", minimum: 0 },
          title: { type: "string" },
          synopsis: { type: "string", maxLength: 5000 },
          releaseDate: { type: "string", format: "date-time" },
        },
      },
      AdminEpisodeRequest: {
        type: "object",
        required: ["seriesId", "slug", "title", "durationSeconds"],
        properties: {
          seriesId: { type: "string", format: "uuid" },
          seasonId: { type: "string", format: "uuid" },
          slug: { type: "string", minLength: 3 },
          title: { type: "string", minLength: 1 },
          synopsis: { type: "string", maxLength: 5000 },
          durationSeconds: { type: "integer", format: "int32", minimum: 1 },
          status: { type: "string", enum: ["DRAFT", "PUBLISHED", "ARCHIVED"] },
          visibility: { type: "string", enum: ["PUBLIC", "PRIVATE"] },
          publishedAt: { type: "string", format: "date-time" },
          availabilityStart: { type: "string", format: "date-time" },
          availabilityEnd: { type: "string", format: "date-time" },
          heroImageUrl: { type: "string", format: "uri" },
          defaultThumbnailUrl: { type: "string", format: "uri" },
          captions: { type: "object", additionalProperties: true },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      EpisodeTransitionRequest: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["DRAFT", "PUBLISHED", "ARCHIVED"] },
        },
      },
      EpisodeAssetRequest: {
        type: "object",
        required: ["status"],
        properties: {
          status: {
            type: "string",
            enum: ["PENDING", "PROCESSING", "READY", "FAILED"],
          },
          sourceUploadId: { type: "string", nullable: true },
          streamingAssetId: { type: "string", nullable: true },
          manifestUrl: { type: "string", format: "uri", nullable: true },
          defaultThumbnailUrl: {
            type: "string",
            format: "uri",
            nullable: true,
          },
          variants: {
            type: "array",
            items: {
              type: "object",
              required: ["width", "height", "bitrateKbps", "url"],
              properties: {
                width: { type: "integer", format: "int32" },
                height: { type: "integer", format: "int32" },
                bitrateKbps: { type: "integer", format: "int32" },
                url: { type: "string", format: "uri" },
              },
            },
          },
        },
      },
      CatalogCategory: {
        type: "object",
        additionalProperties: false,
        required: ["id", "slug", "name"],
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string" },
          name: { type: "string" },
        },
      },
      CatalogPlaybackVariant: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: {
          label: { type: "string" },
          width: {
            type: "integer",
            format: "int32",
            minimum: 1,
            nullable: true,
          },
          height: {
            type: "integer",
            format: "int32",
            minimum: 1,
            nullable: true,
          },
          bitrateKbps: {
            type: "integer",
            format: "int32",
            minimum: 1,
            nullable: true,
          },
          codec: { type: "string", nullable: true },
          frameRate: { type: "number", minimum: 0, nullable: true },
        },
      },
      CatalogPlayback: {
        type: "object",
        additionalProperties: false,
        required: ["status", "manifestUrl", "defaultThumbnailUrl", "variants"],
        properties: {
          status: {
            type: "string",
            enum: ["PENDING", "PROCESSING", "READY", "FAILED"],
          },
          manifestUrl: { type: "string", format: "uri", nullable: true },
          defaultThumbnailUrl: {
            type: "string",
            format: "uri",
            nullable: true,
          },
          variants: {
            type: "array",
            items: { $ref: "#/components/schemas/CatalogPlaybackVariant" },
          },
        },
      },
      CatalogLocalizationCaption: {
        type: "object",
        additionalProperties: false,
        required: ["language"],
        properties: {
          language: { type: "string" },
          label: { type: "string" },
          url: { type: "string", format: "uri" },
        },
      },
      CatalogLocalization: {
        type: "object",
        additionalProperties: false,
        required: ["captions", "availableLanguages"],
        properties: {
          captions: {
            type: "array",
            items: { $ref: "#/components/schemas/CatalogLocalizationCaption" },
          },
          availableLanguages: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      CatalogSeriesSummary: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "slug",
          "title",
          "synopsis",
          "heroImageUrl",
          "bannerImageUrl",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string" },
          title: { type: "string" },
          synopsis: { type: "string", nullable: true },
          heroImageUrl: { type: "string", format: "uri", nullable: true },
          bannerImageUrl: { type: "string", format: "uri", nullable: true },
          category: {
            $ref: "#/components/schemas/CatalogCategory",
          },
        },
      },
      CatalogFeedItem: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "slug",
          "title",
          "synopsis",
          "heroImageUrl",
          "defaultThumbnailUrl",
          "durationSeconds",
          "tags",
          "publishedAt",
          "availability",
          "season",
          "series",
          "playback",
          "localization",
          "personalization",
          "ratings",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          slug: { type: "string" },
          title: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          synopsis: { type: "string", nullable: true },
          heroImageUrl: { type: "string", format: "uri", nullable: true },
          defaultThumbnailUrl: {
            type: "string",
            format: "uri",
            nullable: true,
          },
          durationSeconds: { type: "integer", format: "int32", minimum: 0 },
          publishedAt: { type: "string", format: "date-time" },
          availability: {
            type: "object",
            required: ["start", "end"],
            properties: {
              start: { type: "string", format: "date-time", nullable: true },
              end: { type: "string", format: "date-time", nullable: true },
            },
          },
          season: {
            type: "object",
            nullable: true,
            required: ["id", "sequenceNumber", "title"],
            properties: {
              id: { type: "string", format: "uuid" },
              sequenceNumber: {
                type: "integer",
                format: "int32",
                minimum: 0,
              },
              title: { type: "string", nullable: true },
            },
          },
          series: {
            $ref: "#/components/schemas/CatalogSeriesSummary",
          },
          playback: {
            $ref: "#/components/schemas/CatalogPlayback",
          },
          localization: {
            $ref: "#/components/schemas/CatalogLocalization",
          },
          personalization: {
            type: "object",
            additionalProperties: false,
            required: ["reason"],
            properties: {
              reason: {
                type: "string",
                enum: ["trending", "recent", "viewer_following"],
              },
              score: { type: "number" },
            },
          },
          ratings: {
            type: "object",
            additionalProperties: false,
            required: ["average"],
            properties: {
              average: { type: "number", minimum: 0, nullable: true },
            },
          },
        },
      },
      CatalogFeedResponse: {
        type: "object",
        additionalProperties: false,
        required: ["items", "nextCursor"],
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/CatalogFeedItem" },
          },
          nextCursor: { type: "string", nullable: true },
        },
      },
      CatalogSeriesSeason: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "sequenceNumber",
          "title",
          "synopsis",
          "releaseDate",
          "episodes",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          sequenceNumber: {
            type: "integer",
            format: "int32",
            minimum: 0,
          },
          title: { type: "string" },
          synopsis: { type: "string", nullable: true },
          releaseDate: { type: "string", format: "date-time", nullable: true },
          episodes: {
            type: "array",
            items: { $ref: "#/components/schemas/CatalogFeedItem" },
          },
        },
      },
      CatalogSeriesDetail: {
        type: "object",
        additionalProperties: false,
        required: ["series", "seasons", "standaloneEpisodes"],
        properties: {
          series: {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "slug",
              "title",
              "synopsis",
              "heroImageUrl",
              "bannerImageUrl",
              "tags",
              "releaseDate",
              "category",
            ],
            properties: {
              id: { type: "string", format: "uuid" },
              slug: { type: "string" },
              title: { type: "string" },
              synopsis: { type: "string", nullable: true },
              heroImageUrl: { type: "string", format: "uri", nullable: true },
              bannerImageUrl: { type: "string", format: "uri", nullable: true },
              tags: {
                type: "array",
                items: { type: "string" },
              },
              releaseDate: {
                type: "string",
                format: "date-time",
                nullable: true,
              },
              category: {
                $ref: "#/components/schemas/CatalogCategory",
              },
            },
          },
          seasons: {
            type: "array",
            items: { $ref: "#/components/schemas/CatalogSeriesSeason" },
          },
          standaloneEpisodes: {
            type: "array",
            items: { $ref: "#/components/schemas/CatalogFeedItem" },
          },
        },
      },
      CatalogRelatedSeriesResponse: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "id",
                "slug",
                "title",
                "synopsis",
                "heroImageUrl",
                "bannerImageUrl",
                "category",
              ],
              properties: {
                id: { type: "string", format: "uuid" },
                slug: { type: "string" },
                title: { type: "string" },
                synopsis: { type: "string", nullable: true },
                heroImageUrl: {
                  type: "string",
                  format: "uri",
                  nullable: true,
                },
                bannerImageUrl: {
                  type: "string",
                  format: "uri",
                  nullable: true,
                },
                category: {
                  $ref: "#/components/schemas/CatalogCategory",
                },
              },
            },
          },
        },
      },
      MobileStreamingVariant: {
        type: "object",
        additionalProperties: false,
        required: ["quality", "bitrate", "resolution", "size_mb", "url"],
        properties: {
          quality: { type: "string" },
          bitrate: { type: "string", nullable: true },
          resolution: { type: "string", nullable: true },
          size_mb: { type: "number", nullable: true },
          url: { type: "string", format: "uri", nullable: true },
        },
      },
      MobileStreaming: {
        type: "object",
        additionalProperties: false,
        required: [
          "can_watch",
          "plan_purchased",
          "type",
          "master_playlist",
          "qualities",
        ],
        properties: {
          can_watch: { type: "boolean" },
          plan_purchased: { type: "boolean" },
          type: { type: "string" },
          master_playlist: { type: "string", format: "uri", nullable: true },
          qualities: {
            type: "array",
            items: { $ref: "#/components/schemas/MobileStreamingVariant" },
          },
        },
      },
      MobileProgress: {
        type: "object",
        additionalProperties: false,
        required: [
          "watched_duration",
          "total_duration",
          "percentage",
          "last_watched_at",
          "is_completed",
        ],
        properties: {
          watched_duration: { type: "integer", format: "int32", minimum: 0 },
          total_duration: { type: "integer", format: "int32", minimum: 1 },
          percentage: { type: "number", minimum: 0 },
          last_watched_at: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          is_completed: { type: "boolean" },
        },
      },
      MobileCarouselItem: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "priority",
          "type",
          "title",
          "subtitle",
          "thumbnailUrl",
          "videoUrl",
          "rating",
          "series_id",
        ],
        properties: {
          id: { type: "string" },
          priority: { type: "integer", format: "int32", minimum: 1 },
          type: { type: "string" },
          title: { type: "string" },
          subtitle: { type: "string", nullable: true },
          thumbnailUrl: { type: "string", format: "uri", nullable: true },
          videoUrl: { type: "string", format: "uri", nullable: true },
          rating: { type: "number", nullable: true },
          series_id: { type: "string", nullable: true },
        },
      },
      MobileContinueWatchItem: {
        type: "object",
        additionalProperties: false,
        required: [
          "series_id",
          "episode_id",
          "episode",
          "series_title",
          "title",
          "thumbnail",
          "duration_seconds",
          "streaming",
          "progress",
          "rating",
        ],
        properties: {
          series_id: { type: "string" },
          episode_id: { type: "string" },
          episode: { type: "integer", format: "int32", nullable: true },
          series_title: { type: "string" },
          title: { type: "string" },
          thumbnail: { type: "string", format: "uri", nullable: true },
          duration_seconds: { type: "integer", format: "int32", minimum: 1 },
          streaming: { $ref: "#/components/schemas/MobileStreaming" },
          progress: { $ref: "#/components/schemas/MobileProgress" },
          rating: { type: "number", nullable: true },
        },
      },
      MobileSectionItem: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "type",
          "title",
          "subtitle",
          "thumbnailUrl",
          "duration",
          "watchedDuration",
          "progress",
          "rating",
          "lastWatchedAt",
          "series_id",
        ],
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          title: { type: "string" },
          subtitle: { type: "string", nullable: true },
          thumbnailUrl: { type: "string", format: "uri", nullable: true },
          duration: { type: "string", nullable: true },
          watchedDuration: { type: "string", nullable: true },
          progress: { type: "number", nullable: true },
          rating: { type: "number", nullable: true },
          lastWatchedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          series_id: { type: "string", nullable: true },
        },
      },
      MobileSection: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "title", "priority", "items"],
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          title: { type: "string" },
          priority: { type: "integer", format: "int32", minimum: 1 },
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/MobileSectionItem" },
          },
        },
      },
      MobilePagination: {
        type: "object",
        additionalProperties: false,
        required: ["currentPage", "totalPages", "hasNextPage"],
        properties: {
          currentPage: { type: "integer", format: "int32", minimum: 1 },
          totalPages: { type: "integer", format: "int32", minimum: 1 },
          hasNextPage: { type: "boolean" },
          nextCursor: { type: "string", nullable: true },
        },
      },
      MobileHomeData: {
        type: "object",
        additionalProperties: false,
        required: ["carousel", "continue watch", "sections", "pagination"],
        properties: {
          carousel: {
            type: "array",
            items: { $ref: "#/components/schemas/MobileCarouselItem" },
          },
          "continue watch": {
            type: "array",
            items: { $ref: "#/components/schemas/MobileContinueWatchItem" },
          },
          sections: {
            type: "array",
            items: { $ref: "#/components/schemas/MobileSection" },
          },
          pagination: { $ref: "#/components/schemas/MobilePagination" },
        },
      },
      MobileTag: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "order", "slug"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          order: { type: "integer", format: "int32", minimum: 1 },
          slug: { type: "string" },
        },
      },
      MobileTagsData: {
        type: "object",
        additionalProperties: false,
        required: ["tags", "pagination"],
        properties: {
          tags: {
            type: "array",
            items: { $ref: "#/components/schemas/MobileTag" },
          },
          pagination: {
            type: "object",
            additionalProperties: false,
            required: ["nextCursor"],
            properties: {
              nextCursor: { type: "string", format: "uuid", nullable: true },
            },
          },
        },
      },
      MobileSeriesEpisode: {
        type: "object",
        additionalProperties: false,
        required: [
          "series_id",
          "episode_id",
          "episode",
          "season",
          "title",
          "description",
          "thumbnail",
          "duration_seconds",
          "release_date",
          "is_download_allowed",
          "rating",
          "views",
          "streaming",
          "progress",
        ],
        properties: {
          series_id: { type: "string" },
          episode_id: { type: "string" },
          episode: { type: "integer", format: "int32", nullable: true },
          season: { type: "integer", format: "int32", nullable: true },
          title: { type: "string" },
          description: { type: "string", nullable: true },
          thumbnail: { type: "string", format: "uri", nullable: true },
          duration_seconds: { type: "integer", format: "int32", minimum: 1 },
          release_date: { type: "string", format: "date-time", nullable: true },
          is_download_allowed: { type: "boolean" },
          rating: { type: "number", nullable: true },
          views: { type: "number", nullable: true },
          streaming: { $ref: "#/components/schemas/MobileStreaming" },
          progress: { $ref: "#/components/schemas/MobileProgress" },
        },
      },
      MobileSeriesReviews: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "user_reviews"],
        properties: {
          summary: {
            type: "object",
            additionalProperties: false,
            required: ["average_rating", "total_reviews"],
            properties: {
              average_rating: { type: "number", nullable: true },
              total_reviews: { type: "integer", format: "int32", minimum: 0 },
            },
          },
          user_reviews: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "review_id",
                "user_id",
                "user_name",
                "rating",
                "title",
                "comment",
                "created_at",
              ],
              properties: {
                review_id: { type: "string" },
                user_id: { type: "string", nullable: true },
                user_name: { type: "string", nullable: true },
                rating: { type: "number", nullable: true },
                title: { type: "string", nullable: true },
                comment: { type: "string", nullable: true },
                created_at: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      MobileSeriesData: {
        type: "object",
        additionalProperties: false,
        required: [
          "series_id",
          "series_title",
          "synopsis",
          "thumbnail",
          "banner",
          "tags",
          "category",
          "trailer",
          "episodes",
          "reviews",
        ],
        properties: {
          series_id: { type: "string" },
          series_title: { type: "string" },
          synopsis: { type: "string", nullable: true },
          thumbnail: { type: "string", format: "uri", nullable: true },
          banner: { type: "string", format: "uri", nullable: true },
          tags: { type: "array", items: { type: "string" } },
          category: { type: "string", nullable: true },
          trailer: {
            type: "object",
            nullable: true,
            additionalProperties: false,
            required: ["thumbnail", "duration_seconds", "streaming"],
            properties: {
              thumbnail: { type: "string", format: "uri", nullable: true },
              duration_seconds: {
                type: "integer",
                format: "int32",
                minimum: 1,
              },
              streaming: { $ref: "#/components/schemas/MobileStreaming" },
            },
          },
          episodes: {
            type: "array",
            items: { $ref: "#/components/schemas/MobileSeriesEpisode" },
          },
          reviews: { $ref: "#/components/schemas/MobileSeriesReviews" },
        },
      },
      MobileReelItem: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "description",
          "duration_seconds",
          "rating",
          "thumbnail",
          "streaming",
        ],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string", nullable: true },
          duration_seconds: { type: "integer", format: "int32", minimum: 1 },
          rating: { type: "number", nullable: true },
          thumbnail: { type: "string", format: "uri", nullable: true },
          streaming: { $ref: "#/components/schemas/MobileStreaming" },
        },
      },
      MobileReelsData: {
        type: "object",
        additionalProperties: false,
        required: ["items", "pagination"],
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/MobileReelItem" },
          },
          pagination: { $ref: "#/components/schemas/MobilePagination" },
        },
      },
      ResponseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: [
          "success",
          "statusCode",
          "userMessage",
          "developerMessage",
          "data",
        ],
        properties: {
          success: {
            type: "boolean",
            description:
              "Indicates whether the request completed successfully.",
          },
          statusCode: {
            type: "integer",
            format: "int32",
            description:
              "0 for success responses, otherwise mirrors the HTTP status code on errors.",
          },
          userMessage: {
            type: "string",
            description: "Message safe for end-user presentation.",
          },
          developerMessage: {
            type: "string",
            description:
              "Message with diagnostic detail suitable for developers.",
          },
          data: {
            type: "object",
            description: "Payload returned when the request succeeds.",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

const engagementDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Engagement Service API",
    version: "1.0.0",
    description:
      "Likes, saves, views, and engagement stats captured for PocketLOL reels and series.",
  },
  paths: {
    "/like": {
      post: {
        summary: "Publish an engagement event",
        description:
          "Publishes an engagement action (like/unlike/view/favorite) for a video.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EngagementEventBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Engagement event recorded successfully.",
            content: successContent({
              $ref: "#/components/schemas/EngagementEventData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": {
            description: "Internal error.",
            content: errorContent(),
          },
        },
      },
    },
    "/reels/{id}/save": {
      post: {
        summary: "Save a reel",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Reel saved.",
            content: successContent({
              $ref: "#/components/schemas/EngagementSaveData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": {
            description: "Internal error.",
            content: errorContent(),
          },
        },
      },
      delete: {
        summary: "Unsave a reel",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Reel unsaved.",
            content: successContent({
              $ref: "#/components/schemas/EngagementSaveData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": {
            description: "Internal error.",
            content: errorContent(),
          },
        },
      },
    },
    "/reels/saved": {
      get: {
        summary: "List saved reels",
        responses: {
          "200": {
            description: "Saved reel ids.",
            content: successContent({
              $ref: "#/components/schemas/EngagementListData",
            }),
          },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/reels/{id}/like": {
      post: {
        summary: "Like a reel",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Reel liked.",
            content: successContent({
              $ref: "#/components/schemas/EngagementLikeData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
      delete: {
        summary: "Unlike a reel",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Reel unliked.",
            content: successContent({
              $ref: "#/components/schemas/EngagementLikeData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/reels/liked": {
      get: {
        summary: "List liked reels",
        responses: {
          "200": {
            description: "Liked reel ids.",
            content: successContent({
              $ref: "#/components/schemas/EngagementListData",
            }),
          },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/reels/{id}/view": {
      post: {
        summary: "Add a view to a reel",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "View recorded.",
            content: successContent({
              $ref: "#/components/schemas/EngagementViewData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/reels/{id}/stats": {
      get: {
        summary: "Get reel engagement stats",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Engagement stats for the reel.",
            content: successContent({
              $ref: "#/components/schemas/EngagementStatsData",
            }),
          },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/series/{id}/save": {
      post: {
        summary: "Save a series",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Series saved.",
            content: successContent({
              $ref: "#/components/schemas/EngagementSaveData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
      delete: {
        summary: "Unsave a series",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Series unsaved.",
            content: successContent({
              $ref: "#/components/schemas/EngagementSaveData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/series/saved": {
      get: {
        summary: "List saved series",
        responses: {
          "200": {
            description: "Saved series ids.",
            content: successContent({
              $ref: "#/components/schemas/EngagementListData",
            }),
          },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/series/{id}/like": {
      post: {
        summary: "Like a series",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Series liked.",
            content: successContent({
              $ref: "#/components/schemas/EngagementLikeData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
      delete: {
        summary: "Unlike a series",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Series unliked.",
            content: successContent({
              $ref: "#/components/schemas/EngagementLikeData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/series/liked": {
      get: {
        summary: "List liked series",
        responses: {
          "200": {
            description: "Liked series ids.",
            content: successContent({
              $ref: "#/components/schemas/EngagementListData",
            }),
          },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/series/{id}/view": {
      post: {
        summary: "Add a view to a series",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "View recorded.",
            content: successContent({
              $ref: "#/components/schemas/EngagementViewData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/series/{id}/stats": {
      get: {
        summary: "Get series engagement stats",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Engagement stats for the series.",
            content: successContent({
              $ref: "#/components/schemas/EngagementStatsData",
            }),
          },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
    "/batch": {
      post: {
        summary: "Sync multiple interactions in batch",
        description:
          "Processes multiple like/unlike/save/unsave/view actions for reels and series in a single request. Useful for syncing offline actions or reducing API calls.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BatchInteractionBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Batch processed successfully.",
            content: successContent({
              $ref: "#/components/schemas/BatchInteractionData",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "401": {
            description: "Authentication required.",
            content: errorContent(),
          },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
  },
  components: {
    schemas: {
      EngagementEventBody: {
        type: "object",
        additionalProperties: false,
        required: ["videoId", "action"],
        properties: {
          videoId: { type: "string", format: "uuid" },
          action: {
            type: "string",
            enum: ["like", "unlike", "view", "favorite"],
            default: "like",
          },
          metadata: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { type: "string", enum: ["mobile", "web", "tv"] },
            },
          },
        },
      },
      EngagementEventData: {
        type: "object",
        additionalProperties: false,
        properties: {
          likes: { type: "integer", format: "int32", minimum: 0 },
          views: { type: "integer", format: "int32", minimum: 0 },
        },
      },
      EngagementStatsData: {
        type: "object",
        additionalProperties: false,
        required: ["likes", "views"],
        properties: {
          likes: { type: "integer", format: "int32", minimum: 0 },
          views: { type: "integer", format: "int32", minimum: 0 },
        },
      },
      EngagementLikeData: {
        allOf: [
          { $ref: "#/components/schemas/EngagementStatsData" },
          {
            type: "object",
            additionalProperties: false,
            required: ["liked"],
            properties: { liked: { type: "boolean" } },
          },
        ],
      },
      EngagementSaveData: {
        type: "object",
        additionalProperties: false,
        required: ["saved"],
        properties: { saved: { type: "boolean" } },
      },
      EngagementViewData: {
        type: "object",
        additionalProperties: false,
        required: ["views"],
        properties: { views: { type: "integer", format: "int32", minimum: 0 } },
      },
      EngagementListData: {
        type: "object",
        additionalProperties: false,
        required: ["ids"],
        properties: {
          ids: {
            type: "array",
            items: { type: "string", format: "uuid" },
          },
        },
      },
      BatchInteractionItem: {
        type: "object",
        additionalProperties: false,
        required: ["contentType", "contentId", "action"],
        properties: {
          contentType: {
            type: "string",
            enum: ["reel", "series"],
            description: "Type of content to interact with.",
          },
          contentId: {
            type: "string",
            format: "uuid",
            description: "UUID of the reel or series.",
          },
          action: {
            type: "string",
            enum: ["like", "unlike", "save", "unsave", "view"],
            description: "The interaction action to perform.",
          },
        },
      },
      BatchInteractionBody: {
        type: "object",
        additionalProperties: false,
        required: ["actions"],
        properties: {
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { $ref: "#/components/schemas/BatchInteractionItem" },
            description: "Array of interaction actions to process.",
          },
        },
      },
      BatchInteractionData: {
        type: "object",
        additionalProperties: false,
        required: ["processed"],
        properties: {
          processed: {
            type: "integer",
            format: "int32",
            minimum: 0,
            description: "Number of actions successfully processed.",
          },
          failed: {
            type: "integer",
            format: "int32",
            minimum: 0,
            description: "Number of actions that failed (optional).",
          },
        },
      },
      ResponseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: [
          "success",
          "statusCode",
          "userMessage",
          "developerMessage",
          "data",
        ],
        properties: {
          success: {
            type: "boolean",
            description:
              "Indicates whether the request completed successfully.",
          },
          statusCode: {
            type: "integer",
            format: "int32",
            description:
              "0 for success responses, otherwise mirrors the HTTP status code on errors.",
          },
          userMessage: {
            type: "string",
            description: "Message safe for end-user presentation.",
          },
          developerMessage: {
            type: "string",
            description:
              "Message with diagnostic detail suitable for developers.",
          },
          data: {
            type: "object",
            description: "Payload returned when the request succeeds.",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

const searchDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Search Service API",
    version: "1.0.0",
    description: "Public search across the PocketLOL catalog.",
  },
  paths: {
    "/": {
      get: {
        summary: "Search the catalog",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 2 },
            description: "Search query.",
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              format: "int32",
              minimum: 1,
              maximum: 100,
              default: 20,
            },
            description: "Maximum number of items to return.",
          },
          {
            name: "cursor",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Pagination cursor returned from a previous search.",
          },
        ],
        responses: {
          "200": {
            description: "Search results.",
            content: successContent({
              $ref: "#/components/schemas/SearchResponse",
            }),
          },
          "400": { description: "Invalid request.", content: errorContent() },
          "500": { description: "Internal error.", content: errorContent() },
        },
      },
    },
  },
  components: {
    schemas: {
      SearchResult: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "type"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" },
          type: {
            type: "string",
            enum: ["video", "channel", "playlist"],
            default: "video",
          },
        },
      },
      SearchResponse: {
        type: "object",
        additionalProperties: false,
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: { $ref: "#/components/schemas/SearchResult" },
          },
          nextCursor: { type: "string" },
        },
      },
      ResponseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: [
          "success",
          "statusCode",
          "userMessage",
          "developerMessage",
          "data",
        ],
        properties: {
          success: {
            type: "boolean",
            description:
              "Indicates whether the request completed successfully.",
          },
          statusCode: {
            type: "integer",
            format: "int32",
            description:
              "0 for success responses, otherwise mirrors the HTTP status code on errors.",
          },
          userMessage: {
            type: "string",
            description: "Message safe for end-user presentation.",
          },
          developerMessage: {
            type: "string",
            description:
              "Message with diagnostic detail suitable for developers.",
          },
          data: {
            type: "object",
            description: "Payload returned when the request succeeds.",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

const subscriptionDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Subscription Service API",
    version: "1.0.0",
    description:
      "Subscription plans, purchases, entitlements, and free usage limits for PocketLOL viewers and administrators.",
  },
  paths: {
    "/admin/plans": {
      get: {
        summary: "List all subscription plans",
        description:
          "Returns the full catalog of subscription plans, including inactive entries.",
        tags: ["Subscription Service - Admin"],
        responses: {
          "200": {
            description: "Plans available in the catalog.",
            content: successContent({
              type: "array",
              items: { $ref: "#/components/schemas/SubscriptionPlan" },
            }),
          },
        },
      },
      post: {
        summary: "Create a subscription plan",
        description:
          "Creates a new subscription plan with pricing, duration, and content entitlements.",
        tags: ["Subscription Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CreatePlanRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Plan created successfully.",
            content: successContent({
              $ref: "#/components/schemas/SubscriptionPlan",
            }),
          },
        },
      },
    },
    "/admin/plans/{id}": {
      put: {
        summary: "Update a subscription plan",
        description:
          "Updates pricing, entitlements, or activation status for a plan.",
        tags: ["Subscription Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Subscription plan identifier to update.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UpdatePlanRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated plan returned.",
            content: successContent({
              $ref: "#/components/schemas/SubscriptionPlan",
            }),
          },
        },
      },
      delete: {
        summary: "Deactivate a subscription plan",
        description:
          "Marks a subscription plan as inactive instead of deleting it permanently.",
        tags: ["Subscription Service - Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Subscription plan identifier to deactivate.",
          },
        ],
        responses: {
          "200": {
            description: "Plan deactivated successfully.",
            content: successContent({
              $ref: "#/components/schemas/SubscriptionPlan",
            }),
          },
        },
      },
    },
    "/admin/free-plan": {
      put: {
        summary: "Configure free usage limits",
        description:
          "Sets global free tier limits for reels, episodes, and series access.",
        tags: ["Subscription Service - Admin"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FreePlanConfigRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Free plan configuration saved.",
            content: successContent({
              $ref: "#/components/schemas/FreePlanConfig",
            }),
          },
        },
      },
    },
    "/admin/transactions": {
      get: {
        summary: "List recent transactions",
        description:
          "Returns the 100 most recent subscription transactions across users.",
        tags: ["Subscription Service - Admin"],
        responses: {
          "200": {
            description: "Recent transactions returned.",
            content: successContent({
              type: "array",
              items: { $ref: "#/components/schemas/Transaction" },
            }),
          },
        },
      },
    },
    "/admin/users/{userId}/subscription": {
      get: {
        summary: "Get a user's subscription",
        description:
          "Returns the most recent subscription for a user, including plan and transaction details when present.",
        tags: ["Subscription Service - Admin"],
        parameters: [
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "User identifier to query.",
          },
        ],
        responses: {
          "200": {
            description: "Latest subscription, if any.",
            content: successContent(
              { $ref: "#/components/schemas/UserSubscriptionWithRelations" },
              true
            ),
          },
        },
      },
    },
    "/plans": {
      get: {
        summary: "List active plans",
        description:
          "Returns only active subscription plans available for purchase.",
        tags: ["Subscription Service"],
        responses: {
          "200": {
            description: "Active plans available to customers.",
            content: successContent({
              type: "array",
              items: { $ref: "#/components/schemas/SubscriptionPlan" },
            }),
          },
        },
      },
    },
    "/me/subscription": {
      get: {
        summary: "Get current user's subscription",
        description:
          "Returns the latest subscription for the requesting user (identified by query parameter).",
        tags: ["Subscription Service"],
        parameters: [
          {
            name: "userId",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "User identifier of the requesting viewer.",
          },
        ],
        responses: {
          "200": {
            description: "Latest subscription for the viewer, if present.",
            content: successContent(
              { $ref: "#/components/schemas/UserSubscriptionWithPlan" },
              true
            ),
          },
        },
      },
    },
    "/me/transactions": {
      get: {
        summary: "List viewer transactions",
        description:
          "Returns the 20 most recent transactions for the requesting user.",
        tags: ["Subscription Service"],
        parameters: [
          {
            name: "userId",
            in: "query",
            required: true,
            schema: { type: "string" },
            description: "User identifier of the requesting viewer.",
          },
        ],
        responses: {
          "200": {
            description: "Recent transactions for the viewer.",
            content: successContent({
              type: "array",
              items: { $ref: "#/components/schemas/Transaction" },
            }),
          },
        },
      },
    },
    "/purchase/intent": {
      post: {
        summary: "Create a purchase intent",
        description:
          "Creates a transaction and Razorpay order for a chosen plan so the client can complete payment.",
        tags: ["Subscription Service"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/PurchaseIntentRequest" },
            },
          },
        },
        responses: {
          "201": {
            description: "Purchase intent created.",
            content: successContent({
              $ref: "#/components/schemas/PurchaseIntentResponse",
            }),
          },
          "404": {
            description: "Requested plan does not exist or is inactive.",
            content: errorContent(),
          },
        },
      },
    },
    "/internal/entitlements/check": {
      post: {
        summary: "Check content entitlement",
        description:
          "Service-to-service endpoint that determines whether a user may access a reel or episode based on active subscription or free limits.",
        tags: ["Subscription Service - Internal"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/EntitlementCheckRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Entitlement decision returned.",
            content: successContent({
              $ref: "#/components/schemas/EntitlementCheckResponse",
            }),
          },
          "403": {
            description: "Missing or invalid service token.",
            content: errorContent(),
          },
        },
        security: [{}],
      },
    },
  },
  components: {
    schemas: {
      SubscriptionPlan: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "pricePaise",
          "currency",
          "durationDays",
          "isActive",
          "isUnlimitedReels",
          "isUnlimitedEpisodes",
          "isUnlimitedSeries",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          description: { type: "string", nullable: true },
          pricePaise: { type: "integer", format: "int32", minimum: 0 },
          currency: { type: "string", default: "INR" },
          durationDays: { type: "integer", format: "int32", minimum: 1 },
          reelsLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          episodesLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          seriesLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          accessLevel: { type: "string", nullable: true },
          isUnlimitedReels: { type: "boolean" },
          isUnlimitedEpisodes: { type: "boolean" },
          isUnlimitedSeries: { type: "boolean" },
          isActive: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      CreatePlanRequest: {
        type: "object",
        additionalProperties: false,
        required: ["name", "pricePaise", "durationDays"],
        properties: {
          name: { type: "string" },
          description: { type: "string", nullable: true },
          pricePaise: { type: "integer", format: "int32", minimum: 0 },
          currency: { type: "string", default: "INR" },
          durationDays: { type: "integer", format: "int32", minimum: 1 },
          reelsLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          episodesLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          seriesLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          accessLevel: { type: "string", nullable: true },
          isUnlimitedReels: { type: "boolean", default: false },
          isUnlimitedEpisodes: { type: "boolean", default: false },
          isUnlimitedSeries: { type: "boolean", default: false },
          isActive: { type: "boolean", default: true },
        },
      },
      UpdatePlanRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string", nullable: true },
          pricePaise: { type: "integer", format: "int32", minimum: 0 },
          currency: { type: "string" },
          durationDays: { type: "integer", format: "int32", minimum: 1 },
          reelsLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          episodesLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          seriesLimit: {
            type: "integer",
            format: "int32",
            minimum: 0,
            nullable: true,
          },
          accessLevel: { type: "string", nullable: true },
          isUnlimitedReels: { type: "boolean" },
          isUnlimitedEpisodes: { type: "boolean" },
          isUnlimitedSeries: { type: "boolean" },
          isActive: { type: "boolean" },
        },
      },
      FreePlanConfigRequest: {
        type: "object",
        additionalProperties: false,
        required: ["maxFreeReels", "maxFreeEpisodes", "maxFreeSeries"],
        properties: {
          maxFreeReels: { type: "integer", format: "int32", minimum: 0 },
          maxFreeEpisodes: {
            type: "integer",
            format: "int32",
            minimum: 0,
          },
          maxFreeSeries: {
            type: "integer",
            format: "int32",
            minimum: 0,
          },
          adminId: { type: "string", format: "uuid", nullable: true },
        },
      },
      FreePlanConfig: {
        type: "object",
        additionalProperties: false,
        required: [
          "maxFreeReels",
          "maxFreeEpisodes",
          "maxFreeSeries",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "integer", format: "int32", nullable: true },
          maxFreeReels: { type: "integer", format: "int32" },
          maxFreeEpisodes: { type: "integer", format: "int32" },
          maxFreeSeries: { type: "integer", format: "int32" },
          updatedByAdminId: { type: "string", format: "uuid", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      Transaction: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "userId",
          "amountPaise",
          "currency",
          "status",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string" },
          planId: { type: "string", format: "uuid", nullable: true },
          amountPaise: { type: "integer", format: "int32" },
          currency: { type: "string", default: "INR" },
          status: {
            type: "string",
            enum: ["PENDING", "SUCCESS", "FAILED", "REFUNDED"],
          },
          razorpayOrderId: { type: "string", nullable: true },
          razorpayPaymentId: { type: "string", nullable: true },
          razorpaySignature: { type: "string", nullable: true },
          failureReason: { type: "string", nullable: true },
          metadata: {
            type: "object",
            additionalProperties: true,
            nullable: true,
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      UserSubscription: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "userId",
          "status",
          "startsAt",
          "endsAt",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: { type: "string", format: "uuid" },
          userId: { type: "string" },
          planId: { type: "string", format: "uuid", nullable: true },
          status: {
            type: "string",
            enum: ["PENDING", "ACTIVE", "EXPIRED", "CANCELED"],
          },
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: "string", format: "date-time" },
          razorpayOrderId: { type: "string", nullable: true },
          transactionId: { type: "string", format: "uuid", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      UserSubscriptionWithPlan: {
        allOf: [
          { $ref: "#/components/schemas/UserSubscription" },
          {
            type: "object",
            properties: {
              plan: {
                $ref: "#/components/schemas/SubscriptionPlan",
                nullable: true,
              },
            },
          },
        ],
      },
      UserSubscriptionWithRelations: {
        allOf: [
          { $ref: "#/components/schemas/UserSubscriptionWithPlan" },
          {
            type: "object",
            properties: {
              transaction: {
                $ref: "#/components/schemas/Transaction",
                nullable: true,
              },
            },
          },
        ],
      },
      PurchaseIntentRequest: {
        type: "object",
        additionalProperties: false,
        required: ["userId", "planId"],
        properties: {
          userId: { type: "string" },
          planId: { type: "string", format: "uuid" },
          deviceId: { type: "string", nullable: true },
        },
      },
      PurchaseIntentResponse: {
        type: "object",
        additionalProperties: false,
        required: ["transactionId", "amountPaise", "currency"],
        properties: {
          transactionId: { type: "string", format: "uuid" },
          razorpayOrderId: { type: "string", nullable: true },
          amountPaise: { type: "integer", format: "int32" },
          currency: { type: "string" },
        },
      },
      EntitlementCheckRequest: {
        type: "object",
        additionalProperties: false,
        required: ["userId", "contentType"],
        properties: {
          userId: { type: "string" },
          contentType: { type: "string", enum: ["REEL", "EPISODE"] },
        },
      },
      EntitlementCheckResponse: {
        type: "object",
        additionalProperties: false,
        required: ["allowed", "planId", "status", "contentType"],
        properties: {
          allowed: { type: "boolean" },
          planId: { type: "string" },
          status: {
            type: "string",
            enum: ["PENDING", "ACTIVE", "EXPIRED", "CANCELED", "FREE"],
          },
          contentType: { type: "string", enum: ["REEL", "EPISODE"] },
          freeLimits: {
            $ref: "#/components/schemas/FreePlanConfig",
            nullable: true,
          },
        },
      },
      ResponseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: [
          "success",
          "statusCode",
          "userMessage",
          "developerMessage",
          "data",
        ],
        properties: {
          success: {
            type: "boolean",
            description:
              "Indicates whether the request completed successfully.",
          },
          statusCode: {
            type: "integer",
            format: "int32",
            description:
              "0 for success responses, otherwise mirrors the HTTP status code on errors.",
          },
          userMessage: {
            type: "string",
            description: "Message safe for end-user presentation.",
          },
          developerMessage: {
            type: "string",
            description:
              "Message with diagnostic detail suitable for developers.",
          },
          data: {
            type: "object",
            description: "Payload returned when the request succeeds.",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

const streamingDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Streaming Service Gateway API",
    version: "1.0.0",
    description:
      "Viewer playback manifests plus the administrative controls that orchestrate stream provisioning, rotation, and purge workflows.",
  },
  paths: {
    "/api/v1/streams/{contentId}/manifest": {
      get: {
        summary: "Retrieve playback manifest",
        description:
          "Issues a CDN-signed manifest URL for the requested content after enforcing geo, device, and subscription policies.",
        tags: ["Streaming Service - Playback"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "contentId",
            in: "path",
            required: true,
            description:
              "Content identifier that maps to a live or VOD channel.",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "quality",
            in: "query",
            required: false,
            description:
              "Preferred playback quality; defaults to adaptive bit-rate.",
            schema: {
              type: "string",
              enum: ["auto", "1080p", "720p", "480p", "360p"],
            },
          },
          {
            name: "device",
            in: "query",
            required: false,
            description:
              "Device class used for DRM policy and codec selection.",
            schema: {
              type: "string",
              enum: ["mobile", "tablet", "web", "tv"],
            },
          },
          {
            name: "geo",
            in: "query",
            required: false,
            description:
              "ISO-3166-1 alpha-2 override for edge geolocation checks (normally populated automatically).",
            schema: {
              type: "string",
              minLength: 2,
              maxLength: 2,
            },
          },
          {
            name: "session",
            in: "query",
            required: false,
            description:
              "Viewer session identifier used for manifest personalization and anomaly tracing.",
            schema: { type: "string", format: "uuid" },
          },
        ],
        responses: {
          "200": {
            description: "Manifest issued successfully.",
            content: successContent({
              $ref: "#/components/schemas/StreamManifest",
            }),
          },
          "403": {
            description:
              "Viewer lacks entitlement, is geo-blocked, or device policies failed.",
            content: errorContent(),
          },
          "404": {
            description: "Content is unknown or has been retired.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/streams/admin/register-stream": {
      post: {
        summary: "Register a stream for ingest",
        description:
          "Creates or updates the control plane record for a stream and kicks off OvenMediaEngine provisioning.",
        tags: ["Streaming Service - Admin"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RegisterStreamRequest" },
            },
          },
        },
        responses: {
          "202": {
            description: "Provisioning workflow accepted.",
            content: successContent({
              $ref: "#/components/schemas/StreamMetadata",
            }),
          },
          "400": {
            description: "Request failed validation.",
            content: errorContent(),
          },
          "409": {
            description: "Stream already exists in an incompatible state.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/streams/admin/{contentId}": {
      get: {
        summary: "Fetch stream metadata",
        description:
          "Returns the latest control-plane view of a stream, including ingest region, manifest path, and provisioning retries.",
        tags: ["Streaming Service - Admin"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "contentId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Content identifier used during registration.",
          },
        ],
        responses: {
          "200": {
            description: "Metadata returned.",
            content: successContent({
              $ref: "#/components/schemas/StreamMetadata",
            }),
          },
          "404": {
            description: "Stream is unknown or was never registered.",
            content: errorContent(),
          },
        },
      },
      delete: {
        summary: "Retire a stream",
        description:
          "Marks the stream as retired and triggers downstream cache invalidation plus CDN cleanup.",
        tags: ["Streaming Service - Admin"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "contentId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Content identifier to retire.",
          },
        ],
        responses: {
          "200": {
            description: "Retirement accepted.",
            content: successContent(undefined, true),
          },
          "404": {
            description: "Stream not found or already retired.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/streams/admin/{contentId}/purge": {
      post: {
        summary: "Purge CDN artifacts",
        description:
          "Requests edge cache invalidation and storage cleanup for the stream's manifest and segments.",
        tags: ["Streaming Service - Admin"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "contentId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Content identifier whose artifacts should be purged.",
          },
        ],
        responses: {
          "200": {
            description: "Purge request queued.",
            content: successContent({
              $ref: "#/components/schemas/StreamOperationStatus",
            }),
          },
          "404": {
            description: "Stream is unknown or inactive.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/streams/admin/{contentId}/rotate-ingest": {
      post: {
        summary: "Rotate ingest endpoints",
        description:
          "Triggers an ingest key rotation plus OvenMediaEngine reconfiguration for the stream.",
        tags: ["Streaming Service - Admin"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "contentId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Content identifier that needs ingest rotation.",
          },
        ],
        responses: {
          "200": {
            description: "Rotation scheduled.",
            content: successContent({
              $ref: "#/components/schemas/StreamOperationStatus",
            }),
          },
          "404": {
            description: "Stream is unknown or inactive.",
            content: errorContent(),
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "PocketLOL tokens issued by the Auth Service. Playback requests accept both admin and customer tokens; admin routes require administrator tokens.",
      },
    },
    schemas: {
      StreamDrm: {
        type: "object",
        additionalProperties: false,
        required: ["keyId", "licenseServer"],
        properties: {
          keyId: { type: "string" },
          licenseServer: { type: "string", format: "uri" },
        },
      },
      StreamAvailabilityWindow: {
        type: "object",
        additionalProperties: false,
        required: ["startsAt", "endsAt"],
        properties: {
          startsAt: { type: "string", format: "date-time" },
          endsAt: { type: "string", format: "date-time" },
        },
      },
      StreamManifestPolicy: {
        type: "object",
        additionalProperties: false,
        required: ["cacheControl", "ttlSeconds", "failover"],
        properties: {
          cacheControl: { type: "string" },
          ttlSeconds: { type: "integer", format: "int32", minimum: 1 },
          failover: { type: "boolean" },
        },
      },
      StreamManifest: {
        type: "object",
        additionalProperties: false,
        required: ["manifestUrl", "expiresAt", "cdn", "entitlements", "policy"],
        properties: {
          manifestUrl: { type: "string", format: "uri" },
          expiresAt: { type: "string", format: "date-time" },
          cdn: { type: "string" },
          drm: { $ref: "#/components/schemas/StreamDrm" },
          entitlements: {
            type: "array",
            items: { type: "string" },
            description:
              "Entitlement claims validated for this manifest issuance.",
          },
          policy: { $ref: "#/components/schemas/StreamManifestPolicy" },
          availability: {
            $ref: "#/components/schemas/StreamAvailabilityWindow",
            nullable: true,
          },
        },
      },
      StreamGeoRestrictions: {
        type: "object",
        additionalProperties: false,
        properties: {
          allow: {
            type: "array",
            items: { type: "string", minLength: 2, maxLength: 2 },
          },
          deny: {
            type: "array",
            items: { type: "string", minLength: 2, maxLength: 2 },
          },
        },
      },
      RegisterStreamRequest: {
        type: "object",
        additionalProperties: false,
        required: [
          "contentId",
          "tenantId",
          "contentType",
          "sourceGcsUri",
          "checksum",
          "durationSeconds",
          "ingestRegion",
        ],
        properties: {
          contentId: { type: "string", format: "uuid" },
          tenantId: { type: "string", minLength: 1 },
          contentType: { type: "string", enum: ["reel", "series"] },
          sourceGcsUri: {
            type: "string",
            description: "gs:// URI of the validated mezzanine asset.",
          },
          checksum: { type: "string" },
          durationSeconds: {
            type: "integer",
            format: "int32",
            minimum: 1,
          },
          ingestRegion: { type: "string" },
          drm: {
            $ref: "#/components/schemas/StreamDrm",
            nullable: true,
          },
          availabilityWindow: {
            $ref: "#/components/schemas/StreamAvailabilityWindow",
            nullable: true,
          },
          geoRestrictions: {
            $ref: "#/components/schemas/StreamGeoRestrictions",
            nullable: true,
          },
        },
      },
      StreamMetadata: {
        type: "object",
        additionalProperties: false,
        required: [
          "contentId",
          "channelId",
          "classification",
          "manifestPath",
          "playbackUrl",
          "originEndpoint",
          "cacheKey",
          "checksum",
          "status",
          "retries",
          "sourceAssetUri",
          "lastProvisionedAt",
        ],
        properties: {
          contentId: { type: "string", format: "uuid" },
          channelId: { type: "string" },
          classification: { type: "string", enum: ["reel", "series"] },
          manifestPath: { type: "string" },
          playbackUrl: { type: "string", format: "uri" },
          originEndpoint: { type: "string" },
          cacheKey: { type: "string" },
          checksum: { type: "string" },
          status: {
            type: "string",
            enum: ["provisioning", "ready", "failed", "retired"],
          },
          retries: { type: "integer", format: "int32", minimum: 0 },
          sourceAssetUri: { type: "string" },
          lastProvisionedAt: { type: "string", format: "date-time" },
          drm: {
            $ref: "#/components/schemas/StreamDrm",
            nullable: true,
          },
          ingestRegion: { type: "string", nullable: true },
          availabilityWindow: {
            $ref: "#/components/schemas/StreamAvailabilityWindow",
            nullable: true,
          },
          geoRestrictions: {
            $ref: "#/components/schemas/StreamGeoRestrictions",
            nullable: true,
          },
        },
      },
      StreamOperationStatus: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: {
            type: "string",
            description: "Human-readable status for long-running operations.",
            example: "purge-requested",
          },
        },
      },
    },
  },
};

const uploadDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Upload Service Admin API",
    version: "1.0.0",
    description:
      "Administrative surface for issuing signed upload intents, inspecting processing state, and integrating downstream services with Upload Service events.",
  },
  paths: {
    "/api/v1/admin/uploads/sign": {
      post: {
        summary: "Issue signed upload intent",
        description:
          "Issues a short-lived signed policy for Google Cloud Storage uploads. The caller must be an authenticated administrator with an active Upload role assignment validated via User Service.",
        tags: ["Upload Service - Admin"],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UploadIntentRequest" },
              examples: {
                video: {
                  summary: "Video upload",
                  value: {
                    fileName: "episode-01.mp4",
                    contentType: "video/mp4",
                    sizeBytes: 134217728,
                    assetType: "video",
                    contentId: "4bc4e515-9fd2-476c-bf11-02f171cb4a7e",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Signed upload policy issued.",
            content: successContent({
              $ref: "#/components/schemas/UploadIntentResponse",
            }),
          },
          "403": {
            description: "Caller is not authorized as an admin.",
            content: errorContent(),
          },
          "429": {
            description:
              "Concurrent or daily upload quota exceeded for the administrator.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/admin/uploads/{uploadId}/status": {
      get: {
        summary: "Get upload status",
        description:
          "Retrieves end-to-end processing state, validation metadata, and preview assets for a previously issued upload intent.",
        tags: ["Upload Service - Admin"],
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: "uploadId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description:
              "Upload session identifier returned by the sign endpoint.",
          },
        ],
        responses: {
          "200": {
            description: "Upload status and derived metadata.",
            content: successContent({
              $ref: "#/components/schemas/UploadStatus",
            }),
          },
          "404": {
            description: "Upload session not found for the administrator.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/admin/uploads/quota": {
      get: {
        summary: "Get admin upload quota",
        description:
          "Returns the administrator's current quota utilization and configured thresholds for concurrent uploads and daily volume.",
        tags: ["Upload Service - Admin"],
        security: [{ bearerAuth: [] }],
        responses: {
          "200": {
            description: "Quota state for the authenticated admin.",
            content: successContent({
              $ref: "#/components/schemas/UploadQuota",
            }),
          },
        },
      },
    },
    "/api/v1/admin/uploads/internal/uploads/{uploadId}/validation": {
      post: {
        summary: "Streaming validation callback",
        description:
          "Endpoint invoked by Streaming Service after initial ingest and validation. Requires the platform service token presented via Authorization or x-service-token header.",
        tags: ["Upload Service - Integrations"],
        security: [{ serviceToken: [] }],
        parameters: [
          {
            name: "uploadId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Upload session identifier under validation.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ValidationCallbackRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Callback accepted for processing.",
            content: successContent({
              type: "object",
              required: ["status"],
              properties: {
                status: { type: "string", enum: ["accepted"] },
              },
            }),
          },
          "403": {
            description:
              "Service token missing or invalid for the callback requester.",
            content: errorContent(),
          },
        },
      },
    },
    "/api/v1/admin/uploads/internal/uploads/{uploadId}/processing": {
      post: {
        summary: "Processing completion callback",
        description:
          "Marks upload processing outcome after preview generation and manifest packaging. Invoked by the media processing pipeline with the shared service token.",
        tags: ["Upload Service - Integrations"],
        security: [{ serviceToken: [] }],
        parameters: [
          {
            name: "uploadId",
            in: "path",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "Upload session identifier.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ProcessingCallbackRequest",
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Processing result accepted.",
            content: successContent({
              type: "object",
              required: ["status"],
              properties: {
                status: { type: "string", enum: ["accepted"] },
              },
            }),
          },
          "403": {
            description:
              "Processing callback rejected because the service token was invalid.",
            content: errorContent(),
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "PocketLOL administrator access token issued by the Auth Service.",
      },
      serviceToken: {
        type: "apiKey",
        in: "header",
        name: "x-service-token",
        description:
          "Platform-issued service token required for internal callbacks from Streaming and Content services.",
      },
    },
    schemas: {
      UploadAssetType: {
        type: "string",
        description: "Supported asset categories for admin uploads.",
        enum: ["video", "thumbnail", "banner"],
      },
      UploadIntentRequest: {
        type: "object",
        additionalProperties: false,
        required: ["fileName", "contentType", "sizeBytes", "assetType"],
        properties: {
          fileName: {
            type: "string",
            maxLength: 255,
            description:
              "Original file name used to derive the storage object key.",
          },
          contentType: {
            type: "string",
            maxLength: 128,
            description: "MIME type validated against ingestion policies.",
          },
          sizeBytes: {
            type: "integer",
            format: "int64",
            minimum: 1,
            maximum: 536870912,
            description: "File size in bytes (max 512 MiB for videos).",
          },
          assetType: {
            $ref: "#/components/schemas/UploadAssetType",
          },
          contentId: {
            type: "string",
            format: "uuid",
            nullable: true,
            description:
              "Optional content identifier to associate the upload with a catalog entity.",
          },
        },
      },
      UploadIntentResponse: {
        type: "object",
        additionalProperties: false,
        required: [
          "uploadId",
          "uploadUrl",
          "expiresAt",
          "objectKey",
          "storageUrl",
          "fields",
        ],
        properties: {
          uploadId: { type: "string", format: "uuid" },
          uploadUrl: {
            type: "string",
            format: "uri",
            description: "Signed POST policy URL for Google Cloud Storage.",
          },
          expiresAt: {
            type: "string",
            format: "date-time",
            description: "UTC timestamp when the signed upload expires.",
          },
          objectKey: {
            type: "string",
            description: "Storage object key generated for the asset.",
          },
          storageUrl: {
            type: "string",
            pattern: "^gs://",
            description: "gs:// URI pointing to the staged upload in GCS.",
          },
          fields: {
            type: "object",
            description: "Form fields required to complete the signed upload.",
            additionalProperties: { type: "string" },
          },
          cdn: {
            type: "string",
            format: "uri",
            nullable: true,
            description:
              "Base CDN URL that will serve the uploaded asset once processed.",
          },
        },
      },
      UploadQuota: {
        type: "object",
        additionalProperties: false,
        required: [
          "concurrentLimit",
          "dailyLimit",
          "activeUploads",
          "dailyUploads",
        ],
        properties: {
          concurrentLimit: {
            type: "integer",
            format: "int32",
            description: "Maximum concurrent uploads allowed for the admin.",
          },
          dailyLimit: {
            type: "integer",
            format: "int32",
            description: "Daily upload allotment for the admin.",
          },
          activeUploads: {
            type: "integer",
            format: "int32",
            description: "Currently active uploads counted towards the limit.",
          },
          dailyUploads: {
            type: "integer",
            format: "int32",
            description: "Uploads started within the current UTC day.",
          },
        },
      },
      UploadValidationMetadata: {
        type: "object",
        additionalProperties: false,
        properties: {
          durationSeconds: {
            type: "number",
            format: "float",
            nullable: true,
            description: "Duration reported by the ingest pipeline in seconds.",
          },
          width: {
            type: "number",
            format: "float",
            nullable: true,
            description: "Detected frame width in pixels.",
          },
          height: {
            type: "number",
            format: "float",
            nullable: true,
            description: "Detected frame height in pixels.",
          },
          checksum: {
            type: "string",
            nullable: true,
            description: "Checksum returned by Streaming Service validation.",
          },
          bitrateKbps: {
            type: "number",
            format: "float",
            nullable: true,
            description:
              "Baseline bitrate measured during processing (in kbps).",
          },
        },
      },
      UploadProcessingMetadata: {
        type: "object",
        additionalProperties: false,
        properties: {
          manifestUrl: {
            type: "string",
            format: "uri",
            nullable: true,
            description: "HLS/DASH manifest URL generated after encoding.",
          },
          defaultThumbnailUrl: {
            type: "string",
            format: "uri",
            nullable: true,
            description: "Default thumbnail produced by preview generation.",
          },
          previewGeneratedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
            description:
              "Timestamp when preview assets were successfully generated.",
          },
        },
      },
      UploadStatus: {
        type: "object",
        additionalProperties: false,
        required: [
          "uploadId",
          "status",
          "assetType",
          "objectKey",
          "sizeBytes",
          "contentType",
          "expiresAt",
        ],
        properties: {
          uploadId: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: [
              "REQUESTED",
              "UPLOADING",
              "VALIDATING",
              "PROCESSING",
              "READY",
              "FAILED",
              "EXPIRED",
            ],
          },
          assetType: { $ref: "#/components/schemas/UploadAssetType" },
          objectKey: { type: "string" },
          storageUrl: {
            type: "string",
            pattern: "^gs://",
            nullable: true,
          },
          cdnUrl: {
            type: "string",
            format: "uri",
            nullable: true,
          },
          sizeBytes: { type: "integer", format: "int64" },
          contentType: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
          completedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          failureReason: { type: "string", nullable: true },
          validationMeta: {
            $ref: "#/components/schemas/UploadValidationMetadata",
          },
          processingMeta: {
            $ref: "#/components/schemas/UploadProcessingMetadata",
          },
        },
      },
      ValidationCallbackRequest: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["success", "failed"] },
          checksum: { type: "string", nullable: true },
          durationSeconds: { type: "number", nullable: true },
          width: { type: "number", nullable: true },
          height: { type: "number", nullable: true },
          failureReason: { type: "string", nullable: true },
        },
      },
      ProcessingCallbackRequest: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["ready", "failed"] },
          manifestUrl: { type: "string", format: "uri", nullable: true },
          defaultThumbnailUrl: {
            type: "string",
            format: "uri",
            nullable: true,
          },
          bitrateKbps: { type: "number", nullable: true },
          previewGeneratedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          failureReason: { type: "string", nullable: true },
        },
      },
      MediaUploadedEvent: {
        type: "object",
        additionalProperties: false,
        description:
          "Event published to the `media.uploaded` Pub/Sub topic (routing key `streaming.ingest`). Retries follow Pub/Sub redelivery semantics with exponential backoff and acknowledgment deadline of 60 seconds.",
        required: [
          "uploadId",
          "objectKey",
          "storageUrl",
          "assetType",
          "adminId",
          "emittedAt",
        ],
        properties: {
          uploadId: { type: "string", format: "uuid" },
          objectKey: { type: "string" },
          storageUrl: { type: "string", pattern: "^gs://" },
          cdnUrl: { type: "string", format: "uri", nullable: true },
          assetType: { $ref: "#/components/schemas/UploadAssetType" },
          adminId: { type: "string", format: "uuid" },
          contentId: { type: "string", format: "uuid", nullable: true },
          sizeBytes: { type: "integer", format: "int64", nullable: true },
          contentType: { type: "string", nullable: true },
          validation: {
            $ref: "#/components/schemas/UploadValidationMetadata",
          },
          emittedAt: { type: "string", format: "date-time" },
        },
        example: {
          uploadId: "1f0a5b62-0a75-4ee0-9c20-40db583cd564",
          objectKey: "videos/1702911123000-a1b2c3d4-episode-01.mp4",
          storageUrl: "gs://pocketlol-uploads/videos/...",
          cdnUrl: "https://upload.cdn.pocketlol/videos/...",
          assetType: "video",
          adminId: "c7a20cf3-4be2-4c25-8cf8-4fe2f73d9d3f",
          contentId: "4bc4e515-9fd2-476c-bf11-02f171cb4a7e",
          sizeBytes: 134217728,
          contentType: "video/mp4",
          validation: {
            durationSeconds: 188.5,
            width: 1920,
            height: 1080,
            checksum: "8e4f0f6b9d72",
          },
          emittedAt: "2025-12-18T06:15:31.000Z",
        },
      },
      MediaProcessedEvent: {
        type: "object",
        additionalProperties: false,
        description:
          "Event published to the `media.processed` Pub/Sub topic once previews and manifests are available. Consumed by Content and Streaming services to finalize catalog assets.",
        required: [
          "uploadId",
          "objectKey",
          "assetType",
          "adminId",
          "emittedAt",
        ],
        properties: {
          uploadId: { type: "string", format: "uuid" },
          objectKey: { type: "string" },
          storageUrl: { type: "string", pattern: "^gs://", nullable: true },
          cdnUrl: { type: "string", format: "uri", nullable: true },
          adminId: { type: "string", format: "uuid" },
          contentId: { type: "string", format: "uuid", nullable: true },
          assetType: { $ref: "#/components/schemas/UploadAssetType" },
          manifestUrl: { type: "string", format: "uri", nullable: true },
          defaultThumbnailUrl: {
            type: "string",
            format: "uri",
            nullable: true,
          },
          durationSeconds: { type: "number", nullable: true },
          bitrateKbps: { type: "number", nullable: true },
          previewGeneratedAt: {
            type: "string",
            format: "date-time",
            nullable: true,
          },
          emittedAt: { type: "string", format: "date-time" },
        },
        example: {
          uploadId: "1f0a5b62-0a75-4ee0-9c20-40db583cd564",
          objectKey: "videos/1702911123000-a1b2c3d4-episode-01.mp4",
          storageUrl: "gs://pocketlol-uploads/videos/...",
          cdnUrl: "https://upload.cdn.pocketlol/videos/...",
          adminId: "c7a20cf3-4be2-4c25-8cf8-4fe2f73d9d3f",
          contentId: "4bc4e515-9fd2-476c-bf11-02f171cb4a7e",
          assetType: "video",
          manifestUrl: "https://streaming.pocketlol/hls/episode-01.m3u8",
          defaultThumbnailUrl:
            "https://cdn.pocketlol/thumbnails/episode-01.jpg",
          durationSeconds: 188.5,
          bitrateKbps: 4200,
          previewGeneratedAt: "2025-12-18T06:17:12.000Z",
          emittedAt: "2025-12-18T06:17:18.000Z",
        },
      },
      PreviewGenerationRequest: {
        type: "object",
        additionalProperties: false,
        description:
          "Message published to the `media.preview.requested` Pub/Sub topic to trigger Cloud Functions/FFmpeg preview generation workers.",
        required: [
          "uploadId",
          "objectKey",
          "storageUrl",
          "adminId",
          "requestedAt",
        ],
        properties: {
          uploadId: { type: "string", format: "uuid" },
          objectKey: { type: "string" },
          storageUrl: { type: "string", pattern: "^gs://" },
          adminId: { type: "string", format: "uuid" },
          contentId: { type: "string", format: "uuid", nullable: true },
          requestedAt: { type: "string", format: "date-time" },
        },
      },
      ResponseEnvelope: {
        type: "object",
        additionalProperties: false,
        required: [
          "success",
          "statusCode",
          "userMessage",
          "developerMessage",
          "data",
        ],
        properties: {
          success: {
            type: "boolean",
            description:
              "Indicates whether the request completed successfully.",
          },
          statusCode: {
            type: "integer",
            format: "int32",
            description:
              "0 for success responses, otherwise mirrors the HTTP status code on errors.",
          },
          userMessage: {
            type: "string",
            description: "Message safe for end-user presentation.",
          },
          developerMessage: {
            type: "string",
            description:
              "Message with diagnostic detail suitable for developers.",
          },
          data: {
            type: "object",
            description: "Payload returned when the request succeeds.",
            additionalProperties: true,
          },
        },
      },
    },
  },
};

export function getGatewayServiceDocuments(): ServiceDocument[] {
  return [
    { service: findServiceByName("auth"), document: authDocument },
    { service: findServiceByName("user"), document: userDocument },
    { service: findServiceByName("content"), document: contentDocument },
    { service: findServiceByName("engagement"), document: engagementDocument },
    { service: findServiceByName("search"), document: searchDocument },
    {
      service: findServiceByName("subscription"),
      document: subscriptionDocument,
    },
    {
      service: findServiceByName("streaming"),
      document: streamingDocument,
    },
    { service: findServiceByName("upload"), document: uploadDocument },
  ];
}
