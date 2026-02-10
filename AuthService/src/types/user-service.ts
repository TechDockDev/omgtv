export interface UserServicePermission {
  id: string;
  resource: string;
  action: string;
  description?: string;
}

export interface UserServiceRole {
  id: string;
  name: string;
  description?: string;
  permissions: UserServicePermission[];
}

export interface UserServiceAssignment {
  assignmentId: string;
  userId: string;
  role: UserServiceRole;
  scope?: string;
  grantedBy?: string;
  active: boolean;
}

export interface UserServiceContext {
  userId: string;
  roles: UserServiceRole[];
  permissions: UserServicePermission[];
  assignments: UserServiceAssignment[];
}

export type GuestProfileStatus = "ACTIVE" | "MIGRATED";

export interface EnsureCustomerProfileResult {
  customerId: string;
  deviceIdentityId: string;
  guestMigrated: boolean;
  guestProfileId?: string;
}

export interface RegisterGuestResult {
  guestProfileId: string;
  deviceIdentityId: string;
  status: GuestProfileStatus;
  customerId?: string;
}

export interface DeviceInfoParams {
  os?: string;
  osVersion?: string;
  deviceName?: string;
  model?: string;
  appVersion?: string;
  network?: string;
  fcmToken?: string;
  permissions?: Record<string, boolean>;
}

export interface UserServiceIntegration {
  isEnabled: boolean;
  getUserContext(userId: string): Promise<UserServiceContext>;
  assignRole(params: {
    userId: string;
    roleId: string;
    scope?: string;
    grantedBy?: string;
  }): Promise<void>;
  revokeRole(params: {
    assignmentId: string;
    revokedBy?: string;
  }): Promise<void>;
  listRoles(): Promise<UserServiceRole[]>;
  ensureCustomerProfile(params: {
    firebaseUid: string;
    phoneNumber?: string;
    deviceId: string;
    guestId?: string;
    deviceInfo?: DeviceInfoParams;
  }): Promise<EnsureCustomerProfileResult>;
  registerGuest(params: {
    guestId: string;
    deviceId: string;
    deviceInfo?: DeviceInfoParams;
  }): Promise<RegisterGuestResult>;
}
