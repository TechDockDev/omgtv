export type GatewayRole = string;

export type GatewayUserType = "ADMIN" | "CUSTOMER" | "GUEST";

export interface GatewayUser {
  id: string;
  subject: string;
  userType: GatewayUserType;
  roles: GatewayRole[];
  scopes: string[];
  deviceId?: string;
  firebaseUid?: string;
  guestId?: string;
  tenantId?: string;
  languageId?: string;
  [key: string]: unknown;
}
