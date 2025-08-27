// scripts/create-admin.js - Create admin user
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function createAdminUser() {
  try {
    const adminEmail = 'alex.mantello13@gmail.com';
    const adminPassword = 'ZZ_Admin!2025$'; // Strong password
    const adminName = 'Alex Mantello';

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: adminEmail }
    });

    if (existingUser) {
      console.log('Admin user already exists!');
      console.log('Email:', existingUser.email);
      console.log('ID:', existingUser.id);
      return;
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(adminPassword, 12);

    // Create admin user
    const adminUser = await prisma.user.create({
      data: {
        email: adminEmail,
        password: hashedPassword,
        name: adminName,
        businessName: 'ZedZen Admin',
        subscriptionPlan: 'enterprise',
        subscriptionStatus: 'active',
        subscriptionExpiresAt: new Date('2030-12-31'), // Far future date
        // Note: Add isAdmin field to schema if you want explicit admin flag
      }
    });

    // Create usage record for current month
    const now = new Date();
    await prisma.usage.create({
      data: {
        userId: adminUser.id,
        month: now.getMonth(),
        year: now.getFullYear(),
        requestCount: 0
      }
    });

    // Create business profile
    await prisma.businessProfile.create({
      data: {
        userId: adminUser.id,
        businessType: 'technology',
        businessName: 'ZedZen Platform',
        description: 'AI-powered review response platform',
        brandVoice: 'professional',
        responseLength: 'medium',
        specialInstructions: 'Always maintain professional tone and represent ZedZen brand values',
        customKeywords: JSON.stringify(['AI', 'automation', 'customer service', 'reviews'])
      }
    });

    console.log('✅ Admin user created successfully!');
    console.log('Email:', adminEmail);
    console.log('Password:', adminPassword);
    console.log('Name:', adminName);
    console.log('Plan: Enterprise (unlimited)');
    console.log('User ID:', adminUser.id);
    console.log('\n⚠️ IMPORTANT: Save these credentials securely!');

  } catch (error) {
    console.error('❌ Error creating admin user:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  createAdminUser();
}

module.exports = createAdminUser;