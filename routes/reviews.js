const express = require('express');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const OpenAI = require('openai');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const router = express.Router();
const prisma = new PrismaClient();

// Inițializează OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware pentru autentificare
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Token de acces lipsește'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return res.status(404).json({
        error: 'Utilizatorul nu a fost găsit'
      });
    }

    // Verifică dacă abonamentul este activ
    if (user.subscriptionExpiresAt < new Date()) {
      return res.status(403).json({
        error: 'Abonamentul a expirat',
        subscriptionExpired: true
      });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({
      error: 'Token invalid'
    });
  }
};

// Rate limiting pentru generarea răspunsurilor
const generateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minut
  max: 10, // maxim 10 cereri per minut per utilizator
  keyGenerator: (req) => req.user ? req.user.id : req.ip,
  message: {
    error: 'Prea multe cereri. Încearcă din nou în 1 minut.'
  }
});

// Middleware pentru verificarea limitelor planului
const checkPlanLimits = async (req, res, next) => {
  try {
    const user = req.user;
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    
    // Găsește utilizarea curentă
    let usage = await prisma.usage.findUnique({
      where: {
        userId_month_year: {
          userId: user.id,
          month: currentMonth,
          year: currentYear
        }
      }
    });

    // Dacă nu există înregistrare pentru luna curentă, o creează
    if (!usage) {
      usage = await prisma.usage.create({
        data: {
          userId: user.id,
          month: currentMonth,
          year: currentYear,
          requestCount: 0
        }
      });
    }

    // Definește limitele pentru fiecare plan
    const planLimits = {
      free: 10,
      basic: 500,
      premium: 2000,
      enterprise: -1 // unlimited
    };

    const userLimit = planLimits[user.subscriptionPlan] || 0;
    
    // Verifică dacă utilizatorul a depășit limita
    if (userLimit !== -1 && usage.requestCount >= userLimit) {
      return res.status(429).json({
        error: 'Ai depășit limita lunară pentru planul tău',
        currentUsage: usage.requestCount,
        limit: userLimit,
        plan: user.subscriptionPlan,
        upgradeRequired: true
      });
    }

    req.usage = usage;
    req.planLimit = userLimit;
    next();
  } catch (error) {
    console.error('Plan limits check error:', error);
    res.status(500).json({
      error: 'Eroare la verificarea limitelor'
    });
  }
};

// Validări pentru generarea răspunsului
const generateValidation = [
  body('reviewText')
    .trim()
    .isLength({ min: 5, max: 2000 })
    .withMessage('Textul recenziei trebuie să aibă între 5 și 2000 de caractere'),
  body('tone')
    .isIn(['professional', 'friendly', 'apologetic', 'grateful'])
    .withMessage('Tonul trebuie să fie: professional, friendly, apologetic sau grateful'),
  body('language')
    .isIn(['en', 'ro', 'es', 'fr', 'de', 'it'])
    .withMessage('Limba trebuie să fie: en, ro, es, fr, de sau it'),
  body('businessType')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Tipul businessului nu poate depăși 50 de caractere')
];

// Funcția pentru construirea prompt-ului
function buildPrompt(reviewText, tone, language, businessType = 'restaurant') {
  const languageNames = {
    'en': 'English',
    'ro': 'Romanian (Română)', 
    'es': 'Spanish (Español)',
    'fr': 'French (Français)',
    'de': 'German (Deutsch)',
    'it': 'Italian (Italiano)'
  };

  const toneInstructions = {
    professional: 'Write a professional, business-appropriate response that maintains a formal but warm tone.',
    friendly: 'Write a warm, friendly, and personable response that feels conversational and approachable.',
    apologetic: 'Write a sincere, apologetic response that acknowledges any issues mentioned and shows genuine concern.',
    grateful: 'Write a grateful, appreciative response that genuinely thanks the customer for their feedback and time.'
  };

  const selectedLanguage = languageNames[language] || 'English';
  const businessTypeText = businessType === 'restaurant' ? 'restaurant/food business' : businessType;

  return `You are a professional customer service manager for a ${businessTypeText}. Write a ${tone} response to this customer review in ${selectedLanguage}.

Customer Review: "${reviewText}"

Response Requirements:
- Language: Write entirely in ${selectedLanguage}
- Tone: ${toneInstructions[tone]}
- Length: Keep it concise (50-100 words maximum)
- Authenticity: Sound genuine and human, not robotic
- Personalization: Address specific points mentioned in the review when relevant
- Gratitude: Always thank the customer for their feedback
- Action: Include a subtle call to action when appropriate (visit again, contact directly, etc.)
- Professionalism: Suitable for public display on Google, Yelp, etc.
- Completeness: Write a complete response that needs no editing
- No placeholders: Do not include [Name], [Business Name], or similar placeholders

Important: Write ONLY the response text in ${selectedLanguage}. Do not include quotes, prefixes, or explanations.`;
}

// Endpoint principal pentru generarea răspunsului
router.post('/generate', 
  authenticateToken,
  checkPlanLimits,
  generateLimiter,
  generateValidation,
  async (req, res) => {
    const startTime = Date.now();
    let tokensUsed = 0;
    let cost = 0;

    try {
      // Verifică erorile de validare
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Date invalide',
          details: errors.array()
        });
      }

      const { reviewText, tone, language, businessType = 'restaurant' } = req.body;
      const user = req.user;

      // Construiește prompt-ul
      const prompt = buildPrompt(reviewText, tone, language, businessType);

      // Apelează OpenAI API
      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a professional customer service assistant specializing in crafting authentic, helpful responses to business reviews. Generate responses that sound natural and human while maintaining professionalism.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 250,
        temperature: 0.7,
        presence_penalty: 0.1,
        frequency_penalty: 0.1
      });

      const responseText = completion.choices[0].message.content;
      tokensUsed = completion.usage.total_tokens;
      
      // Calculează costul aproximativ (GPT-4: $0.03 per 1K tokens input + $0.06 per 1K tokens output)
      const inputTokens = completion.usage.prompt_tokens;
      const outputTokens = completion.usage.completion_tokens;
      cost = (inputTokens * 0.00003) + (outputTokens * 0.00006);

      const duration = Date.now() - startTime;

      // Actualizează utilizarea utilizatorului
      await prisma.usage.update({
        where: {
          userId_month_year: {
            userId: user.id,
            month: new Date().getMonth(),
            year: new Date().getFullYear()
          }
        },
        data: {
          requestCount: {
            increment: 1
          }
        }
      });

      // Înregistrează apelul API pentru analiză
      await prisma.apiCall.create({
        data: {
          userId: user.id,
          reviewText: reviewText.substring(0, 500), // limitează pentru storage
          responseText: responseText.substring(0, 500),
          language,
          tone,
          model: 'gpt-4',
          tokensUsed,
          cost,
          duration,
          success: true
        }
      });

      // Obține utilizarea actualizată
      const updatedUsage = await prisma.usage.findUnique({
        where: {
          userId_month_year: {
            userId: user.id,
            month: new Date().getMonth(),
            year: new Date().getFullYear()
          }
        }
      });

      res.json({
        success: true,
        response: responseText,
        metadata: {
          tokensUsed,
          cost: cost.toFixed(6),
          duration,
          language,
          tone,
          model: 'gpt-4'
        },
        usage: {
          current: updatedUsage.requestCount,
          limit: req.planLimit,
          remaining: req.planLimit === -1 ? -1 : Math.max(0, req.planLimit - updatedUsage.requestCount)
        }
      });

    } catch (error) {
      console.error('Generate response error:', error);
      
      // Înregistrează eroarea pentru debugging
      try {
        await prisma.apiCall.create({
          data: {
            userId: req.user.id,
            reviewText: req.body.reviewText?.substring(0, 500) || '',
            responseText: '',
            language: req.body.language || 'en',
            tone: req.body.tone || 'professional',
            model: 'gpt-4',
            tokensUsed,
            cost,
            duration: Date.now() - startTime,
            success: false,
            errorMessage: error.message
          }
        });
      } catch (logError) {
        console.error('Failed to log error:', logError);
      }

      // Returnează eroarea utilizatorului
      if (error.code === 'insufficient_quota') {
        return res.status(503).json({
          error: 'Serviciul este temporar indisponibil. Încearcă din nou în câteva minute.',
          type: 'quota_exceeded'
        });
      }

      if (error.code === 'rate_limit_exceeded') {
        return res.status(429).json({
          error: 'Prea multe cereri către serviciul AI. Încearcă din nou în câteva secunde.',
          type: 'rate_limit'
        });
      }

      res.status(500).json({
        error: 'Eroare la generarea răspunsului',
        message: 'A apărut o problemă tehnică. Încearcă din nou.',
        type: 'internal_error'
      });
    }
  }
);

// Endpoint pentru obținerea istoricului răspunsurilor
router.get('/history', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const skip = (page - 1) * limit;

    const history = await prisma.apiCall.findMany({
      where: {
        userId: req.user.id,
        success: true
      },
      select: {
        id: true,
        reviewText: true,
        responseText: true,
        language: true,
        tone: true,
        createdAt: true,
        tokensUsed: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip,
      take: limit
    });

    const total = await prisma.apiCall.count({
      where: {
        userId: req.user.id,
        success: true
      }
    });

    res.json({
      history,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({
      error: 'Eroare la obținerea istoricului'
    });
  }
});

// Endpoint pentru obținerea statisticilor utilizării
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    // Utilizarea curentă
    const usage = await prisma.usage.findUnique({
      where: {
        userId_month_year: {
          userId: req.user.id,
          month: currentMonth,
          year: currentYear
        }
      }
    });

    // Statistici generale
    const totalCalls = await prisma.apiCall.count({
      where: {
        userId: req.user.id,
        success: true
      }
    });

    const totalCost = await prisma.apiCall.aggregate({
      where: {
        userId: req.user.id,
        success: true
      },
      _sum: {
        cost: true
      }
    });

    // Distribuția pe limbă și ton (ultimele 30 de zile)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const languageStats = await prisma.apiCall.groupBy({
      by: ['language'],
      where: {
        userId: req.user.id,
        success: true,
        createdAt: {
          gte: thirtyDaysAgo
        }
      },
      _count: {
        language: true
      }
    });

    const toneStats = await prisma.apiCall.groupBy({
      by: ['tone'],
      where: {
        userId: req.user.id,
        success: true,
        createdAt: {
          gte: thirtyDaysAgo
        }
      },
      _count: {
        tone: true
      }
    });

    res.json({
      currentMonth: {
        requests: usage?.requestCount || 0,
        limit: getPlanLimit(req.user.subscriptionPlan)
      },
      allTime: {
        totalRequests: totalCalls,
        totalCost: totalCost._sum.cost || 0
      },
      trends: {
        languages: languageStats,
        tones: toneStats
      }
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      error: 'Eroare la obținerea statisticilor'
    });
  }
});

// Funcție helper pentru limitele planurilor
function getPlanLimit(plan) {
  const limits = {
    free: 10,
    basic: 500,
    premium: 2000,
    enterprise: -1
  };
  return limits[plan] || 0;
}

module.exports = router;