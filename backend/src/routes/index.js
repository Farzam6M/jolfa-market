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

module.exports = router;
