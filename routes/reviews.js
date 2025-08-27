// routes/reviews.js - Updated with freemium usage tracking

const express = require('express');
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const OpenAI = require('openai');

const router = express.Router();
const prisma = new PrismaClient();

// Environment setup
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-key';
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Authentication middleware with usage check
const authenticateAndCheckUsage = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    
    // Get user with current month usage
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

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'User not found or inactive'
      });
    }

    // Check subscription status
    const isSubscriptionActive = user.subscriptionPlan === 'free' ? 
      true : user.subscriptionExpiresAt > new Date();

    if (!isSubscriptionActive) {
      return res.status(403).json({
        success: false,
        error: 'Subscription expired',
        code: 'SUBSCRIPTION_EXPIRED'
      });
    }

    // Check usage limits (except for unlimited plans)
    const currentUsage = user.usage[0]?.requestCount || 0;
    if (user.monthlyLimit !== -1 && currentUsage >= user.monthlyLimit) {
      return res.status(429).json({
        success: false,
        error: 'Monthly usage limit reached',
        code: 'USAGE_LIMIT_REACHED',
        usage: {
          current: currentUsage,
          limit: user.monthlyLimit,
          resetDate: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
        }
      });
    }

    req.user = user;
    req.currentUsage = currentUsage;
    next();

  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

// Validation
const generateValidation = [
  body('reviewText').trim().isLength({ min: 10, max: 5000 }),
  body('tone').isIn(['professional', 'friendly', 'apologetic', 'grateful']),
  body('language').isIn(['en', 'ro', 'es', 'fr', 'de', 'it']).optional()
];

// GENERATE RESPONSE - Main endpoint
router.post('/generate', authenticateAndCheckUsage, generateValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid input',
        details: errors.array()
      });
    }

    const { reviewText, tone, language = 'en', businessType = 'general' } = req.body;
    const user = req.user;
    const startTime = Date.now();

    // Build AI prompt
    const prompt = buildResponsePrompt(reviewText, tone, language, businessType, user.businessName);

    let responseText, tokensUsed = 0, cost = 0;

    try {
      // Call OpenAI API
      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a professional customer service assistant. Generate helpful, appropriate responses to customer reviews in the requested language and tone.'
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

      responseText = completion.choices[0].message.content;
      tokensUsed = completion.usage.total_tokens;
      
      // Calculate cost (approximate)
      const inputTokens = completion.usage.prompt_tokens;
      const outputTokens = completion.usage.completion_tokens;
      cost = (inputTokens * 0.00003) + (outputTokens * 0.00006);

    } catch (openaiError) {
      console.error('OpenAI API error:', openaiError);
      
      // Return a fallback response instead of failing
      responseText = generateFallbackResponse(reviewText, tone, language);
    }

    const duration = Date.now() - startTime;

    // Update usage and log API call in transaction
    const updatedUsage = await prisma.$transaction(async (tx) => {
      // Update usage count
      const usage = await tx.usage.upsert({
        where: {
          userId_month_year: {
            userId: user.id,
            month: new Date().getMonth(),
            year: new Date().getFullYear()
          }
        },
        update: {
          requestCount: {
            increment: 1
          }
        },
        create: {
          userId: user.id,
          month: new Date().getMonth(),
          year: new Date().getFullYear(),
          requestCount: 1
        }
      });

      // Log API call
      await tx.apiCall.create({
        data: {
          userId: user.id,
          reviewText: reviewText.substring(0, 500),
          responseText: responseText.substring(0, 500),
          language,
          tone,
          model: 'gpt-4',
          businessType,
          tokensUsed,
          cost,
          duration,
          success: true
        }
      });

      return usage;
    });

    // Prepare response
    const remaining = user.monthlyLimit === -1 ? -1 : Math.max(0, user.monthlyLimit - updatedUsage.requestCount);

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
        limit: user.monthlyLimit,
        remaining,
        percentage: user.monthlyLimit === -1 ? 0 : Math.round((updatedUsage.requestCount / user.monthlyLimit) * 100)
      }
    });

  } catch (error) {
    console.error('Generate response error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate response'
    });
  }
});

// GET HISTORY
router.get('/history', authenticateAndCheckUsage, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const offset = (page - 1) * limit;

    const [calls, totalCount] = await Promise.all([
      prisma.apiCall.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          reviewText: true,
          responseText: true,
          language: true,
          tone: true,
          businessType: true,
          success: true,
          createdAt: true
        }
      }),
      prisma.apiCall.count({
        where: { userId: req.user.id }
      })
    ]);

    res.json({
      success: true,
      data: calls,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasNext: page * limit < totalCount,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('History error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get history'
    });
  }
});

// GET STATS
router.get('/stats', authenticateAndCheckUsage, async (req, res) => {
  try {
    const now = new Date();
    
    // Current month usage
    const currentMonth = await prisma.usage.findUnique({
      where: {
        userId_month_year: {
          userId: req.user.id,
          month: now.getMonth(),
          year: now.getFullYear()
        }
      }
    });

    // Total usage
    const totalCalls = await prisma.apiCall.count({
      where: { userId: req.user.id, success: true }
    });

    const currentUsage = currentMonth?.requestCount || 0;
    const remaining = req.user.monthlyLimit === -1 ? -1 : Math.max(0, req.user.monthlyLimit - currentUsage);

    res.json({
      success: true,
      currentMonth: {
        requests: currentUsage,
        limit: req.user.monthlyLimit,
        remaining,
        percentage: req.user.monthlyLimit === -1 ? 0 : Math.round((currentUsage / req.user.monthlyLimit) * 100),
        resetDate: new Date(now.getFullYear(), now.getMonth() + 1, 1)
      },
      allTime: {
        totalRequests: totalCalls
      },
      plan: {
        name: req.user.subscriptionPlan,
        status: req.user.subscriptionStatus,
        canUpgrade: req.user.subscriptionPlan !== 'enterprise'
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

// Helper functions
function buildResponsePrompt(reviewText, tone, language, businessType, businessName) {
  const languageNames = {
    en: 'English',
    ro: 'Romanian',
    es: 'Spanish', 
    fr: 'French',
    de: 'German',
    it: 'Italian'
  };

  const toneInstructions = {
    professional: 'Write a professional, business-appropriate response.',
    friendly: 'Write a warm, friendly, and personable response.',
    apologetic: 'Write an apologetic response that acknowledges any issues mentioned.',
    grateful: 'Write a grateful response that thanks the customer for their feedback.'
  };

  return `Please write a ${tone} response to this customer review in ${languageNames[language]}.

Review: "${reviewText}"

Instructions:
- Respond entirely in ${languageNames[language]}
- Use a ${tone} tone: ${toneInstructions[tone]}
- Keep it concise (under 100 words)
- Be genuine and helpful
- Address specific points when relevant
- Thank the customer for their feedback
${businessName ? `- You represent ${businessName}` : ''}
- Include a call to action when appropriate`;
}

function generateFallbackResponse(reviewText, tone, language) {
  const responses = {
    en: {
      professional: 'Thank you for your feedback. We appreciate you taking the time to share your experience with us.',
      friendly: 'Thanks so much for your review! We really appreciate you sharing your thoughts with us.',
      apologetic: 'We sincerely apologize for any inconvenience. Your feedback is important to us and we will work to improve.',
      grateful: 'Thank you so much for your wonderful feedback! We truly appreciate your support.'
    }
  };

  return responses[language]?.[tone] || responses.en.professional;
}

module.exports = router;