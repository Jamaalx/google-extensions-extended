const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// Rate limiting pentru autentificare
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute
  max: 5, // maxim 5 încercări de login per IP
  message: {
    error: 'Prea multe încercări de autentificare. Încearcă din nou în 15 minute.'
  }
});

// Validări pentru înregistrare
const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Adresa de email nu este validă'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Parola trebuie să aibă minimum 8 caractere')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Parola trebuie să conțină cel puțin o literă mică, una mare și o cifră'),
  body('name')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Numele trebuie să aibă între 2 și 50 de caractere'),
  body('businessName')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Numele businessului nu poate depăși 100 de caractere')
];

// Validări pentru login
const loginValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Adresa de email nu este validă'),
  body('password')
    .notEmpty()
    .withMessage('Parola este obligatorie')
];

// Înregistrare utilizator nou
router.post('/register', registerValidation, async (req, res) => {
  try {
    // Verifică erorile de validare
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Date invalide',
        details: errors.array()
      });
    }

    const { email, password, name, businessName } = req.body;

    // Verifică dacă utilizatorul există deja
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(409).json({
        error: 'Un cont cu această adresă de email există deja'
      });
    }

    // Hash parola
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Creează utilizatorul
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        businessName: businessName || null,
        subscriptionPlan: 'free', // plan gratuit implicit
        subscriptionStatus: 'active',
        subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 zile trial
      }
    });

    // Generează JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        plan: user.subscriptionPlan 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Nu returna parola în răspuns
    const { password: _, ...userWithoutPassword } = user;

    res.status(201).json({
      message: 'Cont creat cu succes',
      user: userWithoutPassword,
      token,
      expiresIn: '30d'
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      error: 'Eroare la crearea contului'
    });
  }
});

// Login utilizator
router.post('/login', authLimiter, loginValidation, async (req, res) => {
  try {
    // Verifică erorile de validare
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Date invalide',
        details: errors.array()
      });
    }

    const { email, password } = req.body;

    // Găsește utilizatorul
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
        error: 'Email sau parolă incorectă'
      });
    }

    // Verifică parola
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Email sau parolă incorectă'
      });
    }

    // Verifică dacă abonamentul este activ
    const isSubscriptionActive = user.subscriptionExpiresAt > new Date();
    
    // Generează JWT token
    const token = jwt.sign(
      { 
        userId: user.id,
        email: user.email,
        plan: user.subscriptionPlan 
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Actualizează ultima dată de login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    // Nu returna parola în răspuns
    const { password: _, ...userWithoutPassword } = user;

    res.json({
      message: 'Autentificare reușită',
      user: {
        ...userWithoutPassword,
        subscriptionActive: isSubscriptionActive
      },
      token,
      expiresIn: '30d'
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Eroare la autentificare'
    });
  }
});

// Verificarea token-ului
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Token de acces lipsește'
      });
    }

    // Verifică token-ul
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Găsește utilizatorul
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        email: true,
        name: true,
        businessName: true,
        subscriptionPlan: true,
        subscriptionStatus: true,
        subscriptionExpiresAt: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({
        error: 'Utilizatorul nu a fost găsit'
      });
    }

    // Verifică dacă abonamentul este activ
    const isSubscriptionActive = user.subscriptionExpiresAt > new Date();

    res.json({
      valid: true,
      user: {
        ...user,
        subscriptionActive: isSubscriptionActive
      }
    });

  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Token invalid'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expirat'
      });
    }

    console.error('Token verification error:', error);
    res.status(500).json({
      error: 'Eroare la verificarea token-ului'
    });
  }
});

// Logout (invalidarea token-ului se face pe client)
router.post('/logout', (req, res) => {
  res.json({
    message: 'Deconectare reușită'
  });
});

module.exports = router;