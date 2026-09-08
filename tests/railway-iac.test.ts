import { describe, expect, it } from 'vitest';
import {
  createRailwayContext,
  project,
  type ProjectDefinition,
  type ServiceNode
} from 'railway/iac';
import railwayProgram from '../.railway/railway';

const render = async (environment: 'staging' | 'production'): Promise<ProjectDefinition> =>
  railwayProgram(createRailwayContext({ environment }), project);

const services = (definition: ProjectDefinition): ServiceNode[] =>
  (definition.resources ?? []).flat() as ServiceNode[];

const named = (definition: ProjectDefinition, name: string): ServiceNode => {
  const resource = services(definition).find(candidate => candidate.name === name);
  if (!resource) throw new Error(`Missing Railway service: ${name}`);
  return resource;
};

describe('Railway beta infrastructure contract', () => {
  it.each([
    ['staging', 'develop'],
    ['production', 'main']
  ] as const)('maps %s to its exact persistent branch', async (environment, branch) => {
    const definition = await render(environment);
    expect(definition.name).toBe('tsurfing');
    expect(definition.environments).toEqual(['staging', 'production']);

    for (const resource of services(definition)) {
      expect(resource.kind).toBe('github');
      expect(resource.source).toMatchObject({
        type: 'github',
        repo: 'mariusschober/Tsurfing',
        branch,
        checkSuites: true
      });
    }
  });

  it('defines one readiness-gated web service and one repository-backed cron service', async () => {
    const definition = await render('staging');
    const web = named(definition, 'tsurfing-web-api');
    const maintenance = named(definition, 'tsurfing-maintenance');

    expect(services(definition).map(resource => resource.name).sort()).toEqual([
      'tsurfing-maintenance',
      'tsurfing-web-api'
    ]);
    expect(web.deploy).toMatchObject({
      startCommand: 'npm start',
      healthcheckPath: '/api/v1/health/ready',
      restartPolicyType: 'ON_FAILURE',
      numReplicas: 1
    });
    expect(web.build).toMatchObject({ buildCommand: 'npm run build', watchPatterns: ['**'] });
    expect(web.build?.buildCommand).not.toContain('npm ci');
    expect(web.variables?.PORT).toMatchObject({ type: 'literal', value: '3000' });
    expect(maintenance.kind).toBe('github');
    expect(maintenance.build).toMatchObject({
      buildCommand: 'npm run build:server',
      watchPatterns: ['/server/**', '/scripts/**', '/package.json', '/package-lock.json']
    });
    expect(maintenance.build?.buildCommand).not.toContain('npm ci');
    expect(maintenance.deploy).toMatchObject({
      startCommand: 'npm run maintenance',
      cronSchedule: '0 2 * * *',
      restartPolicyType: 'NEVER',
      restartPolicyMaxRetries: 0
    });
  });

  it('keeps server credentials out of every client-prefixed variable', async () => {
    const definition = await render('production');
    const web = named(definition, 'tsurfing-web-api');
    const maintenance = named(definition, 'tsurfing-maintenance');
    const webVariables = web.variables ?? {};
    const maintenanceVariables = maintenance.variables ?? {};

    expect(webVariables.BACKUPS_ENABLED).toMatchObject({ type: 'literal', value: 'false' });
    expect(maintenanceVariables.BACKUPS_ENABLED).toMatchObject({ type: 'literal', value: 'true' });
    expect(webVariables.BACKUP_MASTER_KEY).toBeUndefined();
    expect(maintenanceVariables.BACKUP_MASTER_KEY).toMatchObject({
      type: 'sharedReference',
      name: 'BACKUP_MASTER_KEY'
    });

    for (const resource of services(definition)) {
      const variables = resource.variables ?? {};
      for (const name of Object.keys(variables).filter(candidate => candidate.startsWith('VITE_'))) {
        expect(name).not.toMatch(/SECRET|SERVICE_ROLE|MASTER_KEY|BOT_TOKEN|WEBHOOK_SECRET/);
      }
      expect(variables.ENABLE_LOCAL_DEMO).toMatchObject({ type: 'literal', value: 'false' });
      expect(variables.TELEGRAM_ENABLED).toMatchObject({ type: 'literal', value: 'false' });
      expect(variables.AI_ENABLED).toMatchObject({ type: 'literal', value: 'false' });
      expect(variables.VOICE_ENABLED).toMatchObject({ type: 'literal', value: 'false' });
    }
  });
});
