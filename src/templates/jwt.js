// Files written by `exg install:jwt`. Kept here so the installer logic stays readable.

export const authConfig = `// Read on use (not at import) so tests and tools that never sign tokens don't need a secret.
export function authConfig(env = process.env) {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters (e.g. openssl rand -hex 32)');
  }
  return { secret, expiresIn: env.JWT_EXPIRES_IN || '1d' };
}
`;

export const authService = `import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';
import { authConfig } from '../config/auth.js';

// The password hash is hidden from every query by the global \`omit\` in src/config/db.js.
// Only login asks for it explicitly with \`omit: { password: false }\`.

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

// Stored as "scrypt$<salt>$<hash>" so the format can change later without breaking old hashes.
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH);
  return \`scrypt$\${salt.toString('base64url')}$\${hash.toString('base64url')}\`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = String(stored).split('$');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Checked when the email is unknown, so a login takes the same time whether or not the account exists.
let dummyHash;

export class AuthService {
  static signToken(user) {
    const { secret, expiresIn } = authConfig();
    return jwt.sign({ sub: String(user.id) }, secret, { expiresIn, algorithm: 'HS256' });
  }

  // Returns the user id from a valid token; throws a 401 error otherwise.
  static verifyToken(token) {
    try {
      const { sub } = jwt.verify(token, authConfig().secret, { algorithms: ['HS256'] });
      const id = Number(sub);
      if (!Number.isInteger(id)) throw new Error('bad subject');
      return id;
    } catch (error) {
      throw httpError(401, error.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    }
  }

  static async register({ name, email, password }) {
    const user = await prisma.user.create({ data: { name, email, password: await hashPassword(password) } });
    return { user, token: AuthService.signToken(user) };
  }

  static async login({ email, password }) {
    const found = await prisma.user.findUnique({ where: { email }, omit: { password: false } });
    dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
    const valid = await verifyPassword(password, found?.password ?? dummyHash);
    // Same message for unknown email and wrong password, so attackers can't probe which emails exist.
    if (!found?.password || !valid) throw httpError(401, 'Invalid email or password');
    const { password: _hash, ...user } = found;
    return { user, token: AuthService.signToken(user) };
  }

  static findUser(id) {
    return prisma.user.findUnique({ where: { id } });
  }
}
`;

export const authMiddleware = `import { AuthService } from '../services/AuthService.js';

// Protects a route: expects "Authorization: Bearer <token>" and sets req.user.
// Usage: router.post('/', requireAuth, ProductController.store);
export async function requireAuth(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const id = AuthService.verifyToken(token);
    // Load the user on every request so a deleted account loses access immediately.
    const user = await AuthService.findUser(id);
    if (!user) return res.status(401).json({ success: false, message: 'Invalid token' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
`;

export const authController = `import { AuthService } from '../services/AuthService.js';

export class AuthController {
  // POST /api/auth/register
  static async register(req, res, next) {
    try {
      const result = await AuthService.register(req.body);
      res.status(201).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  // POST /api/auth/login
  static async login(req, res, next) {
    try {
      const result = await AuthService.login(req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  // GET /api/auth/me (requireAuth sets req.user)
  static me(req, res) {
    res.json({ success: true, data: req.user });
  }
}
`;

export const registerRequest = `import { z } from 'zod';
import { validate } from '../middlewares/validate.js';

// Laravel-dəki FormRequest kimi: POST /api/auth/register qaydaları.
export const RegisterSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  // The upper limit keeps hashing cost bounded for very long inputs.
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

export default validate(RegisterSchema);
`;

export const loginRequest = `import { z } from 'zod';
import { validate } from '../middlewares/validate.js';

// Laravel-dəki FormRequest kimi: POST /api/auth/login qaydaları.
export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});

export default validate(LoginSchema);
`;

export const authRoutes = `import { Router } from 'express';
import { AuthController } from '../controllers/AuthController.js';
import { requireAuth } from '../middlewares/auth.js';
import LoginRequest from '../requests/LoginRequest.js';
import RegisterRequest from '../requests/RegisterRequest.js';

const router = Router();

router.post('/register', RegisterRequest, AuthController.register);
router.post('/login', LoginRequest, AuthController.login);
router.get('/me', requireAuth, AuthController.me);

export default router;
`;

export const validateMiddleware = `export const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(422).json({ success: false, message: 'Validation failed', errors: result.error.issues });
  }
  req.body = result.data;
  next();
};
`;

export const authTest = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';

// These tests never connect to a database.
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long';
const { AuthService, hashPassword, verifyPassword } = await import('../src/services/AuthService.js');
const { authConfig } = await import('../src/config/auth.js');

test('passwords are hashed with a random salt and verified', async () => {
  const first = await hashPassword('correct horse');
  assert.notEqual(first, await hashPassword('correct horse'));
  assert.ok(first.length <= 191, 'hash must fit a VARCHAR(191) column');
  assert.equal(await verifyPassword('correct horse', first), true);
  assert.equal(await verifyPassword('wrong horse', first), false);
  assert.equal(await verifyPassword('correct horse', 'not-a-hash'), false);
});

test('tokens carry the user id and reject tampering, expiry and other algorithms', () => {
  assert.equal(AuthService.verifyToken(AuthService.signToken({ id: 7 })), 7);
  const { secret } = authConfig();
  assert.throws(() => AuthService.verifyToken(jwt.sign({ sub: '7' }, secret, { expiresIn: -10 })), { statusCode: 401, message: 'Token expired' });
  assert.throws(() => AuthService.verifyToken(jwt.sign({ sub: '7' }, 'another-secret-another-secret-123')), { statusCode: 401 });
  assert.throws(() => AuthService.verifyToken(jwt.sign({ sub: '7' }, null, { algorithm: 'none' })), { statusCode: 401 });
});

test('a short or missing JWT_SECRET is refused', () => {
  assert.throws(() => authConfig({}), /JWT_SECRET/);
  assert.throws(() => authConfig({ JWT_SECRET: 'short' }), /JWT_SECRET/);
});
`;
