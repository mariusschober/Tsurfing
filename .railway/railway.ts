import { defineRailway, github, project, service } from 'railway/iac';

/**
 * Apply this definition separately to the persistent `staging` and
 * `production` environments. Environment secrets live as Railway shared
 * variables and are referenced here without entering source control.
 */
export default defineRailway(ctx => {
  const branch = ctx.isEnvironment('production') ? 'main' : 'develop';
  const source = github('mariusschober/Tsurfing', { branch, checkSuites: true });
  const commonServerEnvironment = {
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    APP_ORIGIN: ctx.shared.APP_ORIGIN,
    CORS_ORIGINS: ctx.shared.APP_ORIGIN,
    OWNER_USER_ID: ctx.shared.OWNER_USER_ID,
    SUPABASE_URL: ctx.shared.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: ctx.shared.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: ctx.shared.SUPABASE_SECRET_KEY,
    ENABLE_LOCAL_DEMO: 'false',
    TELEGRAM_ENABLED: 'false',
    AI_ENABLED: 'false',
    VOICE_ENABLED: 'false',
    TURNSTILE_ENABLED: 'false'
  } as const;

  const web = service('tsurfing-web-api', {
    source,
    build: {
      builder: 'RAILPACK',
      buildEnvironment: 'V3',
      // Railway watch paths use gitignore syntax; `**` is the documented
      // match-all rule. A leading slash caused valid source changes to skip.
      watchPatterns: ['**'],
      // Railpack installs the locked dependencies before invoking this step.
      // Running npm ci again races its mounted node_modules cache on Railway.
      buildCommand: 'npm run build'
    },
    start: 'npm start',
    healthcheck: '/api/v1/health/ready',
    healthcheckTimeout: 120,
    replicas: 1,
    env: {
      ...commonServerEnvironment,
      // Keep the application listener and the custom-domain target aligned.
      // Railway otherwise injects 8080 while staging.tsurfing.com is pinned
      // to port 3000.
      PORT: '3000',
      BACKUPS_ENABLED: 'false',
      VITE_SUPABASE_URL: ctx.shared.SUPABASE_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: ctx.shared.SUPABASE_PUBLISHABLE_KEY,
      VITE_API_ORIGIN: ctx.shared.APP_ORIGIN,
      VITE_ENABLE_LOCAL_DEMO: 'false'
    },
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      overlapSeconds: 20,
      drainingSeconds: 20
    }
  });

  const maintenance = service('tsurfing-maintenance', {
    source,
    build: {
      builder: 'RAILPACK',
      buildEnvironment: 'V3',
      watchPatterns: ['/server/**', '/scripts/**', '/package.json', '/package-lock.json'],
      buildCommand: 'npm run build:server'
    },
    start: 'npm run maintenance',
    env: {
      ...commonServerEnvironment,
      BACKUPS_ENABLED: 'true',
      BACKUP_MASTER_KEY: ctx.shared.BACKUP_MASTER_KEY
    },
    deploy: {
      cronSchedule: '0 2 * * *',
      restartPolicyType: 'NEVER',
      restartPolicyMaxRetries: 0
    }
  });

  return project('tsurfing', {
    environments: ['staging', 'production'],
    resources: [web, maintenance]
  });
});
