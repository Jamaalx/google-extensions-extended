const express = require('express');
const { body, validationResult } = require('express-validator');
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

// Tipurile de business predefinite
const BUSINESS_TYPES = {
  restaurant: {
    name: 'Restaurant/Cafenea',
    keywords: ['mâncare', 'servire', 'gust', 'atmosferă', 'personal', 'bucătar'],
    responseStyle: 'warm_hospitality',
    commonIssues: ['servire lentă', 'mâncare rece', 'zgomot', 'prețuri'],
    positiveAspects: ['gust', 'porții', 'ambianță', 'personal amabil']
  },
  hotel: {
    name: 'Hotel/Cazare',
    keywords: ['cameră', 'curățenie', 'personal', 'servicii', 'locație'],
    responseStyle: 'professional_hospitality',
    commonIssues: ['cameră murdară', 'zgomot', 'wifi', 'aer condiționat'],
    positiveAspects: ['curățenie', 'locație', 'personal', 'facilități']
  },
  medical: {
    name: 'Servicii Medicale',
    keywords: ['doctor', 'tratament', 'personal', 'programare', 'diagnostic'],
    responseStyle: 'professional_caring',
    commonIssues: ['timp de așteptare', 'comunicare', 'programări'],
    positiveAspects: ['profesionalism', 'grijă', 'rezultate', 'explicații']
  },
  retail: {
    name: 'Retail/Magazin',
    keywords: ['produse', 'personal', 'prețuri', 'calitate', 'disponibilitate'],
    responseStyle: 'helpful_professional',
    commonIssues: ['produse indisponibile', 'cozi', 'schimburi', 'prețuri'],
    positiveAspects: ['varietate', 'calitate', 'prețuri', 'personal util']
  },
  beauty: {
    name: 'Salon/Beauty',
    keywords: ['servicii', 'personal', 'rezultat', 'programare', 'prețuri'],
    responseStyle: 'personal_caring',
    commonIssues: ['rezultat nesatisfăcător', 'întârzieri', 'programări'],
    positiveAspects: ['rezultat', 'profesionalism', 'ambianță', 'experiență']
  },
  automotive: {
    name: 'Service Auto',
    keywords: ['reparație', 'personal', 'prețuri', 'timp', 'calitate'],
    responseStyle: 'technical_professional',
    commonIssues: ['prețuri mari', 'timp lung', 'explicații neclare'],
    positiveAspects: ['rapiditate', 'calitate', 'personal', 'prețuri corecte']
  }
};

// Obținerea tipurilor de business disponibile
router.get('/types', (req, res) => {
  const businessTypes = Object.entries(BUSINESS_TYPES).map(([key, type]) => ({
    id: key,
    name: type.name,
    keywords: type.keywords,
    commonIssues: type.commonIssues,
    positiveAspects: type.positiveAspects
  }));

  res.json({
    businessTypes
  });
});

// Validări pentru business profile
const businessProfileValidation = [
  body('businessType')
    .isIn(Object.keys(BUSINESS_TYPES))
    .withMessage('Tipul de business nu este valid'),
  body('businessName')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Numele businessului trebuie să aibă între 2 și 100 caractere'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Descrierea nu poate depăși 500 caractere'),
  body('brandVoice')
    .optional()
    .isIn(['formal', 'casual', 'friendly', 'professional', 'luxury'])
    .withMessage('Vocea brandului nu este validă'),
  body('responseLength')
    .optional()
    .isIn(['short', 'medium', 'long'])
    .withMessage('Lungimea răspunsului nu este validă'),
  body('specialInstructions')
    .optional()
    .trim()
    .isLength({ max: 1000 })
    .withMessage('Instrucțiunile speciale nu pot depăși 1000 caractere')
];

// Crearea/actualizarea profilului de business
router.post('/profile', 
  authenticateToken,
  businessProfileValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Date invalide',
          details: errors.array()
        });
      }

      const {
        businessType,
        businessName,
        description,
        brandVoice = 'professional',
        responseLength = 'medium',
        specialInstructions,
        customKeywords = []
      } = req.body;

      const userId = req.user.id;

      // Verifică dacă utilizatorul are deja un profil
      const existingProfile = await prisma.businessProfile.findUnique({
        where: { userId }
      });

      const profileData = {
        businessType,
        businessName,
        description,
        brandVoice,
        responseLength,
        specialInstructions,
        customKeywords: JSON.stringify(customKeywords)
      };

      let profile;
      if (existingProfile) {
        profile = await prisma.businessProfile.update({
          where: { userId },
          data: profileData
        });
      } else {
        profile = await prisma.businessProfile.create({
          data: {
            ...profileData,
            userId
          }
        });
      }

      res.json({
        message: 'Profilul de business a fost salvat cu succes',
        profile: {
          ...profile,
          customKeywords: JSON.parse(profile.customKeywords || '[]'),
          businessTypeInfo: BUSINESS_TYPES[profile.businessType]
        }
      });

    } catch (error) {
      console.error('Business profile error:', error);
      res.status(500).json({
        error: 'Eroare la salvarea profilului de business'
      });
    }
  }
);

// Obținerea profilului curent
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const profile = await prisma.businessProfile.findUnique({
      where: { userId: req.user.id }
    });

    if (!profile) {
      return res.json({
        profile: null,
        message: 'Nu ai încă un profil de business configurat'
      });
    }

    res.json({
      profile: {
        ...profile,
        customKeywords: JSON.parse(profile.customKeywords || '[]'),
        businessTypeInfo: BUSINESS_TYPES[profile.businessType]
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      error: 'Eroare la obținerea profilului'
    });
  }
});

// Template-uri predefinite
const DEFAULT_TEMPLATES = {
  positive_grateful: {
    name: 'Pozitiv - Recunoscător',
    category: 'positive',
    template: `Vă mulțumim din suflet pentru feedback-ul pozitiv și pentru că ați ales {businessName}! Suntem foarte bucuroși să aflăm că {specificMention}. Echipa noastră se străduiește mereu să ofere {positiveAspect} și să creeze experiențe memorabile. Vă așteptăm cu drag să ne vizitați din nou!`
  },
  positive_professional: {
    name: 'Pozitiv - Profesional',
    category: 'positive',
    template: `Mulțumim pentru review-ul pozitiv! Feedback-ul dumneavoastră confirmă angajamentul nostru pentru {positiveAspect}. Suntem mândri că {specificMention} și continuăm să îmbunătățim serviciile pentru clienții noștri fideli. Vă mulțumim că ați ales {businessName}!`
  },
  negative_apologetic: {
    name: 'Negativ - Scuze Sincere',
    category: 'negative',
    template: `Îmi pare foarte rău pentru experiența neplăcută pe care ați avut-o la {businessName}. Înțeleg frustrarea dumneavoastră legată de {specificIssue} și vreau să știți că luăm acest feedback foarte în serios. {actionPlan} Vă rugăm să ne contactați direct la {contactMethod} pentru a rezolva această situație. Mulțumim pentru răbdare și pentru că ne-ați oferit șansa să ne îmbunătățim.`
  },
  negative_solution_focused: {
    name: 'Negativ - Soluții Concrete',
    category: 'negative',
    template: `Vă mulțumim pentru feedback și ne pare rău că nu am reușit să vă oferim experiența așteptată. Pentru {specificIssue}, am luat deja următoarele măsuri: {solutionSteps}. Vă invit să ne dați o nouă șansă și să experimentați îmbunătățirile pe care le-am implementat. Contactați-ne la {contactMethod} pentru mai multe detalii.`
  },
  neutral_engaging: {
    name: 'Neutru - Angajant',
    category: 'neutral',
    template: `Mulțumim pentru timpul acordat să ne evaluați serviciile! Feedback-ul dumneavoastră ne ajută să înțelegem mai bine experiența clienților noștri. {specificResponse} Suntem mereu deschiși la sugestii pentru îmbunătățire și vă încurajăm să ne contactați direct la {contactMethod} cu orice întrebări sau recomandări.`
  }
};

// Validări pentru template
const templateValidation = [
  body('name')
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Numele template-ului trebuie să aibă între 3 și 100 caractere'),
  body('category')
    .isIn(['positive', 'negative', 'neutral', 'custom'])
    .withMessage('Categoria nu este validă'),
  body('template')
    .trim()
    .isLength({ min: 20, max: 1000 })
    .withMessage('Template-ul trebuie să aibă între 20 și 1000 caractere'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Descrierea nu poate depăși 200 caractere')
];

// Obținerea template-urilor (predefinite + custom)
router.get('/templates', authenticateToken, async (req, res) => {
  try {
    const category = req.query.category;
    
    // Template-uri predefinite
    let defaultTemplates = Object.entries(DEFAULT_TEMPLATES).map(([key, template]) => ({
      id: key,
      ...template,
      isDefault: true
    }));

    // Filtrează după categorie dacă este specificată
    if (category && category !== 'all') {
      defaultTemplates = defaultTemplates.filter(t => t.category === category);
    }

    // Template-uri custom ale utilizatorului
    let customTemplates = await prisma.responseTemplate.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });

    if (category && category !== 'all') {
      customTemplates = customTemplates.filter(t => t.category === category);
    }

    res.json({
      templates: {
        default: defaultTemplates,
        custom: customTemplates.map(t => ({
          ...t,
          isDefault: false
        }))
      }
    });

  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({
      error: 'Eroare la obținerea template-urilor'
    });
  }
});

// Crearea unui template custom
router.post('/templates',
  authenticateToken,
  templateValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Date invalide',
          details: errors.array()
        });
      }

      const { name, category, template, description } = req.body;

      const newTemplate = await prisma.responseTemplate.create({
        data: {
          userId: req.user.id,
          name,
          category,
          template,
          description
        }
      });

      res.status(201).json({
        message: 'Template creat cu succes',
        template: newTemplate
      });

    } catch (error) {
      console.error('Create template error:', error);
      res.status(500).json({
        error: 'Eroare la crearea template-ului'
      });
    }
  }
);

// Actualizarea unui template custom
router.put('/templates/:id',
  authenticateToken,
  templateValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: 'Date invalide',
          details: errors.array()
        });
      }

      const { id } = req.params;
      const { name, category, template, description } = req.body;

      // Verifică că template-ul aparține utilizatorului
      const existingTemplate = await prisma.responseTemplate.findFirst({
        where: {
          id: id,
          userId: req.user.id
        }
      });

      if (!existingTemplate) {
        return res.status(404).json({
          error: 'Template-ul nu a fost găsit sau nu aveți permisiunea să îl modificați'
        });
      }

      const updatedTemplate = await prisma.responseTemplate.update({
        where: { id },
        data: {
          name,
          category,
          template,
          description
        }
      });

      res.json({
        message: 'Template actualizat cu succes',
        template: updatedTemplate
      });

    } catch (error) {
      console.error('Update template error:', error);
      res.status(500).json({
        error: 'Eroare la actualizarea template-ului'
      });
    }
  }
);

// Ștergerea unui template custom
router.delete('/templates/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verifică că template-ul aparține utilizatorului
    const existingTemplate = await prisma.responseTemplate.findFirst({
      where: {
        id: id,
        userId: req.user.id
      }
    });

    if (!existingTemplate) {
      return res.status(404).json({
        error: 'Template-ul nu a fost găsit sau nu aveți permisiunea să îl ștergeți'
      });
    }

    await prisma.responseTemplate.delete({
      where: { id }
    });

    res.json({
      message: 'Template șters cu succes'
    });

  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({
      error: 'Eroare la ștergerea template-ului'
    });
  }
});

module.exports = router;