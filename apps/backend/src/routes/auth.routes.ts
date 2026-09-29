import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth';
import { createAuthRateLimiters } from '../middleware/rate-limit';

export function createAuthRouter(): Router {
  const limiters = createAuthRateLimiters();
  const router = Router();

  router.post('/register', limiters.register, authController.register);
  router.post('/login', limiters.login, authController.login);
  router.post('/refresh', limiters.refresh, authController.refresh);
  router.post('/logout', authController.logout);
  router.get('/me', requireAuth, authController.me);

  return router;
}
