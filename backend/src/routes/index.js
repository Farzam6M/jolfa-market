const router = require('express').Router();

router.use('/auth', require('../modules/auth/auth.routes'));
router.use('/users', require('../modules/users/users.routes'));
router.use('/categories', require('../modules/categories/categories.routes'));
router.use('/stores', require('../modules/stores/stores.routes'));
router.use('/sellers', require('../modules/sellers/sellers.routes'));
router.use('/products', require('../modules/products/products.routes'));
router.use('/cart', require('../modules/cart/cart.routes'));
router.use('/wishlist', require('../modules/wishlist/wishlist.routes'));
router.use('/reviews', require('../modules/reviews/reviews.routes'));
router.use('/orders', require('../modules/orders/orders.routes'));
router.use('/payments', require('../modules/payments/payments.routes'));
router.use('/chat', require('../modules/support-chat/support-chat.routes'));
router.use('/notifications', require('../modules/notifications/notifications.routes'));
router.use('/hero', require('../modules/hero/hero.routes'));
router.use('/admin', require('../modules/admin/admin.routes'));
// Its own module/router (mirrors the categories/hero pattern) rather than
// being folded into admin.routes.js, which is reserved for the
// dashboard/activity-log/admin-account-management concerns unrelated to
// commission rule CRUD.
router.use('/admin/commission-rules', require('../modules/commission-rules/commission-rules.routes'));
// Same rationale as commission-rules above: read-only reporting over
// OrderItemSettlement, kept out of admin.routes.js which is reserved for
// dashboard/activity-log/admin-account-management concerns.
router.use('/admin/commission-report', require('../modules/commission-report/commission-report.routes'));

module.exports = router;