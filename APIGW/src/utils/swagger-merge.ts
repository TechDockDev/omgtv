import type { OpenAPIV3 } from "openapi-types";
import type { ServiceDefinition } from "../types/service";
import { ensureLeadingSlash, joinUrlSegments } from "./path";

export interface ServiceDocument {
  readonly service: ServiceDefinition;
  readonly document: OpenAPIV3.Document;
}

const DEFAULT_VERSION = "1.0.0";

function cloneDocument<T>(input: T): T {
  return typeof structuredClone === "function"
    ? structuredClone(input)
    : JSON.parse(JSON.stringify(input));
}

function prefixComponentReferences(
  document: OpenAPIV3.Document,
  service: ServiceDefinition
) {
  if (!document.components) {
    return;
  }

  const refMap = new Map<string, string>();
  const componentGroups = document.components as Record<string, unknown>;
  const skipPrefixGroups = new Set(["securitySchemes"]);

  for (const [groupName, groupValue] of Object.entries(componentGroups)) {
    if (!groupValue || typeof groupValue !== "object") {
      continue;
    }

    if (skipPrefixGroups.has(groupName)) {
      continue;
    }

    const typedGroup = groupValue as Record<string, unknown>;
    const renamedGroup: Record<string, unknown> = {};

    for (const [componentName, schema] of Object.entries(typedGroup)) {
      const prefixedName = `${service.name}_${componentName}`;
      const oldRef = `#/components/${groupName}/${componentName}`;
      const newRef = `#/components/${groupName}/${prefixedName}`;
      refMap.set(oldRef, newRef);
      renamedGroup[prefixedName] = schema;
    }

    (componentGroups as Record<string, unknown>)[groupName] = renamedGroup;
  }

  const walker = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const value of node) {
        walker(value);
      }
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const mapped = refMap.get(value);
        if (mapped) {
          (node as Record<string, unknown>)[key] = mapped;
        }
        continue;
      }
      walker(value);
    }
  };

  walker(document.paths);
  walker(document.components);
}

function prefixServicePaths(
  document: OpenAPIV3.Document,
  service: ServiceDefinition
): OpenAPIV3.PathsObject {
  const prefixedPaths: OpenAPIV3.PathsObject = {};
  const serviceTag = service.displayName ?? service.name;
  const requiresAuth = service.access !== "public";
  const documentationBase = service.documentationBasePath ?? service.basePath;

  for (const [path, pathValue] of Object.entries(document.paths ?? {})) {
    const normalizedPath = ensureLeadingSlash(path);
    const basePrefix = documentationBase ?? "";
    const prefixedPath =
      basePrefix && normalizedPath.startsWith(basePrefix)
        ? ensureLeadingSlash(normalizedPath)
        : ensureLeadingSlash(joinUrlSegments(basePrefix, normalizedPath));

    const clonedPathItem = cloneDocument(pathValue);

    for (const operation of Object.values(clonedPathItem ?? {})) {
      if (!operation || typeof operation !== "object") {
        continue;
      }

      const op = operation as OpenAPIV3.OperationObject;
      op.tags = [serviceTag];

      if (requiresAuth) {
        const securityEntry = {
          bearerAuth: [],
        } satisfies OpenAPIV3.SecurityRequirementObject;
        op.security = op.security?.length ? op.security : [securityEntry];
      }
    }

    prefixedPaths[prefixedPath] = clonedPathItem;
  }

  return prefixedPaths;
}

function mergeComponents(
  target: OpenAPIV3.ComponentsObject,
  source?: OpenAPIV3.ComponentsObject
) {
  if (!source) {
    return;
  }

  for (const [group, groupValue] of Object.entries(source)) {
    if (!groupValue || typeof groupValue !== "object") {
      continue;
    }

    const destinationGroup = (target as Record<string, unknown>)[group] as
      | Record<string, unknown>
      | undefined;

    if (!destinationGroup) {
      (target as Record<string, unknown>)[group] = {
        ...(groupValue as Record<string, unknown>),
      };
      continue;
    }

    Object.assign(destinationGroup, groupValue);
  }
}

export function mergeOpenApiDocuments(
  documents: readonly ServiceDocument[]
): OpenAPIV3.Document {
  const baseDocument: OpenAPIV3.Document = {
    openapi: "3.0.3",
    info: {
      title: "PocketLOL API Gateway",
      description:
        "Aggregated OpenAPI documentation for PocketLOL administrative services.",
      version: DEFAULT_VERSION,
    },
    servers: [
      {
        url: "/",
        description: "PocketLOL API Gateway",
      },
    ],
    tags: [],
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
    },
    paths: {},
  };

  const tags = new Map<string, OpenAPIV3.TagObject>();

  for (const entry of documents) {
    const clonedDocument = cloneDocument(entry.document);
    prefixComponentReferences(clonedDocument, entry.service);
    const prefixedPaths = prefixServicePaths(clonedDocument, entry.service);

    Object.assign(baseDocument.paths, prefixedPaths);
    mergeComponents(baseDocument.components ?? {}, clonedDocument.components);

    const tagName = entry.service.displayName ?? entry.service.name;
    if (!tags.has(tagName)) {
      tags.set(tagName, {
        name: tagName,
        description: entry.service.description,
      });
    }
  }

  baseDocument.tags = Array.from(tags.values());
  return baseDocument;
}
