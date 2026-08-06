/**
 * Central permission catalogue. Every protected route declares the
 * permission(s) it needs; roles are just named bundles of these keys.
 * Adding a new capability = add a key here + wire it into ROLE_PERMISSIONS.
 * This is what lets "role/permission design" grow without touching
 * business logic in controllers.
 */
const PERMISSIONS = {
  // Users
  USERS_READ_SELF: 'users:read:self',
  USERS_UPDATE_SELF: 'users:update:self',
  USERS_READ_ANY: 'users:read:any',
  USERS_UPDATE_ANY: 'users:update:any',
  USERS_BAN: 'users:ban',
  USERS_DELETE: 'users:delete:any', // admin/super_admin: DELETE /users/:id (general soft delete, any role)

  // Roles / admin management
  ROLES_MANAGE: 'roles:manage',
  ADMINS_MANAGE: 'admins:manage', // super_admin only: create/remove admin accounts

  // Categories
  CATEGORIES_READ: 'categories:read',
  CATEGORIES_MANAGE: 'categories:manage',

  // Stores / Sellers
  STORES_READ: 'stores:read',
  STORES_CREATE: 'stores:create',
  STORES_UPDATE_OWN: 'stores:update:own',
  STORES_MODERATE: 'stores:moderate', // approve/reject/suspend any store
  SELLER_APPLICATIONS_CREATE: 'seller_applications:create',
  SELLER_APPLICATIONS_REVIEW: 'seller_applications:review',
  SELLERS_DELETE: 'sellers:delete', // admin/super_admin: DELETE /admin/sellers/:sellerId

  // Products
  PRODUCTS_READ: 'products:read',
  PRODUCTS_CREATE_OWN: 'products:create:own',
  PRODUCTS_UPDATE_OWN: 'products:update:own',
  PRODUCTS_DELETE_OWN: 'products:delete:own',
  PRODUCTS_MODERATE: 'products:moderate', // approve/reject any product

  // Cart / Wishlist
  CART_MANAGE_SELF: 'cart:manage:self',
  WISHLIST_MANAGE_SELF: 'wishlist:manage:self',

  // Reviews
  REVIEWS_CREATE: 'reviews:create',
  REVIEWS_MODERATE: 'reviews:moderate',

  // Orders
  ORDERS_CREATE_SELF: 'orders:create:self',
  ORDERS_READ_SELF: 'orders:read:self',
  ORDERS_READ_STORE: 'orders:read:store', // seller: orders containing their store's items
  ORDERS_READ_ANY: 'orders:read:any',
  ORDERS_UPDATE_STATUS: 'orders:update:status', // admin/super_admin: any order, any legal transition
  ORDERS_UPDATE_STATUS_STORE: 'orders:update:status:store', // seller: own store's orders, CONFIRMED->PREPARING->SENT only

  // Payments
  PAYMENTS_CREATE_SELF: 'payments:create:self',
  PAYMENTS_READ_ANY: 'payments:read:any',
  WALLET_READ_SELF: 'wallet:read:self',

  // Support chat / Store chat
  SUPPORT_CHAT_USE: 'support_chat:use',
  SUPPORT_CHAT_STAFF: 'support_chat:staff',
  STORE_CHAT_CUSTOMER: 'store_chat:customer',
  STORE_CHAT_SELLER: 'store_chat:seller',

  // Notifications
  NOTIFICATIONS_READ_SELF: 'notifications:read:self',
  NOTIFICATIONS_BROADCAST: 'notifications:broadcast',

  // Admin
  ADMIN_DASHBOARD: 'admin:dashboard',
  ADMIN_ACTIVITY_LOG: 'admin:activity_log',

  // Hero slider
  HERO_READ: 'hero:read',
  HERO_MANAGE: 'hero:manage',
};

const ROLE_PERMISSIONS = {
  CUSTOMER: [
    PERMISSIONS.USERS_READ_SELF, PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.CATEGORIES_READ, PERMISSIONS.STORES_READ, PERMISSIONS.PRODUCTS_READ,
    PERMISSIONS.SELLER_APPLICATIONS_CREATE,
    PERMISSIONS.CART_MANAGE_SELF, PERMISSIONS.WISHLIST_MANAGE_SELF,
    PERMISSIONS.REVIEWS_CREATE,
    PERMISSIONS.ORDERS_CREATE_SELF, PERMISSIONS.ORDERS_READ_SELF,
    PERMISSIONS.PAYMENTS_CREATE_SELF, PERMISSIONS.WALLET_READ_SELF,
    PERMISSIONS.SUPPORT_CHAT_USE, PERMISSIONS.STORE_CHAT_CUSTOMER,
    PERMISSIONS.NOTIFICATIONS_READ_SELF, PERMISSIONS.HERO_READ,
  ],
  SELLER: [
    PERMISSIONS.USERS_READ_SELF, PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.CATEGORIES_READ, PERMISSIONS.STORES_READ, PERMISSIONS.STORES_UPDATE_OWN,
    PERMISSIONS.PRODUCTS_READ, PERMISSIONS.PRODUCTS_CREATE_OWN,
    PERMISSIONS.PRODUCTS_UPDATE_OWN, PERMISSIONS.PRODUCTS_DELETE_OWN,
    PERMISSIONS.ORDERS_READ_STORE, PERMISSIONS.ORDERS_UPDATE_STATUS_STORE, PERMISSIONS.WALLET_READ_SELF,
    PERMISSIONS.SUPPORT_CHAT_USE, PERMISSIONS.STORE_CHAT_SELLER,
    PERMISSIONS.NOTIFICATIONS_READ_SELF, PERMISSIONS.HERO_READ,
  ],
  ADMIN: [
    PERMISSIONS.USERS_READ_SELF, PERMISSIONS.USERS_UPDATE_SELF,
    PERMISSIONS.USERS_READ_ANY, PERMISSIONS.USERS_UPDATE_ANY, PERMISSIONS.USERS_BAN, PERMISSIONS.USERS_DELETE,
    PERMISSIONS.CATEGORIES_READ, PERMISSIONS.CATEGORIES_MANAGE,
    PERMISSIONS.STORES_READ, PERMISSIONS.STORES_CREATE, PERMISSIONS.STORES_MODERATE,
    PERMISSIONS.SELLER_APPLICATIONS_REVIEW, PERMISSIONS.SELLERS_DELETE,
    PERMISSIONS.PRODUCTS_READ, PERMISSIONS.PRODUCTS_MODERATE,
    PERMISSIONS.REVIEWS_MODERATE,
    PERMISSIONS.ORDERS_READ_ANY, PERMISSIONS.ORDERS_UPDATE_STATUS,
    PERMISSIONS.PAYMENTS_READ_ANY,
    PERMISSIONS.SUPPORT_CHAT_STAFF,
    PERMISSIONS.NOTIFICATIONS_READ_SELF, PERMISSIONS.NOTIFICATIONS_BROADCAST,
    PERMISSIONS.ADMIN_DASHBOARD, PERMISSIONS.ADMIN_ACTIVITY_LOG,
    PERMISSIONS.HERO_READ, PERMISSIONS.HERO_MANAGE,
  ],
  SUPER_ADMIN: ['*'], // wildcard: implicitly has every permission, incl. ADMINS_MANAGE / ROLES_MANAGE
};

module.exports = { PERMISSIONS, ROLE_PERMISSIONS };
