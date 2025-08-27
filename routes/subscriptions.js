const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');

const router = express.Router();
const prisma = new PrismaClient();

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

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth error:', error);
    res.status(401).json({
      error: 'Token invalid'
    });
  }
};

// Planurile disponibile
const PLANS = {
  basic: {
    name: 'Basic',
    price: 499, // în cents ($4.99)
    currency: 'usd',
    requests: 100, // ajustat pentru prețul mai mic
    stripePriceId: process.env.STRIPE_BASIC_PRICE_ID || 'price_basic'
  },
  premium: {
    name: 'Premium',
    price: 1499, // în cents ($14.99)
    currency: 'usd',
    requests: 500, // ajustat pentru prețul mai mic
    stripePriceId: process.env.STRIPE_PREMIUM_PRICE_ID || 'price_premium'
  },
  enterprise: {
    name: 'Enterprise',
    price: 4999, // în cents ($49.99)
    currency: 'usd',
    requests: 2000, // ajustat pentru prețul mai mic
    stripePriceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || 'price_enterprise'
  }
};

// Obținerea planurilor disponibile
router.get('/plans', (req, res) => {
  const publicPlans = Object.entries(PLANS).map(([key, plan]) => ({
    id: key,
    name: plan.name,
    price: plan.price,
    currency: plan.currency,
    requests: plan.requests,
    features: getPlanFeatures(key)
  }));

  res.json({
    plans: publicPlans
  });
});

// Funcție helper pentru features
function getPlanFeatures(planId) {
  const features = {
    free: [
      '10 răspunsuri AI pe lună',
      'Suport comunitate',
      'Toate limbile disponibile'
    ],
    basic: [
      '500 răspunsuri AI pe lună',
      'Suport email',
      'Istoricul răspunsurilor',
      'Toate limbile și tonurile'
    ],
    premium: [
      '2000 răspunsuri AI pe lună',
      'Suport prioritar',
      'Statistici avansate',
      'Export date',
      'Integrări API'
    ],
    enterprise: [
      'Răspunsuri AI nelimitate',
      'Suport telefonic 24/7',
      'Manager dedicat',
      'Customizări personalizate',
      'SLA garantat'
    ]
  };
  
  return features[planId] || [];
}

// Crearea unei sesiuni Checkout pentru abonament
router.post('/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    const { planId } = req.body;
    const user = req.user;

    if (!PLANS[planId]) {
      return res.status(400).json({
        error: 'Plan invalid'
      });
    }

    const plan = PLANS[planId];

    // Creează sau găsește customerul în Stripe
    let stripeCustomerId = user.stripeCustomerId;
    
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: {
          userId: user.id
        }
      });
      
      stripeCustomerId = customer.id;
      
      // Actualizează utilizatorul cu ID-ul customerului
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId }
      });
    }

    // Creează sesiunea Checkout
    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      line_items: [
        {
          price: plan.stripePriceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/cancel`,
      metadata: {
        userId: user.id,
        planId: planId
      }
    });

    res.json({
      checkoutUrl: session.url,
      sessionId: session.id
    });

  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({
      error: 'Eroare la crearea sesiunii de plată'
    });
  }
});

// Verificarea statusului unei sesiuni Checkout
router.get('/checkout-session/:sessionId', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.metadata.userId !== req.user.id) {
      return res.status(403).json({
        error: 'Acces interzis'
      });
    }

    res.json({
      status: session.payment_status,
      customerEmail: session.customer_details?.email,
      amountTotal: session.amount_total
    });

  } catch (error) {
    console.error('Session check error:', error);
    res.status(500).json({
      error: 'Eroare la verificarea sesiunii'
    });
  }
});

// Obținerea statusului abonamentului curent
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    // Obține utilizarea curentă
    const usage = await prisma.usage.findUnique({
      where: {
        userId_month_year: {
          userId: user.id,
          month: currentMonth,
          year: currentYear
        }
      }
    });

    const isActive = user.subscriptionExpiresAt > new Date();
    const planLimit = PLANS[user.subscriptionPlan]?.requests || 10;

    res.json({
      plan: user.subscriptionPlan,
      status: user.subscriptionStatus,
      isActive,
      expiresAt: user.subscriptionExpiresAt,
      usage: {
        current: usage?.requestCount || 0,
        limit: planLimit,
        remaining: planLimit === -1 ? -1 : Math.max(0, planLimit - (usage?.requestCount || 0))
      },
      billing: {
        stripeCustomerId: user.stripeCustomerId,
        subscriptionId: user.stripeSubscriptionId
      }
    });

  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      error: 'Eroare la obținerea statusului'
    });
  }
});

// Anularea abonamentului
router.post('/cancel', authenticateToken, async (req, res) => {
  try {
    const user = req.user;

    if (!user.stripeSubscriptionId) {
      return res.status(400).json({
        error: 'Nu ai un abonament activ'
      });
    }

    // Anulează abonamentul în Stripe (la sfârșitul perioadei de facturare)
    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    // Actualizează statusul în database
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: 'cancelled'
      }
    });

    res.json({
      message: 'Abonamentul va fi anulat la sfârșitul perioadei de facturare',
      status: 'cancelled'
    });

  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({
      error: 'Eroare la anularea abonamentului'
    });
  }
});

// Reactivarea abonamentului anulat
router.post('/reactivate', authenticateToken, async (req, res) => {
  try {
    const user = req.user;

    if (!user.stripeSubscriptionId) {
      return res.status(400).json({
        error: 'Nu ai un abonament de reactivat'
      });
    }

    // Reactivează abonamentul în Stripe
    await stripe.subscriptions.update(user.stripeSubscriptionId, {
      cancel_at_period_end: false
    });

    // Actualizează statusul în database
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: 'active'
      }
    });

    res.json({
      message: 'Abonamentul a fost reactivat cu succes',
      status: 'active'
    });

  } catch (error) {
    console.error('Reactivate subscription error:', error);
    res.status(500).json({
      error: 'Eroare la reactivarea abonamentului'
    });
  }
});

// Webhook pentru evenimente Stripe
router.post('/webhook', 
  express.raw({ type: 'application/json' }), 
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body, 
        sig, 
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.log('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(event.data.object);
          break;
          
        case 'invoice.payment_succeeded':
          await handlePaymentSucceeded(event.data.object);
          break;
          
        case 'invoice.payment_failed':
          await handlePaymentFailed(event.data.object);
          break;
          
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event.data.object);
          break;
          
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event.data.object);
          break;
          
        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      res.json({ received: true });
      
    } catch (error) {
      console.error('Webhook processing error:', error);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

// Handler functions pentru webhook-uri
async function handleCheckoutCompleted(session) {
  const userId = session.metadata.userId;
  const planId = session.metadata.planId;
  
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  
  await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionPlan: planId,
      subscriptionStatus: 'active',
      subscriptionExpiresAt: new Date(subscription.current_period_end * 1000),
      stripeSubscriptionId: subscription.id
    }
  });
}

async function handlePaymentSucceeded(invoice) {
  if (invoice.subscription) {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const customer = await stripe.customers.retrieve(subscription.customer);
    
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: customer.id }
    });
    
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: 'active',
          subscriptionExpiresAt: new Date(subscription.current_period_end * 1000)
        }
      });
    }
  }
}

async function handlePaymentFailed(invoice) {
  if (invoice.subscription) {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const customer = await stripe.customers.retrieve(subscription.customer);
    
    const user = await prisma.user.findFirst({
      where: { stripeCustomerId: customer.id }
    });
    
    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          subscriptionStatus: 'past_due'
        }
      });
    }
  }
}

async function handleSubscriptionUpdated(subscription) {
  const customer = await stripe.customers.retrieve(subscription.customer);
  
  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customer.id }
  });
  
  if (user) {
    let status = subscription.status;
    if (subscription.cancel_at_period_end) {
      status = 'cancelled';
    }
    
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionStatus: status,
        subscriptionExpiresAt: new Date(subscription.current_period_end * 1000)
      }
    });
  }
}

async function handleSubscriptionDeleted(subscription) {
  const customer = await stripe.customers.retrieve(subscription.customer);
  
  const user = await prisma.user.findFirst({
    where: { stripeCustomerId: customer.id }
  });
  
  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        subscriptionPlan: 'free',
        subscriptionStatus: 'cancelled',
        subscriptionExpiresAt: new Date(),
        stripeSubscriptionId: null
      }
    });
  }
}

module.exports = router;