// routes/auth.js - Freemium authentication system

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// Environment setup
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set, using fallback key');
}

// Plan configuration
const PLAN_LIMITS = {
  free: 10,
  basic: 100, 
  premium: 500,
  enterprise: -1 // unlimited
};

// Validation rules
const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  body('name')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be 2-50 characters')
];

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
];

// REGISTER - Freemium signup
router.post('/register', registerValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid input',
        details: errors.array()
      });
    }

    const { email, password, name, businessName } = req.body;

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Account with this email already exists'
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user and initial usage record in transaction
    const newUser = await prisma.$transaction(async (tx) => {
      // Create user with free plan
      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          businessName: businessName || null,
          subscriptionPlan: 'free',
          subscriptionStatus: 'active',
          monthlyLimit: PLAN_LIMITS.free,
          isActive: true,
          emailVerified: true, // Skip email verification for freemium
        }
      });

      // Create usage tracking for current month
      const now = new Date();
      await tx.usage.create({
        data: {
          userId: user.id,
          month: now.getMonth(),
          year: now.getFullYear(),
          requestCount: 0
        }
      });

      return user;
    });

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: newUser.id,
        email: newUser.email,
        plan: newUser.subscriptionPlan 
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Remove password from response
    const { password: _, ...userResponse } = newUser;

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      user: {
        ...userResponse,
        subscriptionActive: true
      },
      token,
      plan: {
        name: 'Free',
        limit: PLAN_LIMITS.free,
        current: 0
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    
    if (error.code === 'P2002') {
      return res.status(400).json({
        success: false,
        error: 'Email already exists'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create account',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// LOGIN - with usage info
router.post('/login', loginValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid credentials format'
      });
    }

    const { email, password } = req.body;

    // Find user with current month usage
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        usage: {
          where: {
            month: new Date().getMonth(),
            year: new Date().getFullYear()
          }
        }
      }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password'
      });
    }

    // Check if account is active
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Account is deactivated'
      });
    }

    // Generate token
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        plan: user.subscriptionPlan 
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    // Calculate subscription status
    const isSubscriptionActive = user.subscriptionPlan === 'free' ? 
      true : user.subscriptionExpiresAt > new Date();

    // Get current usage
    const currentUsage = user.usage[0]?.requestCount || 0;

    // Remove password from response
    const { password: _, ...userResponse } = user;

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        ...userResponse,
        subscriptionActive: isSubscriptionActive
      },
      token,
      usage: {
        current: currentUsage,
        limit: user.monthlyLimit,
        remaining: user.monthlyLimit === -1 ? -1 : Math.max(0, user.monthlyLimit - currentUsage),
        resetDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// VERIFY TOKEN
router.post('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      });
    }

    // Verify JWT
    const decoded = jwt.verify(token, JWT_SECRET);

    // Find user with current usage
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        usage: {
          where: {
            month: new Date().getMonth(),
            year: new Date().getFullYear()
          }
        }
      },
      select: {
        id: true,
        email: true,
        name: true,
        businessName: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionExpiresAt: true,
        monthlyLimit: true,
        isActive: true,
        emailVerified: true,
        createdAt: true,
        usage: true
      }
    });

    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        error: 'User not found or inactive'
      });
    }

    // Calculate subscription status
    const isSubscriptionActive = user.subscriptionPlan === 'free' ? 
      true : user.subscriptionExpiresAt > new Date();

    // Get current usage
    const currentUsage = user.usage[0]?.requestCount || 0;

    res.json({
      success: true,
      valid: true,
      user: {
        ...user,
        subscriptionActive: isSubscriptionActive,
        usage: undefined // Remove from user object
      },
      usage: {
        current: currentUsage,
        limit: user.monthlyLimit,
        remaining: user.monthlyLimit === -1 ? -1 : Math.max(0, user.monthlyLimit - currentUsage),
        resetDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
      }
    });

  } catch (error) {
    console.error('Token verification error:', error);
    
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    res.status(500).json({
      success: false,
      error: 'Token verification failed'
    });
  }
});

// LOGOUT
router.post('/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// GET USER STATS (usage, plan info)
router.get('/stats', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        usage: {
          where: {
            month: new Date().getMonth(),
            year: new Date().getFullYear()
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const currentUsage = user.usage[0]?.requestCount || 0;

    res.json({
      success: true,
      stats: {
        plan: user.subscriptionPlan,
        status: user.subscriptionStatus,
        usage: {
          current: currentUsage,
          limit: user.monthlyLimit,
          remaining: user.monthlyLimit === -1 ? -1 : Math.max(0, user.monthlyLimit - currentUsage),
          percentage: user.monthlyLimit === -1 ? 0 : Math.round((currentUsage / user.monthlyLimit) * 100)
        },
        subscription: {
          active: user.subscriptionPlan === 'free' ? true : user.subscriptionExpiresAt > new Date(),
          expiresAt: user.subscriptionExpiresAt,
          canUpgrade: user.subscriptionPlan !== 'enterprise'
        }
      }
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get stats'
    });
  }
});

module.exports = router;